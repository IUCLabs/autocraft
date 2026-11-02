// The pipeline switch and the autopilot behind it. With the switch on, the
// runner looks for work after every sync and at least every 15 minutes, and
// queues one job per stage that has work, no job of its own queued or running,
// and an item limit left for the day. Stages run in pipeline order; a failure in one does
// not stop the others. Turned off, no new jobs are queued and running jobs
// finish.
//
// The planner only reads the database and queues jobs; the runner starts them.
// Each lane's `detect` reuses the candidate code of the stage it feeds.
import type { DatabaseSync } from "node:sqlite";
import type { PipelineState, StageLimit } from "../../web/src/api/types.ts";
import { latestJevRun, selectCandidates as decideCandidates } from "../decide/select.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { pending as embedPending } from "../embed/store.ts";
import { approvalOf } from "../labels/approval.ts";
import { countPlan, planLabels } from "../labels/plan.ts";
import { buildQueue, eligible } from "../merge/queue.ts";
import { trackedNames } from "../repos.ts";
import { selectCandidates as reviewCandidates } from "../review/candidates.ts";
import { audit } from "../dash/audit.ts";
import { currentRun, dueItems, haikuDue } from "./classify.ts";
import { enqueue, JobError, now } from "./jobs.ts";
import { claudePauseReason } from "../agents/accounts.ts";
import { knownStep, loadSteps, modelsOf, usesClaude, type Params } from "./steps.ts";

export const PLAN_EVERY_MS = 15 * 60_000;
/** A stage that handled nothing waits this long before it is tried again. */
export const COOLDOWN_MS = 15 * 60_000;
/** A stage whose last BACKOFF_AFTER autopilot jobs all failed waits this long. */
export const BACKOFF_MS = 60 * 60_000;
export const BACKOFF_AFTER = 3;
/** Checks younger than this count as current for the review that follows. */
export const CHECKS_FRESH_MS = 30 * 60_000;
export const AUTOPILOT_USER = "pipeline";

export const KEY_ENABLED = "pipeline_enabled";
const KEY_BY = "pipeline_changed_by", KEY_AT = "pipeline_changed_at";
const KEY_SYNC_SEEN = "pipeline_sync_seen", KEY_SYNC_AT = "pipeline_sync_at", KEY_PLANNED_AT = "pipeline_planned_at";
const KEY_CURSOR = "pipeline_review_cursor";

const getSetting = (db: DatabaseSync, key: string): string | null =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
};

// ---- lanes ---------------------------------------------------------------------

/** One job the autopilot may queue; `params` leaves out `limit`, which the planner sets. */
export type Candidate = { step: string; params: Params };
/** A pipeline stage in order. `detect` lists the jobs that have work, best first. */
export type Lane = { name: string; detect: (db: DatabaseSync) => Candidate[]; chosen?: (db: DatabaseSync, c: Candidate) => void };

const repoOf = (c: Candidate): string | null => (typeof c.params.repo === "string" ? c.params.repo : null);

function lastJobEnd(db: DatabaseSync, step: string, repo: string | null, requestedBy?: string): { endedAt: string; state: string; items: number | null } | undefined {
  return db.prepare(`SELECT ended_at AS endedAt, state, items FROM jobs WHERE step = ? AND (? IS NULL OR json_extract(params, '$.repo') = ?)
    AND ended_at IS NOT NULL AND (? IS NULL OR requested_by = ?) ORDER BY id DESC LIMIT 1`)
    .get(step, repo, repo, requestedBy ?? null, requestedBy ?? null) as { endedAt: string; state: string; items: number | null } | undefined;
}

/** True when the autopilot already queued `step` (for `repo`) since the planner last saw a new sync. */
function queuedSinceSync(db: DatabaseSync, step: string, repo: string): boolean {
  const since = getSetting(db, KEY_SYNC_AT) ?? "";
  return !!db.prepare("SELECT 1 FROM jobs WHERE step = ? AND requested_by = ? AND json_extract(params, '$.repo') = ? AND requested_at >= ?")
    .get(step, AUTOPILOT_USER, repo, since);
}

/** Tracked repos after `cursor` first, wrapping round. */
export function roundRobin(repos: string[], cursor: string | null): string[] {
  const sorted = [...repos].sort();
  const after = sorted.filter((r) => cursor !== null && r > cursor);
  return [...after, ...sorted.filter((r) => !after.includes(r))];
}

export const LANES: Lane[] = [
  {
    name: "classify",
    detect: (db) => {
      const run = currentRun(db);
      if (!run) return [];
      return dueItems(db, run, "new").due.length || haikuDue(db, run, 1).length ? [{ step: "classify-new", params: {} }] : [];
    },
  },
  {
    name: "embed",
    detect: (db) => (embedPending(db, embedderId(modelName())).length ? [{ step: "embed", params: {} }] : []),
  },
  {
    name: "decide",
    detect: (db) => {
      const run = latestJevRun(db);
      return run && decideCandidates(db, run).length ? [{ step: "decide", params: {} }] : [];
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its review.
    name: "review",
    detect: (db) => {
      const out: Candidate[] = [];
      for (const repo of roundRobin(trackedNames(db), getSetting(db, KEY_CURSOR))) {
        if (!reviewCandidates(db, repo).length) continue;
        const checks = lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        out.push({ step: fresh ? "review-batch" : "checks", params: { repo } });
      }
      return out;
    },
    chosen: (db, c) => {
      if (c.step === "review-batch") setSetting(db, KEY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "labels",
    detect: (db) => {
      const run = currentRun(db);
      if (!run) return [];
      return trackedNames(db)
        .filter((repo) => approvalOf(db, repo) && !queuedSinceSync(db, "labels-apply", repo) && countPlan(planLabels(db, repo, run)).toAdd > 0)
        .map((repo) => ({ step: "labels-apply", params: { repo } }));
    },
  },
  {
    name: "merge",
    detect: (db) => {
      const repos = [...new Set(buildQueue(db).filter(eligible).map((e) => e.repo))].sort();
      return repos.map((repo) => ({ step: "merge", params: { repo } }));
    },
  },
];

// ---- limits and usage ----------------------------------------------------------

export const dayStart = (ms: number = Date.now()): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

type LimitRow = { step: string; per_day: number | null; updated_by: string | null; updated_at: string | null };

export const limitRow = (db: DatabaseSync, step: string): LimitRow =>
  (db.prepare("SELECT * FROM stage_limits WHERE step = ?").get(step) as LimitRow | undefined) ?? { step, per_day: null, updated_by: null, updated_at: null };

/** Items handled by the step's jobs that started today (UTC). */
export function usageToday(db: DatabaseSync, step: string, ms: number = Date.now()): number {
  return (db.prepare("SELECT COALESCE(SUM(items), 0) AS n FROM jobs WHERE step = ? AND started_at >= ?").get(step, dayStart(ms)) as { n: number }).n;
}

/** After BACKOFF_AFTER failed autopilot jobs in a row: when the stage may run again, else null. */
export function backoffUntil(db: DatabaseSync, step: string, ms: number = Date.now()): number | null {
  const rows = db.prepare("SELECT state, ended_at FROM jobs WHERE step = ? AND requested_by = ? AND state IN ('done', 'failed') ORDER BY id DESC LIMIT ?")
    .all(step, AUTOPILOT_USER, BACKOFF_AFTER) as { state: string; ended_at: string | null }[];
  if (rows.length < BACKOFF_AFTER || rows.some((r) => r.state !== "failed" || !r.ended_at)) return null;
  const until = Date.parse(rows[0]!.ended_at!) + BACKOFF_MS;
  return until > ms ? until : null;
}

/** Why the stage cannot start jobs now, or null. The one place a stage's pause is decided. A step's models are taken at their defaults. */
export function pauseReason(db: DatabaseSync, step: string, ms: number = Date.now()): string | null {
  const l = limitRow(db, step), used = usageToday(db, step, ms);
  if (l.per_day === 0) return "paused: the daily limit is 0";
  if (l.per_day !== null && used >= l.per_day) return `daily limit of ${l.per_day} items reached`;
  const b = backoffUntil(db, step, ms);
  if (b !== null) return `last ${BACKOFF_AFTER} automatic jobs failed; waiting until ${new Date(b).toISOString().slice(11, 16)} UTC`;
  // Steps that call Claude (decide, review-batch, the Haiku part of classify-new) wait for an account with headroom.
  if (usesClaude(modelsOf(knownStep(step), {}))) return claudePauseReason(db, ms);
  return null;
}

// ---- state ---------------------------------------------------------------------

export const isEnabled = (db: DatabaseSync): boolean => getSetting(db, KEY_ENABLED) === "1";

export function setEnabled(db: DatabaseSync, enabled: boolean, by: string): void {
  setSetting(db, KEY_ENABLED, enabled ? "1" : "0");
  setSetting(db, KEY_BY, by);
  setSetting(db, KEY_AT, now());
  // Turning on plans at once; the sync that already happened is not new.
  if (enabled) db.prepare("DELETE FROM settings WHERE key = ?").run(KEY_PLANNED_AT);
}

/** Steps that have a row in stage_limits, in pipeline order. */
export const LIMIT_STEPS = ["classify-new", "embed", "decide", "checks", "review-batch", "labels-apply", "merge"];

export class LimitError extends Error {
  status = 400;
}

export function setLimit(db: DatabaseSync, step: unknown, input: unknown, by: string): { perDay: number | null } {
  if (typeof step !== "string" || !LIMIT_STEPS.includes(step)) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LimitError("the body must be a JSON object");
  const keys = Object.keys(input);
  if (keys.some((k) => k !== "perDay")) throw new LimitError("only perDay can be set");
  const perDay = (input as { perDay?: unknown }).perDay;
  if (perDay === undefined) throw new LimitError("perDay is required (null means no limit)");
  if (perDay !== null && (typeof perDay !== "number" || !Number.isInteger(perDay) || perDay < 0 || perDay > 100_000)) throw new LimitError("perDay must be null or a whole number from 0 to 100000");
  db.prepare(`INSERT INTO stage_limits (step, per_day, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (step) DO UPDATE SET per_day = excluded.per_day, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(step, perDay, by, now());
  audit(db, by, "stage-limit", `step:${step}`, { perDay });
  return { perDay };
}

export async function stageLimits(db: DatabaseSync): Promise<StageLimit[]> {
  const steps = await loadSteps();
  return LIMIT_STEPS.map((step) => {
    const l = limitRow(db, step);
    return { step, title: steps.get(step)?.title ?? step, perDay: l.per_day, usedToday: usageToday(db, step), pausedReason: pauseReason(db, step) };
  });
}

export async function pipelineState(db: DatabaseSync): Promise<PipelineState> {
  return {
    enabled: isEnabled(db), changedBy: getSetting(db, KEY_BY), changedAt: getSetting(db, KEY_AT),
    heartbeat: getSetting(db, "runner_heartbeat"), limits: await stageLimits(db),
  };
}

// ---- planner -------------------------------------------------------------------

export type PlanOptions = { lanes?: Lane[]; nowMs?: number; log?: (line: string) => void };

const warned = new Set<string>();

/**
 * Queues the jobs the autopilot wants now: per lane the first candidate whose step is idle, not cooling
 * down or backing off and has limit left. Returns the queued job ids.
 */
export async function planAutopilot(db: DatabaseSync, opts: PlanOptions = {}): Promise<number[]> {
  const lanes = opts.lanes ?? LANES, ms = opts.nowMs ?? Date.now(), log = opts.log ?? (() => {});
  const steps = await loadSteps();
  const queued: number[] = [];
  for (const lane of lanes) {
    try {
      for (const c of lane.detect(db)) {
        const step = steps.get(c.step);
        if (!step) continue;
        if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(c.step)) continue;
        const l = limitRow(db, c.step), used = usageToday(db, c.step, ms);
        const reason = pauseReason(db, c.step, ms);
        if (reason) {
          if (backoffUntil(db, c.step, ms) !== null && !warned.has(`${c.step}:${backoffUntil(db, c.step, ms)}`)) {
            warned.add(`${c.step}:${backoffUntil(db, c.step, ms)}`);
            log(`autopilot: ${c.step}: ${reason}`);
          }
          continue;
        }
        const last = lastJobEnd(db, c.step, repoOf(c), AUTOPILOT_USER);
        if (last && !last.items && ms - Date.parse(last.endedAt) < COOLDOWN_MS) continue;
        const params: Params = { ...c.params };
        const lp = step.params.find((p) => p.name === "limit" && p.kind === "int");
        if (lp && lp.kind === "int") {
          const remaining = l.per_day === null ? Infinity : l.per_day - used;
          params.limit = Math.min(lp.default ?? lp.max, lp.max, remaining);
          if (params.limit < lp.min) continue;
        }
        try {
          const job = await enqueue(db, c.step, params, AUTOPILOT_USER);
          queued.push(job.id);
          lane.chosen?.(db, c);
          log(`autopilot: job ${job.id}: ${c.step} ${JSON.stringify(job.params)}`);
          break;
        } catch (e) {
          if (!(e instanceof JobError)) throw e;
          log(`autopilot: ${c.step}: not queued: ${e.message}`);
        }
      }
    } catch (e) {
      log(`autopilot: ${lane.name}: ${(e as Error).message}`);
    }
  }
  return queued;
}

/** One runner tick: plans when enabled and a sync, a finished autopilot job or 15 minutes call for it. */
export async function autopilotTick(db: DatabaseSync, opts: PlanOptions = {}): Promise<number[]> {
  if (!isEnabled(db)) return [];
  const t = opts.nowMs ?? Date.now();
  const sync = getSetting(db, "org_high_water");
  const syncChanged = sync !== getSetting(db, KEY_SYNC_SEEN);
  const plannedAt = getSetting(db, KEY_PLANNED_AT);
  const planned = plannedAt === null ? 0 : Date.parse(plannedAt);
  const finished = db.prepare("SELECT 1 FROM jobs WHERE requested_by = ? AND ended_at > ?").get(AUTOPILOT_USER, plannedAt ?? "");
  if (!syncChanged && plannedAt !== null && t - planned < PLAN_EVERY_MS && !finished) return [];
  if (syncChanged) {
    setSetting(db, KEY_SYNC_SEEN, sync ?? "");
    setSetting(db, KEY_SYNC_AT, new Date(t).toISOString());
  }
  setSetting(db, KEY_PLANNED_AT, new Date(t).toISOString());
  return planAutopilot(db, opts);
}
