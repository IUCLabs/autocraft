// The jobs table: requests from the dashboard, the CLI and the autopilot,
// state written by the runner. Shared by the API, the runner and the CLI.
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Job, JobDetail, JobFilter, JobList, JobParams, JobState, JobUsage } from "../../web/src/api/types.ts";
import { trackedNames } from "../repos.ts";
import { accountLabelsByJob } from "../agents/runs.ts";
import { knownStep, loadSteps, modelsOf, ParamError, validateParams, type StepDef } from "./steps.ts";

export const JOB_STATES: JobState[] = ["queued", "running", "done", "failed", "cancelled"];
/** Error text of jobs ended by a runner stop or restart; the autopilot does not count them as failures. */
export const RUNNER_STOPPED = "The runner stopped while this job ran; start it again if needed.";
export const now = (): string => new Date().toISOString();

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type JobRow = {
  id: number; step: string; params: string; requested_by: string; requested_at: string; state: JobState;
  started_at: string | null; ended_at: string | null; progress: string | null; summary: string | null; error: string | null;
  usage: string | null; log_path: string | null; pid: number | null; cancel_requested_at: string | null; cancel_requested_by: string | null;
  items: number | null;
};

function parseJson<T>(s: string | null, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** `accounts`: labels of the accounts the job's agent runs used (see `toJobs` for a page of jobs). */
export function toJob(r: JobRow, accounts: string[] = []): Job {
  const params = parseJson<JobParams>(r.params, {});
  return {
    id: r.id, step: r.step, params, requestedBy: r.requested_by, requestedAt: r.requested_at,
    state: r.state, startedAt: r.started_at, endedAt: r.ended_at, progress: r.progress, summary: r.summary, error: r.error,
    cancelRequested: r.cancel_requested_at !== null, usage: parseJson<JobUsage | null>(r.usage, null),
    models: modelsOf(knownStep(r.step), params), accounts,
  };
}

/** Jobs with their account labels, looked up in one query. */
export function toJobs(db: DatabaseSync, rows: JobRow[]): Job[] {
  const labels = accountLabelsByJob(db, rows.map((r) => r.id));
  return rows.map((r) => toJob(r, labels.get(r.id)));
}

export function jobRow(db: DatabaseSync, id: number): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function getJob(db: DatabaseSync, id: number): Job {
  const r = jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  return toJobs(db, [r])[0]!;
}

export function listJobs(db: DatabaseSync, f: JobFilter = {}): JobList {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.step) {
    where.push("step = ?");
    args.push(f.step);
  }
  if (f.state) {
    where.push("state = ?");
    args.push(f.state);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM jobs ${w}`).get(...args) as { n: number }).n;
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200), offset = Math.max(f.offset ?? 0, 0);
  const rows = db.prepare(`SELECT * FROM jobs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as JobRow[];
  return { jobs: toJobs(db, rows), total };
}

async function stepOf(name: unknown): Promise<StepDef> {
  const step = typeof name === "string" ? (await loadSteps()).get(name) : undefined;
  if (!step) throw new JobError(400, "no such step");
  return step;
}

/** Validated params for a step, or a 400. */
export async function checkRequest(db: DatabaseSync, stepName: unknown, rawParams: unknown): Promise<{ step: StepDef; params: JobParams }> {
  const step = await stepOf(stepName);
  let params: JobParams;
  try {
    params = validateParams(step, rawParams, trackedNames(db));
  } catch (e) {
    if (e instanceof ParamError) throw new JobError(400, e.message);
    throw e;
  }
  const why = step.available?.() ?? null;
  if (why) throw new JobError(409, why);
  const refused = step.check ? await step.check(db, params) : null;
  if (refused) throw new JobError(409, refused);
  return { step, params };
}

/** Queues a job. The same step with the same params already waiting is refused. */
export async function enqueue(db: DatabaseSync, stepName: unknown, rawParams: unknown, by: string): Promise<Job> {
  const { step, params } = await checkRequest(db, stepName, rawParams);
  const json = JSON.stringify(params);
  if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND params = ? AND state = 'queued'").get(step.name, json)) {
    throw new JobError(409, `${step.name} with these settings is already queued`);
  }
  const repo = typeof params.repo === "string" ? params.repo : null;
  const id = Number(db.prepare("INSERT INTO jobs (step, params, repo, requested_by, requested_at, state) VALUES (?, ?, ?, ?, ?, 'queued')")
    .run(step.name, json, repo, by, now()).lastInsertRowid);
  return getJob(db, id);
}

/** A queued job is cancelled at once; a running one is marked and the runner stops it. */
export function requestCancel(db: DatabaseSync, id: number, by: string): Job {
  const r = jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  const t = now();
  if (r.state === "queued") {
    const done = db.prepare("UPDATE jobs SET state = 'cancelled', ended_at = ?, cancel_requested_at = ?, cancel_requested_by = ? WHERE id = ? AND state = 'queued'")
      .run(t, t, by, id).changes;
    if (done) return getJob(db, id);
  }
  const marked = db.prepare("UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_requested_by = COALESCE(cancel_requested_by, ?) WHERE id = ? AND state = 'running'")
    .run(t, by, id).changes;
  if (!marked) throw new JobError(409, `job ${id} has already ended`);
  return getJob(db, id);
}

/** Finished jobs and their log files are kept this long; audit and token_usage are kept for good. */
export const JOB_KEEP_MS = 90 * 24 * 3600_000;

/** Deletes finished jobs that ended more than JOB_KEEP_MS ago, with their log files. Returns the number of jobs. */
export function pruneJobs(db: DatabaseSync, nowMs: number = Date.now()): number {
  const before = new Date(nowMs - JOB_KEEP_MS).toISOString();
  const old = db.prepare("SELECT id, log_path FROM jobs WHERE ended_at IS NOT NULL AND ended_at < ? AND state IN ('done', 'failed', 'cancelled') ORDER BY ended_at LIMIT 1000");
  const del = db.prepare("DELETE FROM jobs WHERE id = ?");
  let n = 0;
  for (;;) {
    const rows = old.all(before) as { id: number; log_path: string | null }[];
    if (!rows.length) return n;
    for (const r of rows) {
      if (r.log_path) {
        try {
          unlinkSync(r.log_path);
        } catch {
          // already gone
        }
      }
      del.run(r.id);
      n++;
    }
  }
}

// ---- logs ----------------------------------------------------------------------

export { scrub } from "./scrub.ts";
import { scrub } from "./scrub.ts";

export const LOG_TAIL_BYTES = 48 * 1024;

export function logTail(path: string | null, bytes = LOG_TAIL_BYTES): { log: string; logTruncated: boolean } {
  if (!path) return { log: "", logTruncated: false };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { log: "", logTruncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { log: scrub(text), logTruncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

export function jobDetail(db: DatabaseSync, id: number): JobDetail {
  const r = jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  return { ...toJobs(db, [r])[0]!, ...logTail(r.log_path) };
}
