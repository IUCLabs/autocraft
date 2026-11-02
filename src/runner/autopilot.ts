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
import { commentApprovalOf } from "../act/approval.ts";
import { closeCandidates, pending as actPending } from "../act/index.ts";
import { dupesWork } from "../dupes/index.ts";
import { selectFixups } from "../fixup/candidates.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { buildQueue, eligible } from "../merge/queue.ts";
import { trackedNames } from "../repos.ts";
import { selectCandidates as reviewCandidates } from "../review/candidates.ts";
import { selectCandidates as verifyCandidates } from "../verify/candidates.ts";
import { audit } from "../dash/audit.ts";
import { currentRun, dueItems, haikuDue } from "./classify.ts";
import { enqueue, JobError, now, requestCancel, RUNNER_STOPPED } from "./jobs.ts";
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
const KEY_VERIFY_CURSOR = "pipeline_verify_cursor";

const getSetting = (db: DatabaseSync, key: string): string | null =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
};

// ---- lanes ---------------------------------------------------------------------

/** One job the autopilot may queue; `params` leaves out `limit`, which the planner sets. */
export type Candidate = { step: string; params: Params; /** Another job that must also be startable now, e.g. the review that follows a checks job. */ gate?: { step: string; params: Params } };
/** A pipeline stage in order. `detect` lists the jobs that have work, best first. */
export type Lane = {
  name: string;
  /** Every step the lane may queue. When none of them can start (busy, paused, limit reached, cooling down), the lane is not detected at all. */
  steps?: string[];
  /** Its jobs are per repo, so a cooldown after one repo's job does not close the lane. */
  perRepo?: boolean;
  detect: (db: DatabaseSync, ctx: PlanCtx) => Candidate[];
  /** Runs when the candidate was queued; may write. */
  chosen?: (db: DatabaseSync, c: Candidate) => void;
};

/** What every lane's detect shares, resolved once per planner pass. */
export type PlanCtx = { run: string | null; jevRun: string | null; tracked: string[] };

export const planCtx = (db: DatabaseSync): PlanCtx => ({ run: currentRun(db), jevRun: latestJevRun(db), tracked: trackedNames(db) });

const repoOf = (c: Candidate): string | null => (typeof c.params.repo === "string" ? c.params.repo : null);

function lastJobEnd(db: DatabaseSync, step: string, repo: string | null, requestedBy?: string): { endedAt: string; state: string; items: number | null } | undefined {
  return db.prepare(`SELECT ended_at AS endedAt, state, items FROM jobs WHERE step = ? AND (? IS NULL OR repo = ?)
    AND ended_at IS NOT NULL AND (? IS NULL OR requested_by = ?) AND COALESCE(error, '') <> ? ORDER BY id DESC LIMIT 1`)
    .get(step, repo, repo, requestedBy ?? null, requestedBy ?? null, RUNNER_STOPPED) as { endedAt: string; state: string; items: number | null } | undefined;
}

/** True when the autopilot already queued `step` (for `repo`) since the planner last saw a new sync. */
function queuedSinceSync(db: DatabaseSync, step: string, repo: string): boolean {
  const since = getSetting(db, KEY_SYNC_AT) ?? "";
  return !!db.prepare("SELECT 1 FROM jobs WHERE step = ? AND requested_by = ? AND repo = ? AND requested_at >= ?")
    .get(step, AUTOPILOT_USER, repo, since);
}

/** Tracked repos after `cursor` first, wrapping round. */
export function roundRobin(repos: string[], cursor: string | null): string[] {
  const sorted = [...repos].sort();
  const after = sorted.filter((r) => cursor !== null && r > cursor);
  return [...after, ...sorted.filter((r) => !after.includes(r))];
}

/** A PR refused at its current head waits for its CI or mergeable state to differ from what GitHub reported at the refusal. */
export function refusedAsBefore(db: DatabaseSync, e: { repo: string; number: number; head: string; state: string; ci: string; mergeable: string }): boolean {
  if (e.state !== "refused") return false;
  const r = db.prepare("SELECT outcome, ci, mergeable FROM merges WHERE repo = ? AND number = ? AND head_oid = ? ORDER BY at DESC, rowid DESC LIMIT 1")
    .get(e.repo, e.number, e.head) as { outcome: string; ci: string | null; mergeable: string | null } | undefined;
  if (r?.outcome !== "refused") return false;
  return r.ci === null || r.mergeable === null || (r.ci === e.ci && r.mergeable === e.mergeable);
}

export const LANES: Lane[] = [
  {
    name: "classify",
    steps: ["classify-new"],
    detect: (db, { run }) => {
      if (!run) return [];
      return dueItems(db, run, "new").due.length || haikuDue(db, run, 1).length ? [{ step: "classify-new", params: {} }] : [];
    },
  },
  {
    name: "embed",
    steps: ["embed"],
    detect: (db) => (embedPending(db, embedderId(modelName())).length ? [{ step: "embed", params: {} }] : []),
  },
  {
    // Before Decide: items held as duplicates wait out the later stages.
    name: "dupes",
    steps: ["dupes"],
    detect: (db) => (dupesWork(db) ? [{ step: "dupes", params: {} }] : []),
  },
  {
    name: "decide",
    steps: ["decide"],
    detect: (db, { jevRun: run }) => {
      return run && decideCandidates(db, run).length ? [{ step: "decide", params: {} }] : [];
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its review.
    name: "review",
    steps: ["checks", "review-batch"],
    perRepo: true,
    detect: (db, { run, tracked }) => {
      const out: Candidate[] = [];
      for (const repo of roundRobin(tracked, getSetting(db, KEY_CURSOR))) {
        if (!reviewCandidates(db, repo, run).length) continue;
        const checks = lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const review = { step: "review-batch", params: { repo } };
        out.push(fresh ? review : { step: "checks", params: { repo }, gate: review });
      }
      return out;
    },
    chosen: (db, c) => {
      if (c.step === "review-batch") setSetting(db, KEY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "labels",
    steps: ["labels-apply"],
    perRepo: true,
    detect: (db, { run, tracked }) => {
      if (!run) return [];
      return tracked
        .filter((repo) => approvalOf(db, repo) && !queuedSinceSync(db, "labels-apply", repo) && countPlan(planLabels(db, repo, run)).toAdd > 0)
        .map((repo) => ({ step: "labels-apply", params: { repo } }));
    },
  },
  {
    name: "merge",
    steps: ["merge"],
    perRepo: true,
    detect: (db, { run }) => {
      const repos = [...new Set(buildQueue(db, { run }).filter((e) => eligible(e) && mergeApprovalOf(db, e.repo) && !refusedAsBefore(db, e)).map((e) => e.repo))].sort();
      return repos.map((repo) => ({ step: "merge", params: { repo } }));
    },
  },
  {
    // Comments and closes after operator answers, and Close? decisions for reviewed PRs.
    name: "act",
    steps: ["act"],
    perRepo: true,
    detect: (db, { tracked }) =>
      tracked.filter((repo) => commentApprovalOf(db, repo) && (actPending(db, repo).length || closeCandidates(db, repo).length)).map((repo) => ({ step: "act", params: { repo } })),
  },
  {
    name: "fixup",
    steps: ["fixup"],
    perRepo: true,
    detect: (db, { tracked }) => {
      const repos = tracked.filter((repo) => {
        const s = selectFixups(db, repo);
        return s.fix.length > 0 || s.cannotPush.length > 0;
      });
      return repos.sort().map((repo) => ({ step: "fixup", params: { repo } }));
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its planning.
    name: "verify",
    steps: ["checks", "verify"],
    perRepo: true,
    detect: (db, { run, tracked }) => {
      const out: Candidate[] = [];
      for (const repo of roundRobin(tracked, getSetting(db, KEY_VERIFY_CURSOR))) {
        if (!verifyCandidates(db, repo, run).length) continue;
        const checks = lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const verify = { step: "verify", params: { repo } };
        out.push(fresh ? verify : { step: "checks", params: { repo }, gate: verify });
      }
      return out;
    },
    chosen: (db, c) => {
      if (c.step === "verify") setSetting(db, KEY_VERIFY_CURSOR, String(c.params.repo));
    },
  },
];

// ---- limits and usage ----------------------------------------------------------

export const dayStart = (ms: number = Date.now()): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

type LimitRow = { step: string; per_day: number | null; updated_by: string | null; updated_at: string | null };

/** Daily limits that apply until an operator sets one. */
const DEFAULT_PER_DAY: Record<string, number> = { dupes: 2000 };

export const limitRow = (db: DatabaseSync, step: string): LimitRow =>
  (db.prepare("SELECT * FROM stage_limits WHERE step = ?").get(step) as LimitRow | undefined) ?? { step, per_day: DEFAULT_PER_DAY[step] ?? null, updated_by: null, updated_at: null };

/** Items handled by the step's jobs that started today (UTC). */
export function usageToday(db: DatabaseSync, step: string, ms: number = Date.now()): number {
  return (db.prepare("SELECT COALESCE(SUM(items), 0) AS n FROM jobs WHERE step = ? AND started_at >= ?").get(step, dayStart(ms)) as { n: number }).n;
}

/** After BACKOFF_AFTER failed autopilot jobs in a row: when the stage may run again, else null. */
export function backoffUntil(db: DatabaseSync, step: string, ms: number = Date.now()): number | null {
  // Failed, or done without handling anything although the autopilot saw work; jobs a runner restart ended do not count.
  const rows = db.prepare(`SELECT state, ended_at, items FROM jobs WHERE step = ? AND requested_by = ? AND state IN ('done', 'failed')
    AND COALESCE(error, '') <> ? ORDER BY id DESC LIMIT ?`).all(step, AUTOPILOT_USER, RUNNER_STOPPED, BACKOFF_AFTER) as { state: string; ended_at: string | null; items: number | null }[];
  if (rows.length < BACKOFF_AFTER || rows.some((r) => !r.ended_at || (r.state === "done" && (r.items ?? 0) > 0))) return null;
  const until = Date.parse(rows[0]!.ended_at!) + BACKOFF_MS;
  return until > ms ? until : null;
}

/** Why the stage cannot start jobs now, or null. The one place a stage's pause is decided. A step's models are taken at their defaults. */
export function pauseReason(db: DatabaseSync, step: string, ms: number = Date.now()): string | null {
  const l = limitRow(db, step), used = usageToday(db, step, ms);
  if (l.per_day === 0) return "paused: the daily limit is 0";
  if (l.per_day !== null && used >= l.per_day) return `daily limit of ${l.per_day} items reached`;
  const b = backoffUntil(db, step, ms);
  if (b !== null) return `last ${BACKOFF_AFTER} automatic jobs failed or did nothing; waiting until ${new Date(b).toISOString().slice(11, 16)} UTC`;
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
  // Automatic jobs still waiting are dropped; running ones finish.
  if (!enabled) {
    const waiting = db.prepare("SELECT id, step FROM jobs WHERE state = 'queued' AND requested_by = ?").all(AUTOPILOT_USER) as { id: number; step: string }[];
    for (const j of waiting) {
      requestCancel(db, j.id, by);
      audit(db, by, "job-cancel", `job:${j.id}`, { step: j.step, state: "queued", reason: "pipeline switched off" });
    }
  }
  // Turning on plans at once; the sync that already happened is not new.
  if (enabled) db.prepare("DELETE FROM settings WHERE key = ?").run(KEY_PLANNED_AT);
}

/** Steps that have a row in stage_limits, in pipeline order. */
export const LIMIT_STEPS = ["classify-new", "embed", "dupes", "decide", "checks", "review-batch", "labels-apply", "merge", "act", "fixup", "verify"];

/** Steps whose jobs cannot be sized to what remains of the day: only no limit or a pause makes sense. */
export const ZERO_ONLY = ["checks"];

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
  if (ZERO_ONLY.includes(step) && perDay !== null && perDay !== 0) throw new LimitError(`${step} cannot be sized by a daily limit: use none, or 0 to pause it`);
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

/** A job the detection pass wants queued; `params` include the `limit` the gate set. */
export type Proposal = { lane: string; step: string; params: Params; gate?: { step: string; params: Params } };
export type Detected = { proposals: Proposal[]; logs: string[] };

/** The most proposals one lane hands to apply, in case the first ones are refused at enqueue. */
const PROPOSALS_PER_LANE = 3;

const warned = new Set<string>();

/**
 * Detection: reads the database and returns, per lane, the candidates whose step is idle, not cooling
 * down or backing off and has limit left. Writes nothing, so the runner can do it on another connection
 * while it keeps polling; applyProposals() queues the result.
 */
export async function detectAutopilot(db: DatabaseSync, opts: PlanOptions = {}): Promise<Detected> {
  const lanes = opts.lanes ?? LANES, ms = opts.nowMs ?? Date.now();
  const logs: string[] = [];
  const log = (l: string) => { logs.push(l); opts.log?.(l); };
  const steps = await loadSteps();
  const proposals: Proposal[] = [];
  // Pause, backoff and limit do not change during the pass: one answer per step.
  const paused = new Map<string, string | null>();
  const limitLeft = new Map<string, { limit?: number } | null>();

  const pausedWhy = (stepName: string): string | null => {
    if (!paused.has(stepName)) paused.set(stepName, pauseReason(db, stepName, ms));
    return paused.get(stepName)!;
  };

  /** The job's `limit` (undefined when the step has none), or why it cannot start now. */
  const gate = (stepName: string, params: Params, cooldown = true): { limit?: number } | null => {
    const step = steps.get(stepName);
    if (!step) return null;
    if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(stepName)) return null;
    const reason = pausedWhy(stepName);
    if (reason) {
      const b = backoffUntil(db, stepName, ms);
      if (b !== null && !warned.has(`${stepName}:${b}`)) {
        warned.add(`${stepName}:${b}`);
        log(`autopilot: ${stepName}: ${reason}`);
      }
      return null;
    }
    const last = cooldown ? lastJobEnd(db, stepName, typeof params.repo === "string" ? params.repo : null, AUTOPILOT_USER) : undefined;
    if (last && !last.items && ms - Date.parse(last.endedAt) < COOLDOWN_MS) return null;
    if (!limitLeft.has(stepName)) {
      const lp = step.params.find((p) => p.name === "limit" && p.kind === "int");
      if (!lp || lp.kind !== "int") limitLeft.set(stepName, {});
      else {
        const perDay = limitRow(db, stepName).per_day;
        const limit = Math.min(lp.default ?? lp.max, lp.max, perDay === null ? Infinity : perDay - usageToday(db, stepName, ms));
        limitLeft.set(stepName, limit < lp.min ? null : { limit });
      }
    }
    return limitLeft.get(stepName)!;
  };

  let ctx: PlanCtx | undefined;
  for (const lane of lanes) {
    try {
      // A lane whose steps cannot start is not worth detecting.
      if (lane.steps && !lane.steps.some((s) => gate(s, {}, !lane.perRepo))) continue;
      let taken = 0;
      for (const c of lane.detect(db, (ctx ??= planCtx(db)))) {
        if (c.gate && !gate(c.gate.step, c.gate.params)) continue;
        const g = gate(c.step, c.params);
        if (!g) continue;
        const params: Params = { ...c.params, ...(g.limit === undefined ? {} : { limit: g.limit }) };
        proposals.push({ lane: lane.name, step: c.step, params, ...(c.gate ? { gate: c.gate } : {}) });
        if (++taken >= PROPOSALS_PER_LANE) break;
      }
    } catch (e) {
      log(`autopilot: ${lane.name}: ${(e as Error).message}`);
    }
  }
  return { proposals, logs };
}

/** Queues the proposals: per lane the first one that is accepted. Returns the queued job ids. */
export async function applyProposals(db: DatabaseSync, proposals: Proposal[], opts: PlanOptions = {}): Promise<number[]> {
  const lanes = opts.lanes ?? LANES, log = opts.log ?? (() => {});
  const queued: number[] = [];
  const done = new Set<string>();
  for (const p of proposals) {
    if (done.has(p.lane)) continue;
    try {
      // The detection ran a moment ago: a job of the same step may have been queued since.
      if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(p.step)) continue;
      const job = await enqueue(db, p.step, p.params, AUTOPILOT_USER);
      queued.push(job.id);
      done.add(p.lane);
      const c: Candidate = { step: p.step, params: Object.fromEntries(Object.entries(p.params).filter(([k]) => k !== "limit")) };
      lanes.find((l) => l.name === p.lane)?.chosen?.(db, c);
      log(`autopilot: job ${job.id}: ${p.step} ${JSON.stringify(job.params)}`);
    } catch (e) {
      if (!(e instanceof JobError)) {
        log(`autopilot: ${p.lane}: ${(e as Error).message}`);
        done.add(p.lane);
      } else log(`autopilot: ${p.step}: not queued: ${e.message}`);
    }
  }
  return queued;
}

/** Detection and queueing in one go, on one connection. */
export async function planAutopilot(db: DatabaseSync, opts: PlanOptions = {}): Promise<number[]> {
  const { proposals } = await detectAutopilot(db, opts);
  return applyProposals(db, proposals, opts);
}

/**
 * Whether the planner is due now: a sync, a finished autopilot job or 15 minutes call for it. Moves the
 * planner's marks when it is, so the caller must then plan.
 */
export function planDue(db: DatabaseSync, nowMs: number = Date.now()): boolean {
  if (!isEnabled(db)) return false;
  const t = nowMs;
  const sync = getSetting(db, "org_high_water");
  const syncChanged = (sync ?? "") !== (getSetting(db, KEY_SYNC_SEEN) ?? "");
  const plannedAt = getSetting(db, KEY_PLANNED_AT);
  const planned = plannedAt === null ? 0 : Date.parse(plannedAt);
  const finished = db.prepare("SELECT 1 FROM jobs WHERE requested_by = ? AND ended_at > ?").get(AUTOPILOT_USER, plannedAt ?? "");
  if (!syncChanged && plannedAt !== null && t - planned < PLAN_EVERY_MS && !finished) return false;
  if (syncChanged) {
    setSetting(db, KEY_SYNC_SEEN, sync ?? "");
    setSetting(db, KEY_SYNC_AT, new Date(t).toISOString());
  }
  setSetting(db, KEY_PLANNED_AT, new Date(t).toISOString());
  return true;
}

/** One planner pass on this connection when due (tests and the CLI; the runner detects on a worker thread). */
export async function autopilotTick(db: DatabaseSync, opts: PlanOptions = {}): Promise<number[]> {
  return planDue(db, opts.nowMs) ? planAutopilot(db, opts) : [];
}
