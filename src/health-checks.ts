// Health checks computed from the database: one list read by the dashboard's warnings menu and by GET /healthz/checks.
// Every check reads rows the runner, the sync and the build workers already write; none starts work or wakes the planner.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { listAccounts } from "./agents/accounts.ts";
import { repoErrors } from "./sync-errors.ts";
import { slugOf } from "./owners.ts";
import { trackedNames } from "./repos.ts";

/** Thresholds, in one place. */
export const THRESHOLDS = {
  /** The runner writes its heartbeat every few seconds. */
  runnerStaleMs: 2 * 60_000,
  /** A build worker polls at least every few seconds while it runs. */
  workerStaleMs: 5 * 60_000,
  /** A queued build task older than this has had time to be claimed. */
  taskQueuedMs: 10 * 60_000,
  /** The sync timer runs every minute. */
  syncStaleMs: 10 * 60_000,
  /** Consecutive failed sync runs that make a failure of the run itself. */
  syncFailStreak: 3,
  /** GitHub API points left in the hour: warn below `warn`, fail below `fail`. */
  rateWarn: 500,
  rateFail: 100,
} as const;

export type CheckState = "ok" | "warn" | "fail";
export type Check = {
  /** Stable name: `runner`, `sync`, `worker:<env id>`, `sync-repo:<repo>`, … */
  id: string;
  state: CheckState;
  /** One plain sentence for operators and maintainers. */
  text: string;
  /** The same for viewers: says that something is wrong, not why. */
  brief: string;
  /** When the check turned bad; null when unknown or ok. */
  since: string | null;
  /** The repo a check is about; viewers who cannot see the repo do not see the check. */
  repo?: string;
  /** Dashboard page that shows the cause. */
  to: string;
};
export type CheckCtx = { db: DatabaseSync; nowMs: number };

const ok = (id: string, to: string): Check => ({ id, state: "ok", text: "", brief: "", since: null, to });
const minutes = (ms: number): string => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const all = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] => db.prepare(sql).all(...args) as T[];

function runnerCheck({ db, nowMs }: CheckCtx): Check[] {
  const hb = (db.prepare("SELECT value FROM settings WHERE key = 'runner_heartbeat'").get() as { value: string } | undefined)?.value ?? null;
  const beat = hb ? Date.parse(hb) : NaN;
  if (!Number.isNaN(beat) && nowMs - beat <= THRESHOLDS.runnerStaleMs) return [ok("runner", "/pipeline")];
  const text = Number.isNaN(beat) ? "The runner has not reported" : `The runner has not reported for ${minutes(nowMs - beat)}`;
  return [{ id: "runner", state: "fail", text, brief: text, since: hb, to: "/pipeline" }];
}

type Env = { id: string; label: string; last_seen_at: string | null; created_at: string };
const enabledEnvs = (db: DatabaseSync): Env[] => all<Env>(db, "SELECT id, label, last_seen_at, created_at FROM build_envs WHERE enabled = 1 ORDER BY id");
const seenRecently = (e: Env, nowMs: number): boolean => e.last_seen_at !== null && nowMs - Date.parse(e.last_seen_at) <= THRESHOLDS.workerStaleMs;

function workerChecks({ db, nowMs }: CheckCtx): Check[] {
  return enabledEnvs(db).map((e) => {
    const id = `worker:${e.id}`;
    if (seenRecently(e, nowMs)) return ok(id, "/envs");
    const text = e.last_seen_at ? `Build worker ${e.label} has not reported for ${minutes(nowMs - Date.parse(e.last_seen_at))}` : `Build worker ${e.label} has never reported`;
    return { id, state: "fail", text, brief: text, since: e.last_seen_at ?? e.created_at, to: "/envs" };
  });
}

function queueCheck({ db, nowMs }: CheckCtx): Check[] {
  const cutoff = new Date(nowMs - THRESHOLDS.taskQueuedMs).toISOString();
  const r = db.prepare("SELECT COUNT(*) AS n, MIN(queued_at) AS oldest FROM build_tasks WHERE state = 'queued' AND queued_at < ?").get(cutoff) as { n: number; oldest: string | null };
  if (!r.n) return [ok("build-queue", "/envs")];
  // Workers that are up but busy leave tasks waiting: that is slow, not broken.
  const anyUp = enabledEnvs(db).some((e) => seenRecently(e, nowMs));
  const text = `${r.n} build task${r.n === 1 ? " has" : "s have"} waited over ${minutes(THRESHOLDS.taskQueuedMs)} for a worker`;
  return [{ id: "build-queue", state: anyUp ? "warn" : "fail", text, brief: text, since: r.oldest, to: "/envs" }];
}

function syncCheck({ db, nowMs }: CheckCtx): Check[] {
  const runs = all<{ started_at: string; ended_at: string | null; error: string | null }>(db, "SELECT started_at, ended_at, error FROM sync_runs ORDER BY started_at DESC LIMIT 20")
    .filter((r) => r.ended_at !== null || r.error !== null);
  const streak = runs.findIndex((r) => r.error === null);
  const failing = streak === -1 ? runs.length : streak;
  if (failing >= THRESHOLDS.syncFailStreak) {
    return [{ id: "sync", state: "fail", text: `Sync is failing: ${clip(runs[0]!.error ?? "", 140)}`, brief: "Sync is failing", since: runs[failing - 1]!.started_at, to: "/pipeline" }];
  }
  const good = runs.find((r) => r.error === null);
  const last = good?.ended_at ? Date.parse(good.ended_at) : NaN;
  if (Number.isNaN(last)) {
    return trackedNames(db).length ? [{ id: "sync", state: "fail", text: "Sync has not succeeded yet", brief: "Sync has not succeeded yet", since: null, to: "/pipeline" }] : [ok("sync", "/pipeline")];
  }
  if (nowMs - last > THRESHOLDS.syncStaleMs) {
    const text = `No successful sync in ${minutes(nowMs - last)}`;
    return [{ id: "sync", state: "fail", text, brief: text, since: good!.ended_at, to: "/pipeline" }];
  }
  return [ok("sync", "/pipeline")];
}

function syncRepoChecks({ db }: CheckCtx): Check[] {
  return repoErrors(db).map((e) => {
    const slug = slugOf(e.repo);
    const why = e.kind === "not-found"
      ? `${slug} no longer resolves on GitHub (${e.movedTo ? `moved to ${e.movedTo}` : "moved, renamed or deleted"})`
      : e.kind === "forbidden" ? `${slug} cannot be read: GitHub denied access`
      : e.kind === "transient" ? `${slug} could not be read: GitHub kept failing`
      : `${slug} failed to sync: ${clip(e.message, 120)}`;
    return { id: `sync-repo:${e.repo}`, state: "warn", text: why, brief: `${slug} is not syncing`, since: e.since, repo: e.repo, to: "/repos" } satisfies Check;
  });
}

function accountsCheck({ db, nowMs }: CheckCtx): Check[] {
  const on = listAccounts(db, nowMs).filter((a) => a.enabled);
  if (on.length && on.every((a) => a.pausedReason || a.auth.loggedIn === false)) {
    const text = on.length === 1 ? "The Claude account is paused" : "All Claude accounts are paused";
    return [{ id: "accounts", state: "fail", text, brief: text, since: null, to: "/accounts" }];
  }
  return [ok("accounts", "/accounts")];
}

function rateCheck({ db, nowMs }: CheckCtx): Check[] {
  const get = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
  const left = Number(get("sync_rate_remaining"));
  const reset = Date.parse(get("sync_rate_reset_at") ?? "");
  // A reading from before the last reset says nothing about the new hour.
  if (get("sync_rate_remaining") === null || Number.isNaN(left) || Number.isNaN(reset) || reset < nowMs || left >= THRESHOLDS.rateWarn) return [ok("github-rate", "/pipeline")];
  const text = `GitHub rate limit is nearly used up: ${left} points left until ${new Date(reset).toISOString().slice(11, 16)} UTC`;
  return [{ id: "github-rate", state: left < THRESHOLDS.rateFail ? "fail" : "warn", text, brief: "GitHub rate limit is nearly used up", since: null, to: "/pipeline" }];
}

/**
 * Every check, in the order the lists show them. Another source of warnings (job deadlines, from `deadlineStops()` in
 * src/runner/autopilot.ts) joins by adding one `(ctx) => Check[]` here that returns a `warn` check per stopped job with id `deadline:<job>`.
 */
const SOURCES: ((ctx: CheckCtx) => Check[])[] = [runnerCheck, workerChecks, queueCheck, syncCheck, syncRepoChecks, accountsCheck, rateCheck];

export function computeChecks(db: DatabaseSync, nowMs: number = Date.now()): Check[] {
  return SOURCES.flatMap((f) => f({ db, nowMs }));
}

/** The answer of GET /healthz/checks: states, times and counts only; no repo, account or error text. */
export type PublicCheck = { id: string; state: CheckState; since: string | null; count?: number };

export function publicChecks(checks: Check[]): { status: CheckState; checks: PublicCheck[] } {
  const out: PublicCheck[] = [];
  const repos = checks.filter((c) => c.repo !== undefined);
  for (const c of checks) if (c.repo === undefined) out.push({ id: c.id, state: c.state, since: c.since });
  // Repo checks collapse into one so no repo name leaves the server.
  out.push({ id: "sync-repos", state: repos.length ? "warn" : "ok", since: repos.map((c) => c.since).filter((s): s is string => !!s).sort()[0] ?? null, count: repos.length });
  const status = out.some((c) => c.state === "fail") ? "fail" : out.some((c) => c.state === "warn") ? "warn" : "ok";
  return { status, checks: out };
}

/** Answers GET/HEAD /healthz/checks: 200 when every check is ok or warn, 503 when one fails; returns false for any other request. No auth: see `publicChecks`. */
export function serveChecks(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, nowMs: number = Date.now()): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || (req.url ?? "").split("?")[0] !== "/healthz/checks") return false;
  let body: ReturnType<typeof publicChecks>;
  try {
    body = publicChecks(computeChecks(db, nowMs));
  } catch {
    body = { status: "fail", checks: [{ id: "database", state: "fail", since: null }] };
  }
  const text = JSON.stringify({ ...body, at: new Date(nowMs).toISOString() });
  res.writeHead(body.status === "fail" ? 503 : 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(req.method === "HEAD" ? undefined : text);
  return true;
}
