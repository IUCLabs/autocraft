// Build tasks: created by pipeline steps, claimed by workers that pull, run
// on the worker, and reported back. Everything a worker sends is stored as
// data; nothing here executes it, renders it or puts it in a prompt.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { BuildSummary, BuildTask, BuildTaskDetail, Capabilities, Requires, TaskArtifact, TaskFilter, TaskPage, TaskResult, TaskState, TaskStep } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { excludeHidden } from "../dash/api/visible.ts";
import { removeArtifacts } from "./artifacts.ts";
import { BuildError, slotsOf } from "./envs.ts";

export const LOST_AFTER_MS = 2 * 60_000;
/** A task is claimed at most this often: the first time and one requeue after a lost worker. */
export const MAX_ATTEMPTS = 2;
export const MAX_QUEUED = 500;
export const KEEP_MS = 30 * 24 * 3600_000;
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;
export const TERMINAL: TaskState[] = ["done", "failed", "cancelled", "lost"];
const SOURCE_ORG = "storytold";

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const STEP_NAME_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;
const GLOB_RE = /^[A-Za-z0-9._*?/{},-]{1,200}$/;
const nowIso = (): string => new Date().toISOString();

type TaskRow = {
  id: number; job_id: number | null; step: string; repo: string; number: number | null; head_sha: string; base_sha: string | null;
  requires: string; priority: number; plan: string; state: TaskState; env_id: string | null; attempts: number;
  queued_at: string; claimed_at: string | null; started_at: string | null; ended_at: string | null; heartbeat_at: string | null;
  cancel_requested_at: string | null; results: string; summary: string | null; log_bytes: number; artifact_bytes: number;
  env_label?: string | null;
};

const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export type NewTask = {
  jobId?: number | null; step: string; repo: string; number?: number | null; headSha: string; baseSha?: string | null;
  requires?: Requires; priority?: number; plan: TaskStep[];
};

export function parseRequires(v: unknown): Requires {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "requires must be an object");
  const o = v as Record<string, unknown>;
  const out: Requires = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === "os" && ["linux", "macos", "windows"].includes(x as string)) out.os = x as Capabilities["os"];
    else if (k === "arch" && ["x86_64", "aarch64"].includes(x as string)) out.arch = x as Capabilities["arch"];
    else if ((k === "display" || k === "gpu") && typeof x === "boolean") out[k] = x;
    else if ((k === "minMemGb" || k === "minDiskGb") && typeof x === "number" && x >= 0 && x <= 1e7) out[k] = x;
    else if (k === "toolchains" && Array.isArray(x) && x.length <= 40 && x.every((t) => typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(t))) out.toolchains = x as string[];
    else throw new BuildError(400, `requires.${k} is not valid`);
  }
  return out;
}

export function parsePlan(v: unknown): TaskStep[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw new BuildError(400, "plan must list 1 to 20 steps");
  return v.map((s, i): TaskStep => {
    const o = s as Record<string, unknown> | null;
    const where = `plan[${i}]`;
    if (!o || typeof o !== "object") throw new BuildError(400, `${where} must be an object`);
    if (typeof o.name !== "string" || !STEP_NAME_RE.test(o.name)) throw new BuildError(400, `${where}.name is not valid`);
    if (!Array.isArray(o.cmd) || o.cmd.length < 1 || o.cmd.length > 64 || o.cmd.some((a) => typeof a !== "string" || a.length > 8192 || a.includes("\0"))) throw new BuildError(400, `${where}.cmd must be 1 to 64 strings`);
    if (o.network !== "fetch" && o.network !== "none") throw new BuildError(400, `${where}.network must be fetch or none`);
    if (typeof o.timeoutSec !== "number" || !Number.isInteger(o.timeoutSec) || o.timeoutSec < 1 || o.timeoutSec > 7200) throw new BuildError(400, `${where}.timeoutSec must be 1 to 7200`);
    const step: TaskStep = { name: o.name, cmd: o.cmd as string[], network: o.network, timeoutSec: o.timeoutSec };
    if (o.artifacts !== undefined) {
      if (!Array.isArray(o.artifacts) || o.artifacts.length > 20 || o.artifacts.some((g) => typeof g !== "string" || !GLOB_RE.test(g) || g.startsWith("/") || g.split("/").includes(".."))) throw new BuildError(400, `${where}.artifacts must be up to 20 relative globs`);
      step.artifacts = o.artifacts as string[];
    }
    return step;
  });
}

/** Queues a task. Used by pipeline steps and the CLI; the source is fetched by sha, so it must be a full commit id. */
export function createTask(db: DatabaseSync, t: NewTask): number {
  if (typeof t.step !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(t.step)) throw new BuildError(400, "step is not valid");
  if (typeof t.repo !== "string" || !REPO_RE.test(t.repo)) throw new BuildError(400, "repo is not valid");
  if (!SHA_RE.test(t.headSha)) throw new BuildError(400, "headSha must be a full lowercase commit id");
  if (t.baseSha != null && !SHA_RE.test(t.baseSha)) throw new BuildError(400, "baseSha must be a full lowercase commit id");
  if (t.number != null && (!Number.isInteger(t.number) || t.number < 1)) throw new BuildError(400, "number is not valid");
  const priority = t.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BuildError(400, "priority must be -100 to 100");
  const requires = parseRequires(t.requires);
  const plan = parsePlan(t.plan);
  const queued = (db.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE state = 'queued'").get() as { n: number }).n;
  if (queued >= MAX_QUEUED) throw new BuildError(429, `${MAX_QUEUED} tasks are already queued`);
  const r = db.prepare(`INSERT INTO build_tasks (job_id, step, repo, number, head_sha, base_sha, requires, priority, plan, state, queued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
    .run(t.jobId ?? null, t.step, t.repo, t.number ?? null, t.headSha, t.baseSha ?? null, JSON.stringify(requires), priority, JSON.stringify(plan), nowIso());
  return Number(r.lastInsertRowid);
}

/** Whether an environment with these capabilities can run a task with these requirements. */
export function satisfies(caps: Capabilities, req: Requires): boolean {
  if (req.os && caps.os !== req.os) return false;
  if (req.arch && caps.arch !== req.arch) return false;
  if (req.display && !caps.display) return false;
  if (req.gpu && !caps.gpu) return false;
  if (req.toolchains && !req.toolchains.every((t) => caps.toolchains.includes(t))) return false;
  if (req.minMemGb !== undefined && caps.memGb < req.minMemGb) return false;
  if (req.minDiskGb !== undefined && caps.diskGb < req.minDiskGb) return false;
  return true;
}

export type ClaimedTask = { id: number; repo: string; headSha: string; baseSha: string | null; plan: TaskStep[]; sourceUrl: string };
export type ClaimResult = { tasks: ClaimedTask[]; cancel: number[] };

/** Ids of this environment's active tasks that an operator asked to cancel. */
export function cancelIds(db: DatabaseSync, envId: string): number[] {
  return (db.prepare("SELECT id FROM build_tasks WHERE env_id = ? AND state IN ('claimed', 'running') AND cancel_requested_at IS NOT NULL ORDER BY id").all(envId) as { id: number }[]).map((r) => r.id);
}

/**
 * Hands out queued tasks to an environment that has `free` slots: the oldest of the highest priority
 * whose requirements it meets, at most min(free, its slots minus the tasks it is running). A disabled,
 * paused or unreported environment gets none. One write transaction, so two environments never get the same task.
 */
export function claim(db: DatabaseSync, envId: string, free: number, nowMs: number = Date.now()): ClaimResult {
  reapLost(db, nowMs);
  db.exec("BEGIN IMMEDIATE");
  try {
    const env = db.prepare("SELECT * FROM build_envs WHERE id = ?").get(envId) as
      { enabled: number; slots: number; reported_slots: number | null; capabilities: string | null; paused_reason: string | null } | undefined;
    const caps = env?.capabilities ? json<Capabilities | null>(env.capabilities, null) : null;
    const out: ClaimedTask[] = [];
    if (env && env.enabled === 1 && caps && !env.paused_reason && Number.isInteger(free) && free > 0) {
      const running = (db.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE env_id = ? AND state IN ('claimed', 'running')").get(envId) as { n: number }).n;
      const room = Math.min(free, slotsOf(env) - running);
      if (room > 0) {
        const queued = db.prepare("SELECT * FROM build_tasks WHERE state = 'queued' ORDER BY priority DESC, id LIMIT 500").all() as TaskRow[];
        const at = new Date(nowMs).toISOString();
        const take = db.prepare("UPDATE build_tasks SET state = 'claimed', env_id = ?, attempts = attempts + 1, claimed_at = ?, heartbeat_at = ? WHERE id = ? AND state = 'queued'");
        for (const t of queued) {
          if (out.length >= room) break;
          if (!satisfies(caps, json<Requires>(t.requires, {}))) continue;
          take.run(envId, at, at, t.id);
          out.push({
            id: t.id, repo: t.repo, headSha: t.head_sha, baseSha: t.base_sha, plan: json<TaskStep[]>(t.plan, []),
            sourceUrl: `https://codeload.github.com/${SOURCE_ORG}/${t.repo}/tar.gz/${t.head_sha}`,
          });
        }
      }
    }
    db.exec("COMMIT");
    return { tasks: out, cancel: cancelIds(db, envId) };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Tasks without a heartbeat for LOST_AFTER_MS: requeued once, then failed; a cancelled one is just cancelled. Returns how many were handled. */
export function reapLost(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - LOST_AFTER_MS).toISOString();
  const stale = db.prepare("SELECT id, attempts, cancel_requested_at FROM build_tasks WHERE state IN ('claimed', 'running') AND heartbeat_at < ?").all(cutoff) as
    { id: number; attempts: number; cancel_requested_at: string | null }[];
  if (!stale.length) return 0;
  const at = new Date(nowMs).toISOString();
  for (const t of stale) {
    removeArtifacts(db, [t.id]);
    if (!t.cancel_requested_at && t.attempts < MAX_ATTEMPTS) {
      db.prepare("DELETE FROM build_task_logs WHERE task_id = ?").run(t.id);
      db.prepare(`UPDATE build_tasks SET state = 'queued', env_id = NULL, claimed_at = NULL, started_at = NULL, heartbeat_at = NULL, results = '[]',
        log_bytes = 0, summary = NULL WHERE id = ? AND state IN ('claimed', 'running')`).run(t.id);
    } else {
      const state = t.cancel_requested_at ? "cancelled" : "failed";
      db.prepare("UPDATE build_tasks SET state = ?, ended_at = ?, summary = ? WHERE id = ? AND state IN ('claimed', 'running')")
        .run(state, at, t.cancel_requested_at ? "Cancelled; the worker stopped answering." : "The worker stopped answering twice (no heartbeat for 2 minutes).", t.id);
    }
  }
  return stale.length;
}

/** The task row when it is running on this environment, else a 409. */
function mine(db: DatabaseSync, envId: string, id: number): TaskRow {
  const t = db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!t) throw new BuildError(404, "no such task");
  if (t.env_id !== envId || (t.state !== "claimed" && t.state !== "running")) throw new BuildError(409, "this task is not running on this environment");
  return t;
}

export const ownedTask = mine;

export function startTask(db: DatabaseSync, envId: string, id: number): { cancel: number[] } {
  const t = mine(db, envId, id);
  const at = nowIso();
  db.prepare("UPDATE build_tasks SET state = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ? WHERE id = ?").run(at, at, t.id);
  return { cancel: cancelIds(db, envId) };
}

export function heartbeat(db: DatabaseSync, envId: string, id: number): { cancel: number[] } {
  const t = mine(db, envId, id);
  db.prepare("UPDATE build_tasks SET heartbeat_at = ? WHERE id = ?").run(nowIso(), t.id);
  return { cancel: cancelIds(db, envId) };
}

const cleanLine = (s: unknown, max: number): string | null =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) || null : null;

/** Appends a log chunk; past the per-task cap the rest is dropped with a marker. */
export function appendLog(db: DatabaseSync, envId: string, id: number, step: unknown, chunk: unknown): { truncated: boolean } {
  const t = mine(db, envId, id);
  if (typeof chunk !== "string") throw new BuildError(400, "chunk must be text");
  const bytes = Buffer.byteLength(chunk);
  if (bytes > MAX_CHUNK_BYTES) throw new BuildError(413, "a log chunk is at most 64 KB");
  const name = cleanLine(step, 64) ?? "";
  if (t.log_bytes >= MAX_LOG_BYTES) return { truncated: true };
  let text = chunk;
  let truncated = false;
  if (t.log_bytes + bytes > MAX_LOG_BYTES) {
    text = `${Buffer.from(chunk).subarray(0, MAX_LOG_BYTES - t.log_bytes).toString("utf8")}\n[log truncated at 20 MB]\n`;
    truncated = true;
  }
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM build_task_logs WHERE task_id = ?").get(id) as { n: number }).n;
  db.prepare("INSERT INTO build_task_logs (task_id, seq, step, chunk) VALUES (?, ?, ?, ?)").run(id, seq, name, text);
  db.prepare("UPDATE build_tasks SET log_bytes = ?, heartbeat_at = ? WHERE id = ?").run(truncated ? MAX_LOG_BYTES : t.log_bytes + bytes, nowIso(), id);
  return { truncated };
}

export function parseResults(v: unknown): TaskResult[] {
  if (!Array.isArray(v) || v.length > 40) throw new BuildError(400, "results must be a list of at most 40 entries");
  return v.map((r, i) => {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new BuildError(400, `results[${i}] must be an object`);
    const step = cleanLine(o.step, 64);
    const code = o.exitCode;
    const ms = o.durationMs;
    if (!step || (code !== null && (typeof code !== "number" || !Number.isInteger(code))) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || typeof o.timedOut !== "boolean") {
      throw new BuildError(400, `results[${i}] is not valid`);
    }
    return { step, exitCode: code as number | null, durationMs: Math.round(ms), timedOut: o.timedOut };
  });
}

/** The worker's last word: done when every step exited 0, cancelled when an operator asked, else failed. */
export function finishTask(db: DatabaseSync, envId: string, id: number, body: unknown): { state: TaskState } {
  const t = mine(db, envId, id);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BuildError(400, "the body must be a JSON object");
  const o = body as Record<string, unknown>;
  const results = parseResults(o.results);
  const summary = cleanLine(o.summary, 500);
  const ok = results.length > 0 && results.every((r) => r.exitCode === 0 && !r.timedOut);
  const state: TaskState = t.cancel_requested_at ? "cancelled" : ok ? "done" : "failed";
  db.prepare("UPDATE build_tasks SET state = ?, ended_at = ?, results = ?, summary = ? WHERE id = ?").run(state, nowIso(), JSON.stringify(results), summary, id);
  return { state };
}

/** Cancels a queued task at once, or flags an active one for its worker to stop. */
export function cancelTask(db: DatabaseSync, id: unknown, by: string): BuildTask {
  const n = typeof id === "number" ? id : Number(id);
  const t = Number.isInteger(n) ? (db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(n) as TaskRow | undefined) : undefined;
  if (!t) throw new BuildError(404, "no such task");
  if (TERMINAL.includes(t.state)) throw new BuildError(409, `the task is already ${t.state}`);
  const at = nowIso();
  if (t.state === "queued") db.prepare("UPDATE build_tasks SET state = 'cancelled', ended_at = ?, cancel_requested_at = ?, summary = 'Cancelled before it started.' WHERE id = ? AND state = 'queued'").run(at, at, t.id);
  else db.prepare("UPDATE build_tasks SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?").run(at, t.id);
  audit(db, by, "task-cancel", `task:${t.id}`, { repo: t.repo, was: t.state });
  return getTask(db, t.id)!;
}

// ---- reading -----------------------------------------------------------------

const SELECT = "SELECT t.*, e.label AS env_label FROM build_tasks t LEFT JOIN build_envs e ON e.id = t.env_id";

function artifactsOf(db: DatabaseSync, ids: number[]): Map<number, TaskArtifact[]> {
  const out = new Map<number, TaskArtifact[]>();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT task_id, name, bytes, content_type FROM build_artifacts WHERE task_id IN (${ids.map(() => "?").join(",")}) ORDER BY name`).all(...ids) as
    { task_id: number; name: string; bytes: number; content_type: string }[];
  for (const r of rows) (out.get(r.task_id) ?? out.set(r.task_id, []).get(r.task_id)!).push({ name: r.name, bytes: r.bytes, contentType: r.content_type });
  return out;
}

function toTask(r: TaskRow, artifacts: TaskArtifact[]): BuildTask {
  return {
    id: r.id, jobId: r.job_id, step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha,
    requires: json<Requires>(r.requires, {}), priority: r.priority, plan: json<TaskStep[]>(r.plan, []),
    state: r.state, envId: r.env_id, envLabel: r.env_label ?? null, cancelRequested: r.cancel_requested_at !== null,
    queuedAt: r.queued_at, claimedAt: r.claimed_at, startedAt: r.started_at, endedAt: r.ended_at, heartbeatAt: r.heartbeat_at,
    results: json<TaskResult[]>(r.results, []), artifacts, summary: r.summary,
  };
}

export function getTask(db: DatabaseSync, id: number): BuildTask | null {
  const r = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  return r ? toTask(r, artifactsOf(db, [r.id]).get(r.id) ?? []) : null;
}

/** The last bytes of the log, from whole chunks. */
export function logTail(db: DatabaseSync, id: number): { text: string; bytes: number; truncated: boolean } {
  const t = db.prepare("SELECT log_bytes FROM build_tasks WHERE id = ?").get(id) as { log_bytes: number } | undefined;
  const parts: string[] = [];
  let size = 0;
  for (const c of db.prepare("SELECT chunk FROM build_task_logs WHERE task_id = ? ORDER BY seq DESC").iterate(id) as Iterable<{ chunk: string }>) {
    parts.push(c.chunk);
    size += Buffer.byteLength(c.chunk);
    if (size >= LOG_TAIL_BYTES) break;
  }
  const joined = parts.reverse().join("");
  const cut = size > LOG_TAIL_BYTES ? Buffer.from(joined).subarray(-LOG_TAIL_BYTES).toString("utf8") : joined;
  return { text: cut, bytes: t?.log_bytes ?? 0, truncated: (t?.log_bytes ?? 0) > Buffer.byteLength(cut) };
}

export function getTaskDetail(db: DatabaseSync, id: number): BuildTaskDetail | null {
  const t = getTask(db, id);
  if (!t) return null;
  const l = logTail(db, id);
  return { ...t, logTail: l.text, logBytes: l.bytes, logTruncated: l.truncated };
}

const CURSOR_RE = /^[1-9][0-9]{0,15}$/;
const FILTER_STATES = ["queued", "claimed", "running", "done", "failed", "cancelled", "lost", "active"];

/** Newest first, keyset-paged by id. `hidden` repos are left out. */
export function listTasks(db: DatabaseSync, f: TaskFilter, hidden: string[] = []): TaskPage {
  const where: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  const hide = excludeHidden("t.repo", hidden, params);
  if (hide) where.push(hide);
  if (f.state !== undefined) {
    if (!FILTER_STATES.includes(f.state)) throw new BuildError(400, "unknown state");
    if (f.state === "active") where.push("t.state IN ('queued', 'claimed', 'running')");
    else (where.push("t.state = :state"), (params.state = f.state));
  }
  if (f.env) (where.push("t.env_id = :env"), (params.env = f.env));
  if (f.repo) (where.push("t.repo = :repo"), (params.repo = f.repo));
  if (f.cursor !== undefined) {
    if (!CURSOR_RE.test(f.cursor)) throw new BuildError(400, "bad cursor");
    (where.push("t.id < :cursor"), (params.cursor = Number(f.cursor)));
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY t.id DESC LIMIT ${limit + 1}`).all(params) as TaskRow[];
  const page = rows.slice(0, limit);
  const arts = artifactsOf(db, page.map((r) => r.id));
  return { tasks: page.map((r) => toTask(r, arts.get(r.id) ?? [])), next: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

export type { BuildSummary };
/** Queued and running tasks and the slots left, over all enabled environments (the flowchart's Verify node). */
export function summary(db: DatabaseSync, hidden: string[] = []): BuildSummary {
  const params: Record<string, SQLInputValue> = {};
  const hide = excludeHidden("repo", hidden, params);
  const c = db.prepare(`SELECT COALESCE(SUM(state = 'queued'), 0) AS queued, COALESCE(SUM(state IN ('claimed', 'running')), 0) AS running FROM build_tasks WHERE state IN ('queued', 'claimed', 'running')${hide ? ` AND ${hide}` : ""}`).get(params) as { queued: number; running: number };
  const all = db.prepare("SELECT * FROM build_envs WHERE enabled = 1 AND last_seen_at > ?").all(new Date(Date.now() - 60_000).toISOString()) as { slots: number; reported_slots: number | null; id: string }[];
  const used = db.prepare("SELECT env_id AS id, COUNT(*) AS n FROM build_tasks WHERE state IN ('claimed', 'running') GROUP BY env_id").all() as { id: string; n: number }[];
  const byEnv = new Map(used.map((u) => [u.id, u.n]));
  const slots = all.reduce((s, e) => s + slotsOf(e), 0);
  const inUse = all.reduce((s, e) => s + Math.min(byEnv.get(e.id) ?? 0, slotsOf(e)), 0);
  return { queued: c.queued, running: c.running, slots, free: slots - inUse, online: all.length };
}

/** Deletes tasks that ended more than 30 days ago, with their logs and artifacts. Returns the count. */
export function pruneTasks(db: DatabaseSync, nowMs: number = Date.now()): number {
  const before = new Date(nowMs - KEEP_MS).toISOString();
  let n = 0;
  for (;;) {
    const ids = (db.prepare("SELECT id FROM build_tasks WHERE ended_at IS NOT NULL AND ended_at < ? AND state IN ('done', 'failed', 'cancelled', 'lost') ORDER BY ended_at LIMIT 200").all(before) as { id: number }[]).map((r) => r.id);
    if (!ids.length) return n;
    removeArtifacts(db, ids);
    for (const id of ids) {
      db.prepare("DELETE FROM build_task_logs WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM build_tasks WHERE id = ?").run(id);
    }
    n += ids.length;
  }
}
