// The Pipeline page over JSON. Everyone signed in reads steps, jobs, logs and
// schedules; only operators request or cancel jobs and change schedules. The
// dashboard never runs a step: it writes job rows that the runner picks up.
import type { DatabaseSync } from "node:sqlite";
import type { Job, JobState, PipelineOverview, PipelineStage, PipelineStep, StepParam, SyncRun } from "../../../web/src/api/types.ts";
import { trackedNames } from "../../repos.ts";
import { enqueue, getJob, jobDetail, JobError, JOB_STATES, listJobs, requestCancel, saveSchedule, scheduleOf, schedules, toJob } from "../../runner/jobs.ts";
import { HEARTBEAT_KEY } from "../../runner/runner.ts";
import { loadSteps, type StepDef } from "../../runner/steps.ts";
import { audit } from "../audit.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

// Stages of docs/pipeline.md. A stage with registered steps shows them; the
// mirror also runs on its own timer.
const STAGES: { n: number; name: string; automatic?: boolean }[] = [
  { n: 1, name: "Mirror", automatic: true },
  { n: 2, name: "Classify" },
  { n: 3, name: "Decide" },
  { n: 4, name: "Label" },
  { n: 5, name: "Review" },
  { n: 6, name: "Integrate" },
  { n: 7, name: "Fix issues" },
];

const RUNNER_ALIVE_MS = 30_000;

function requireOperator(req: Req, step?: StepDef): void {
  if (req.user.role !== "operator" || (step && step.requires !== "operator")) throw new HttpError(403, "only operators run, cancel or schedule pipeline steps");
}

const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof JobError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

function wireParams(s: StepDef, repos: string[]): StepParam[] {
  return s.params.map((p): StepParam => {
    const base = { name: p.name, label: p.label, help: p.help, required: !!p.required };
    switch (p.kind) {
      case "enum": return { ...base, kind: "enum", options: p.options, default: p.default };
      case "repo": return { ...base, kind: "repo", options: repos };
      case "int": return { ...base, kind: "int", min: p.min, max: p.max, default: p.default };
      case "run-id": return { ...base, kind: "run-id", default: p.default };
    }
  });
}

const lastJob = (db: DatabaseSync, step: string): Job | null => {
  const r = db.prepare("SELECT * FROM jobs WHERE step = ? ORDER BY id DESC LIMIT 1").get(step);
  return r ? toJob(r as Parameters<typeof toJob>[0]) : null;
};

function stageState(db: DatabaseSync, steps: string[], syncFailed: boolean | null): PipelineStage["state"] {
  if (steps.length) {
    const marks = steps.map(() => "?").join(",");
    const active = db.prepare(`SELECT state FROM jobs WHERE step IN (${marks}) AND state IN ('running', 'queued') ORDER BY state = 'running' DESC LIMIT 1`).get(...steps) as { state: JobState } | undefined;
    if (active) return active.state === "running" ? "running" : "queued";
  }
  if (syncFailed !== null) return syncFailed ? "failed" : "ok";
  if (!steps.length) return "idle";
  const marks = steps.map(() => "?").join(",");
  const last = db.prepare(`SELECT state FROM jobs WHERE step IN (${marks}) AND state IN ('done', 'failed') ORDER BY id DESC LIMIT 1`).get(...steps) as { state: JobState } | undefined;
  return last?.state === "done" ? "ok" : last?.state === "failed" ? "failed" : "idle";
}

export async function overview(db: DatabaseSync): Promise<PipelineOverview> {
  const all = [...(await loadSteps()).values()];
  const repos = trackedNames(db);
  const sched = schedules(db);
  const steps: PipelineStep[] = all.map((s) => ({
    name: s.name, title: s.title, description: s.description, stage: s.stage, requires: s.requires, group: s.group,
    params: wireParams(s, repos), unavailable: s.available?.() ?? null,
    schedule: sched.get(s.name) ?? scheduleOf(db, s.name), lastJob: lastJob(db, s.name),
  }));
  const runs = db.prepare("SELECT started_at AS startedAt, ended_at AS endedAt, mode, items, error FROM sync_runs ORDER BY started_at DESC LIMIT 10").all() as unknown as SyncRun[];
  const lastSync = runs.find((r) => r.endedAt);
  const stages: PipelineStage[] = STAGES.map((st) => {
    const names = steps.filter((s) => s.stage === st.n).map((s) => s.name);
    const mode = st.automatic ? "automatic" : names.length ? "steps" : "planned";
    return {
      n: st.n, name: st.name, mode, steps: names,
      state: mode === "planned" ? "planned" : stageState(db, names, st.automatic && lastSync ? lastSync.error !== null : null),
    };
  });
  const beat = (db.prepare("SELECT value FROM settings WHERE key = ?").get(HEARTBEAT_KEY) as { value: string } | undefined)?.value ?? null;
  const count = (state: string) => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = ?").get(state) as { n: number }).n;
  const high = (db.prepare("SELECT value FROM settings WHERE key = 'org_high_water'").get() as { value: string } | undefined)?.value ?? null;
  return {
    stages, steps,
    runner: { lastSeen: beat, alive: beat !== null && Date.now() - Date.parse(beat) < RUNNER_ALIVE_MS },
    sync: { lastFinishedAt: lastSync?.endedAt ?? high, runs },
    counts: { queued: count("queued"), running: count("running") },
  };
}

const intQuery = (req: Req, name: string): number | undefined => {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`);
  return n;
};

export function jobs(db: DatabaseSync, req: Req) {
  const state = req.query.get("state") || undefined;
  if (state && !JOB_STATES.includes(state as JobState)) throw new HttpError(400, "unknown state");
  return listJobs(db, { step: req.query.get("step") || undefined, state: state as JobState | undefined, limit: intQuery(req, "limit"), offset: intQuery(req, "offset") });
}

const jobId = (req: Req): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "not a job id");
  return id;
};

export const job = (db: DatabaseSync, req: Req) => wrap(() => jobDetail(db, jobId(req)));

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

export async function request(db: DatabaseSync, req: Req): Promise<Job> {
  requireOperator(req);
  const b = body(req);
  const step = typeof b.step === "string" ? (await loadSteps()).get(b.step) : undefined;
  if (!step) throw new HttpError(400, "no such step");
  requireOperator(req, step);
  const j = await wrap(() => enqueue(db, step.name, b.params, req.user.login));
  audit(db, req.user.login, "job-request", `job:${j.id}`, { step: j.step, params: j.params });
  return j;
}

export async function cancel(db: DatabaseSync, req: Req): Promise<Job> {
  requireOperator(req);
  const id = jobId(req);
  const before = await wrap(() => getJob(db, id));
  const step = (await loadSteps()).get(before.step);
  if (step) requireOperator(req, step);
  const j = await wrap(() => requestCancel(db, id, req.user.login));
  audit(db, req.user.login, "job-cancel", `job:${id}`, { step: j.step, state: before.state });
  return j;
}

export async function schedule(db: DatabaseSync, req: Req) {
  requireOperator(req);
  const step = (await loadSteps()).get(req.params.step ?? "");
  if (!step) throw new HttpError(404, "no such step");
  requireOperator(req, step);
  const s = await wrap(() => saveSchedule(db, step.name, req.json, req.user.login));
  audit(db, req.user.login, "schedule-change", `step:${step.name}`, { enabled: s.enabled, trigger: s.trigger, intervalMinutes: s.intervalMinutes, params: s.params });
  return s;
}
