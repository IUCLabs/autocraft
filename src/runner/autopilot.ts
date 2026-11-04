// The pipeline switch and the autopilot behind it. With the switch on, the
// runner looks for work whenever a content topic changed, a job finished or an
// operator released work (a 5-minute timer is only a fallback), and queues one
// job per stage that has work, no job of its own queued or running, and an
// item limit left for the day. A job that handled nothing is not queued again
// until the input it saw changes (its fingerprint); a failed job is retried
// after a short, growing backoff. Stages run in pipeline order; a failure in
// one does not stop the others. Turned off, no new jobs are queued and running
// jobs finish.
//
// The planner only reads the database and queues jobs; the runner starts them.
// Each lane's `detect` reuses the candidate code of the stage it feeds.
import type { DatabaseSync } from "node:sqlite";
import type { PipelineState, StageLimit } from "../../web/src/api/types.ts";
import { readSeqs, TOPICS } from "../live.ts";
import { backfillIds } from "../decide/recommend.ts";
import { pendingConversations } from "../conversations/store.ts";
import { latestJevRun, selectCandidates as decideCandidates } from "../decide/select.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { pending as embedPending } from "../embed/store.ts";
import { approvalOf } from "../labels/approval.ts";
import { labelsToApply } from "../labels/github.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { closeCandidates, pending as actPending } from "../act/index.ts";
import { compareWork, dupesWork } from "../dupes/index.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { selectFixups } from "../fixup/candidates.ts";
import { selectCifix } from "../cifix/candidates.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { ciApprovalOf, needsWork } from "../merge/ci-approval.ts";
import { batchesDue } from "../merge/batch-store.ts";
import { buildQueue, eligible, refusedAsBefore, toAsk } from "../merge/queue.ts";

export { refusedAsBefore };
import { trackedNames } from "../repos.ts";
import { planned, type Planned } from "../core/select.ts";
import { postCandidates } from "../review/post.ts";
import { collectDue } from "../verify/results.ts";
import { collectDue as fixCollectDue, fixDue } from "../fixissue/index.ts";
import { audit } from "../dash/audit.ts";
import { defaultPerDay, lanesInOrder, limitSteps, zeroOnlySteps } from "../stages/registry.ts";
import { applyUsedAnswers } from "../decisions-used.ts";
import { duePriorityCount } from "../priority/index.ts";
import { selectIssues } from "../fixissue/candidates.ts";
import { premergeCandidates } from "../premerge/review.ts";
import { pendingDefects, selectPostmerge } from "../postmerge/select.ts";
import { mainFixDue } from "../mainfix/index.ts";
import { refereeCandidates } from "../classify/referee.ts";
import { currentRun, dueItems, haikuDue } from "./classify.ts";
import { enqueue, JobError, now, requestCancel, RUNNER_STOPPED } from "./jobs.ts";
import { claudePauseReason } from "../agents/accounts.ts";
import { knownStep, loadSteps, modelsOf, usesClaude, type Params } from "./steps.ts";
import { pilotItems, scopeRepos } from "../pilot.ts";
import { fastFirst, fastScoreOf } from "../fasttrack.ts";

/** Fallback only: the planner normally runs on a content change, a finished job or a release. */
export const PLAN_EVERY_MS = 5 * 60_000;
/** Failed jobs of a step are retried after 1, 2, 4, 8, 16 minutes, then every 30. */
export const FAIL_BACKOFF_MS = 60_000;
export const FAIL_BACKOFF_MAX_MS = 30 * 60_000;
/** Checks younger than this count as current for the review that follows. */
export const CHECKS_FRESH_MS = 5 * 60_000;
/** How often the CI and mergeable state of a repo with PRs waiting for CI (or an open batch PR) is read again. */
export const WAITING_CI_RECHECK_MS = 60_000;
export const AUTOPILOT_USER = "pipeline";

export const KEY_ENABLED = "pipeline_enabled";
const KEY_BY = "pipeline_changed_by", KEY_AT = "pipeline_changed_at";
const KEY_PLANNED_AT = "pipeline_planned_at", KEY_SEQS_SEEN = "pipeline_seqs_seen", KEY_WAKE_AT = "pipeline_wake_at", KEY_STATUS = "pipeline_status";
const KEY_CURSOR = "pipeline_review_cursor";
const KEY_VERIFY_CURSOR = "pipeline_verify_cursor";
const KEY_RESET = "limit_reset_at:";

const getSetting = (db: DatabaseSync, key: string): string | null =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
};

// ---- lanes ---------------------------------------------------------------------

/** The first (best-scored) planned PR of each repo. */
const firstByRepo = (items: Planned[]): Map<string, Planned> => {
  const out = new Map<string, Planned>();
  for (const p of items) if (!out.has(p.facts.repo)) out.set(p.facts.repo, p);
  return out;
};

/** One job the autopilot may queue; `params` leaves out `limit`, which the planner sets. */
export type Candidate = {
  step: string; params: Params;
  /** Polls an external system (CI, GitHub, the sandbox): it may run again on unchanged inputs, at most once a minute. */
  poll?: boolean;
  /** Another job that must also be startable now, e.g. the review that follows a checks job. */
  gate?: { step: string; params: Params; poll?: boolean };
};
/** A pipeline stage in order. `detect` lists the jobs that have work, best first. */
export type Lane = {
  name: string;
  /** Every step the lane may queue. When none of them can start (busy, paused, limit reached, cooling down), the lane is not detected at all. */
  steps?: string[];
  /** Its jobs are per repo: the lane's jobs are judged one repo at a time. */
  perRepo?: boolean;
  /** The change topics the lane's input lives in (default: INPUT_TOPICS). A job that handled nothing is not queued again while these and `extra` are unchanged. */
  topics?: string[];
  /** Input that no topic reports, e.g. the state of sandbox tasks. */
  extra?: (db: DatabaseSync) => string;
  /** Least time between two of the lane's jobs: for cheap recomputes whose input moves in bursts (a sync writes in several transactions) and that no stage waits on. */
  minGapMs?: number;
  detect: (db: DatabaseSync, ctx: PlanCtx) => Candidate[];
  /** Work score of the lane's best item, null when it has none. Lanes that define it share capacity: see orderLanes(). */
  topScore?: (db: DatabaseSync, ctx: PlanCtx) => number | null;
  /** Runs when the candidate was queued; may write. */
  chosen?: (db: DatabaseSync, c: Candidate) => void;
};

/** What every lane's detect shares, resolved once per planner pass. */
export type PlanCtx = {
  run: string | null; jevRun: string | null; tracked: string[];
  /** Times (ms) at which something the lanes wait for becomes due; the planner wakes at the earliest. */
  wake?: number[];
  /** Why a stage waits on an outside system (CI, the sandbox), keyed by step; shown on the Pipeline page. */
  notes?: Record<string, string>;
};

/** Only the repos in scope (pipeline on, narrowed by the pilot) are planned for; a job for another repo is never proposed. */
export const planCtx = (db: DatabaseSync): PlanCtx => {
  const scope = scopeRepos(db);
  return { run: currentRun(db), jevRun: latestJevRun(db), tracked: trackedNames(db).filter((r) => scope.has(r)), wake: [], notes: {} };
};

/** Topics whose changes call for a plan: content the stages read. Job logs, usage, agent runs, sandbox environments and tasks, and audit entries do not. */
export const INPUT_TOPICS = TOPICS.filter((t) => !["jobs", "usage", "agents", "envs", "tasks", "access", "github"].includes(t));

/** Sandbox tasks that ended, for lanes that read their results. */
const tasksSig = (db: DatabaseSync): string =>
  String((db.prepare("SELECT COUNT(*) AS n FROM main.build_tasks WHERE state IN ('done', 'failed', 'cancelled', 'lost')").get() as { n: number }).n);

/** Daily limits are not a topic of their own (they share `jobs`). */
const limitsSig = (db: DatabaseSync): string =>
  String((db.prepare("SELECT group_concat(step || '=' || COALESCE(per_day, 'n'), ',') AS s FROM (SELECT step, per_day FROM stage_limits ORDER BY step)").get() as { s: string | null }).s ?? "")
  + String((db.prepare(`SELECT group_concat(key || '=' || value, ',') AS s FROM (SELECT key, value FROM settings WHERE key LIKE '${KEY_RESET}%' ORDER BY key)`).get() as { s: string | null }).s ?? "");

const repoOf = (c: Candidate): string | null => (typeof c.params.repo === "string" ? c.params.repo : null);

type JobEnd = { id: number; endedAt: string; state: string; items: number | null; acted: number | null };

function lastJobEnd(db: DatabaseSync, step: string, repo: string | null, requestedBy?: string): JobEnd | undefined {
  return db.prepare(`SELECT id, ended_at AS endedAt, state, items, acted FROM jobs WHERE step = ? AND (? IS NULL OR repo = ?)
    AND ended_at IS NOT NULL AND (? IS NULL OR requested_by = ?) AND COALESCE(error, '') <> ? ORDER BY id DESC LIMIT 1`)
    .get(step, repo, repo, requestedBy ?? null, requestedBy ?? null, RUNNER_STOPPED) as JobEnd | undefined;
}

/** A job that changed nothing: it handled no items and made no other progress (a batch advanced, a PR opened, a decision asked). */
const wasIdle = (j: { items: number | null; acted: number | null }): boolean => !j.items && !j.acted;

// ---- fingerprints ----------------------------------------------------------------

type FpRecord = { job: number; fp: string };
const fpKey = (step: string, repo: string | null): string => `pipeline_fp:${step}|${repo ?? ""}`;

/** What the lane's input looked like: the step, its repo, and the counters of the topics it reads. */
export function fingerprintOf(db: DatabaseSync, lane: Pick<Lane, "topics" | "extra">, step: string, params: Params, seqs: Record<string, number> = readSeqs(db)): string {
  const topics = lane.topics ?? INPUT_TOPICS;
  return [step, typeof params.repo === "string" ? params.repo : "", ...topics.map((t) => seqs[t] ?? 0), lane.extra?.(db) ?? ""].join("|");
}

function fpRecord(db: DatabaseSync, step: string, repo: string | null): FpRecord | null {
  const v = getSetting(db, fpKey(step, repo));
  if (!v) return null;
  try { return JSON.parse(v) as FpRecord; } catch { return null; }
}

/** Tracked repos after `cursor` first, wrapping round. */
export function roundRobin(repos: string[], cursor: string | null): string[] {
  const sorted = [...repos].sort();
  const after = sorted.filter((r) => cursor !== null && r > cursor);
  return [...after, ...sorted.filter((r) => !after.includes(r))];
}

/** The highest of the scores, null when there is none. */
export const bestScore = (scores: (number | null | undefined)[]): number | null => {
  const some = scores.filter((s): s is number => typeof s === "number");
  return some.length ? Math.max(...some) : null;
};

/**
 * Lanes that have a topScore trade places by it: the lane whose best item has the higher work score comes
 * first, so its job is queued first. A lane without work goes last; ties keep the pipeline order. Other
 * lanes keep their places.
 */
export function orderLanes<T extends { name: string }>(lanes: T[], tops: Map<string, number | null>): T[] {
  const shared = lanes.filter((l) => tops.has(l.name));
  const sorted = [...shared].sort((a, b) => (tops.get(b.name) ?? -1) - (tops.get(a.name) ?? -1));
  let k = 0;
  return lanes.map((l) => (tops.has(l.name) ? sorted[k++]! : l));
}

/** The code of each lane, keyed by name. Names, steps and order come from the stage registry. */
const LANE_CODE: Omit<Lane, "steps">[] = [
  {
    name: "classify",
    detect: (db, { run }) => {
      if (!run) return [];
      return dueItems(db, run, "new").due.length || haikuDue(db, run, 1).length ? [{ step: "classify-new", params: {} }] : [];
    },
  },
  {
    // Items without a priority at their current text hash; the scores of the others are refreshed by the same job.
    name: "priority",
    detect: (db) => (duePriorityCount(db) ? [{ step: "prioritize", params: {} }] : []),
  },
  {
    // Work score from the stored priority, size, type and security flag; no model. It is cheap and has no work test of its own:
    // the fingerprint (items, fix triage, priorities; not its own output) decides whether its input moved.
    name: "rank",
    topics: INPUT_TOPICS.filter((t) => t !== "ranks"),
    extra: (db) => String((db.prepare("SELECT COUNT(*) || ':' || COALESCE(MAX(at), '') AS s FROM main.item_priority").get() as { s: string }).s),
    minGapMs: 60_000,
    detect: () => [{ step: "rank", params: {} }],
  },
  {
    name: "embed",
    detect: (db) => (embedPending(db, embedderId(modelName())).length ? [{ step: "embed", params: {} }] : []),
  },
  {
    // Before Decide: items held as duplicates wait out the later stages.
    name: "dupes",
    detect: (db) => (dupesWork(db) ? [{ step: "dupes", params: {} }] : []),
  },
  {
    // Each duplicate group is compared once its pairs are checked; the comparison asks the group decision.
    name: "dupes-compare",
    detect: (db) => (compareWork(db) ? [{ step: "dupes-compare", params: {} }] : []),
  },
  {
    name: "decide",
    detect: (db, { jevRun: run }) => {
      // Open scope decisions without a recommendation (asked before recommendations existed) also need a job; an answered-null one has recommended_by set.
      return (run && decideCandidates(db, run).length) || backfillIds(db, 1).length ? [{ step: "decide", params: {} }] : [];
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its review.
    name: "review",
    perRepo: true,
    detect: (db, { run, tracked }) => {
      const out: Candidate[] = [];
      const top = firstByRepo(planned(db, "review", { run }));
      for (const repo of fastFirst(db, roundRobin(tracked, getSetting(db, KEY_CURSOR)), (r) => top.get(r)?.facts.number)) {
        if (!top.has(repo)) continue;
        const checks = lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const review = { step: "opus-review", params: { repo } };
        out.push(fresh ? review : { step: "checks", params: { repo }, poll: true, gate: review });
      }
      return out;
    },
    topScore: (db, { run, tracked }) => {
      const top = firstByRepo(planned(db, "review", { run }));
      return bestScore(tracked.map((repo) => top.get(repo)?.facts.score));
    },
    chosen: (db, c) => {
      if (c.step === "opus-review") setSetting(db, KEY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "labels",
    perRepo: true,
    detect: (db, { run, tracked }) => {
      if (!run) return [];
      return tracked
        .filter((repo) => approvalOf(db, repo) && labelsToApply(db, repo, run).length > 0)
        .map((repo) => ({ step: "labels-apply", params: { repo } }));
    },
  },
  {
    // Needs no merge approval: asking writes only decisions.
    name: "merge-ask",
    detect: (db, { run, tracked }) => {
      const repos = new Set(tracked);
      return toAsk(db, buildQueue(db, { run, merged: "exclude" }).filter((e) => repos.has(e.repo))).length ? [{ step: "merge-ask", params: {} }] : [];
    },
  },
  {
    // Batches in flight and PRs waiting for CI are external waits: they are read again every WAITING_CI_RECHECK_MS, on unchanged inputs too.
    name: "merge",
    perRepo: true,
    extra: tasksSig,
    detect: (db, ctx) => {
      const queue = buildQueue(db, { run: ctx.run }).filter((e) => mergeApprovalOf(db, e.repo));
      const due = new Set(queue.filter((e) => eligible(e) && !refusedAsBefore(db, e)).map((e) => e.repo));
      const batches = new Set(batchesDue(db));
      const out: Candidate[] = [];
      // A merge job that advanced a batch runs again at once; one that only watched waits.
      const later = (step: string, repo: string): boolean => {
        const last = lastJobEnd(db, step, repo);
        if (last && (step === "checks" || wasIdle(last)) && Date.now() - Date.parse(last.endedAt) < WAITING_CI_RECHECK_MS) {
          ctx.wake?.push(Date.parse(last.endedAt) + WAITING_CI_RECHECK_MS);
          const n = queue.filter((e) => e.repo === repo && e.state === "waiting-ci").length;
          (ctx.notes ??= {})[step] = n ? `waiting for CI on ${n} PR${n === 1 ? "" : "s"} in ${repo}` : `waiting for the batch PR's CI in ${repo}`;
          return true;
        }
        return false;
      };
      // The repo whose eligible PR is fast-tracked first goes first.
      const topEligible = (r: string): number | undefined => queue.filter((e) => e.repo === r && eligible(e)).sort((a, b) => (fastScoreOf(db, r, b.number) ?? -1) - (fastScoreOf(db, r, a.number) ?? -1))[0]?.number;
      for (const repo of fastFirst(db, [...new Set([...due, ...batches])].sort(), topEligible)) {
        const poll = batches.has(repo);
        if (poll && later("merge", repo)) continue;
        out.push({ step: "merge", params: { repo }, ...(poll ? { poll } : {}) });
      }
      // No other stage refreshes a PR that waits only for CI or for GitHub to compute its mergeable state.
      const waiting = [...new Set(queue.filter((e) => e.state === "waiting-ci").map((e) => e.repo))].filter((repo) => !due.has(repo) && !batches.has(repo) && !later("checks", repo)).sort();
      for (const repo of waiting) out.push({ step: "checks", params: { repo }, poll: true, gate: { step: "merge", params: { repo }, poll: true } });
      return out;
    },
  },
  {
    // Comments and closes after operator answers, and Close? decisions for reviewed PRs.
    name: "act",
    perRepo: true,
    detect: (db, { tracked }) =>
      tracked.filter((repo) => commentApprovalOf(db, repo) && (actPending(db, repo).length || closeCandidates(db, repo).length)).map((repo) => ({ step: "act", params: { repo } })),
  },
  {
    name: "fixup",
    perRepo: true,
    detect: (db, { tracked }) => {
      const repos = tracked.filter((repo) => {
        const sel = selectFixups(db, repo);
        return (pushApprovalOf(db, repo) && (sel.fix.length > 0 || sel.conflictMerge.length > 0)) || sel.ask.length > 0 || sel.conflictAsk.length > 0;
      });
      return fastFirst(db, repos.sort(), (r) => { const sel = selectFixups(db, r); return (sel.fix[0] ?? sel.ask[0] ?? sel.conflictMerge[0] ?? sel.conflictAsk[0])?.number; }).map((repo) => ({ step: "fixup", params: { repo } }));
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its planning.
    name: "verify",
    perRepo: true,
    extra: tasksSig,
    detect: (db, { run, tracked }) => {
      const out: Candidate[] = [];
      const top = firstByRepo([...planned(db, "verify", { run, bucket: "plan" }), ...planned(db, "verify", { run, bucket: "unavailable" })]);
      for (const repo of fastFirst(db, roundRobin(tracked, getSetting(db, KEY_VERIFY_CURSOR)), (r) => top.get(r)?.facts.number)) {
        if (!top.has(repo)) continue;
        const checks = lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const verify = { step: "verify", params: { repo } };
        out.push(fresh ? verify : { step: "checks", params: { repo }, poll: true, gate: verify });
      }
      return out;
    },
    chosen: (db, c) => {
      if (c.step === "verify") setSetting(db, KEY_VERIFY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "verify-collect",
    extra: tasksSig,
    detect: (db) => (collectDue(db) ? [{ step: "verify-collect", params: {} }] : []),
  },
  {
    name: "fixissue",
    perRepo: true,
    extra: tasksSig,
    detect: (db, { tracked }) => fastFirst(db, tracked.filter((repo) => fixDue(db, repo)).sort(), (r) => selectIssues(db, r)[0]?.number).map((repo) => ({ step: "fixissue", params: { repo } })),
    topScore: (db, { tracked }) => bestScore(tracked.map((repo) => selectIssues(db, repo)[0]?.score)),
  },
  {
    name: "fixissue-collect",
    extra: tasksSig,
    detect: (db) => (fixCollectDue(db) ? [{ step: "fixissue-collect", params: {} }] : []),
  },
  {
    // Label disagreements outside the scope labels, after Jev and Haiku have both answered.
    name: "referee",
    detect: (db, { run }) => (run && refereeCandidates(db, run, 1).length ? [{ step: "referee", params: {} }] : []),
  },
  {
    // The final Opus reviews, posted as one PR review each in repos approved for comments.
    name: "review-post",
    perRepo: true,
    detect: (db, { tracked }) => {
      const due = new Set(planned(db, "post-review").map((p) => p.facts.repo));
      return tracked.filter((repo) => commentApprovalOf(db, repo) && due.has(repo)).sort().map((repo) => ({ step: "review-post", params: { repo } }));
    },
  },
  {
    // Operator messages in conversations; answered whether or not the item's repo is in scope, since an operator started them.
    name: "conversation",
    detect: (db) => (pendingConversations(db).length ? [{ step: "conversation", params: {} }] : []),
  },
  {
    // Runs GitHub holds for approval on reviewed outside PRs; the checks job records them, the step approves.
    name: "ci-approve",
    perRepo: true,
    detect: (db, { tracked }) => tracked.filter((repo) => ciApprovalOf(db, repo) && needsWork(db, repo).length).sort().map((repo) => ({ step: "ci-approve", params: { repo } })),
  },
  {
    // Failing gate checks of wanted PRs: the log is read, a formatter run is queued or collected, or a patch is written and pushed.
    name: "cifix",
    perRepo: true,
    extra: tasksSig,
    detect: (db, { tracked }) => tracked.filter((repo) => { const sel = selectCifix(db, repo); return sel.work.length > 0 || sel.collect.length > 0; }).sort().map((repo) => ({ step: "cifix", params: { repo } })),
  },
  {
    name: "cifix-rerun",
    perRepo: true,
    detect: (db, { tracked }) => tracked.filter((repo) => selectCifix(db, repo).rerun.length > 0).sort().map((repo) => ({ step: "cifix-rerun", params: { repo } })),
  },
  {
    // The adversarial review of each PR head the merge rule would merge; the queue holds the PR until it is stored.
    name: "premerge",
    perRepo: true,
    detect: (db, { tracked, wake, run }) => {
      // One pass over every repo's Plans, with the planner's run.
      const repos = new Set(tracked);
      const due = new Set(premergeCandidates(db, { run, wake }).map((e) => e.repo));
      return [...due].filter((repo) => repos.has(repo)).sort().map((repo) => ({ step: "premerge", params: { repo } }));
    },
  },
  {
    // Opus reviews what each pipeline merge landed; reads only, so it needs no repo approval.
    name: "postmerge",
    perRepo: true,
    detect: (db, { tracked }) => tracked.filter((repo) => selectPostmerge(db, repo).length).sort().map((repo) => ({ step: "postmerge", params: { repo } })),
  },
  {
    // The defects of those reviews become issues in repos approved for comments.
    name: "postmerge-file",
    perRepo: true,
    detect: (db, { tracked }) => tracked.filter((repo) => commentApprovalOf(db, repo) && pendingDefects(db, repo).length).sort().map((repo) => ({ step: "postmerge-file", params: { repo } })),
  },
  {
    // A red default branch in a repo approved for it: flaky failures are rerun once, infrastructure failures become a decision, code failures are recorded.
    name: "main-fix",
    perRepo: true,
    // A rerun waits for the next reading of the head or a time limit; the clock moves with no change in the data.
    extra: (db) => {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM main.main_fixes WHERE state = 'rerun-requested'").get() as { n: number }).n;
      return n ? `${n}:${Math.floor(Date.now() / 300_000)}` : "";
    },
    detect: (db, { tracked }) => tracked.filter((repo) => mainFixDue(db, repo)).sort().map((repo) => ({ step: "main-fix", params: { repo } })),
  },
];

export const LANES: Lane[] = buildLanes(LANE_CODE);

/** Every registry lane needs its code and every code entry a registry lane; a mismatch is a programming error. */
export function buildLanes(code: Omit<Lane, "steps">[]): Lane[] {
  const reg = lanesInOrder();
  const names = new Set(reg.map((l) => l.name));
  const missing = reg.filter((l) => !code.some((c) => c.name === l.name)).map((l) => l.name);
  const extra = code.filter((c) => !names.has(c.name)).map((c) => c.name);
  if (missing.length || extra.length) throw new Error(`autopilot lanes and the stage registry differ: no detect for [${missing}], no registry lane for [${extra}]`);
  return reg.map((l) => ({ ...code.find((c) => c.name === l.name)!, steps: l.steps }));
}

// ---- limits and usage ----------------------------------------------------------

export const dayStart = (ms: number = Date.now()): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

type LimitRow = { step: string; per_day: number | null; updated_by: string | null; updated_at: string | null };

/** Daily limits that apply until an operator sets one. */
export const DEFAULT_PER_DAY: Record<string, number> = defaultPerDay();

export const limitRow = (db: DatabaseSync, step: string): LimitRow =>
  (db.prepare("SELECT * FROM stage_limits WHERE step = ?").get(step) as LimitRow | undefined) ?? { step, per_day: DEFAULT_PER_DAY[step] ?? null, updated_by: null, updated_at: null };

/** Items handled by the step's jobs that started today (UTC) and after the operator's last reset of its count. */
export function usageToday(db: DatabaseSync, step: string, ms: number = Date.now()): number {
  const day = dayStart(ms), reset = getSetting(db, KEY_RESET + step);
  return (db.prepare("SELECT COALESCE(SUM(items), 0) AS n FROM jobs WHERE step = ? AND started_at >= ?").get(step, reset && reset > day ? reset : day) as { n: number }).n;
}

/** The steps an operator release (operator-actions.ts) hands new work to. */
const RELEASE_STEPS: Record<string, string[]> = {
  "batch-again": ["merge"], "review-again": ["opus-review"], "verify-again": ["verify"], "fix-again": ["fixissue"],
};

/** When an operator last released work for the step, or null. */
function releasedAt(db: DatabaseSync, step: string): string | null {
  const actions = Object.keys(RELEASE_STEPS).filter((a) => RELEASE_STEPS[a]!.includes(step));
  if (!actions.length) return null;
  return (db.prepare(`SELECT MAX(at) AS at FROM audit WHERE action IN (${actions.map(() => "?").join(", ")})`).get(...actions) as { at: string | null }).at;
}

/** Minutes-long wait after `failures` failed jobs in a row: 1, 2, 4, 8, 16 minutes, then 30. */
export const failureDelayMs = (failures: number): number => Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

/**
 * Failed autopilot jobs of the step (of the repo, when given) since its last success: when it may run again, else null.
 * An operator release since the last failure ends it. After a single failure, so does a changed input (`fp` given and
 * different from the one the failed job saw); later failures wait out the backoff, because inputs that change every
 * minute would otherwise retry a failing step at once, every time. Jobs a runner restart ended do not count.
 */
export function failureBackoff(db: DatabaseSync, step: string, ms: number = Date.now(), o: { repo?: string | null; fp?: string } = {}): { until: number; failures: number } | null {
  const rows = db.prepare(`SELECT id, state, ended_at FROM jobs WHERE step = ? AND (? IS NULL OR repo = ?) AND requested_by = ? AND state IN ('done', 'failed')
    AND COALESCE(error, '') <> ? ORDER BY id DESC LIMIT 12`).all(step, o.repo ?? null, o.repo ?? null, AUTOPILOT_USER, RUNNER_STOPPED) as { id: number; state: string; ended_at: string | null }[];
  let failures = 0;
  while (failures < rows.length && rows[failures]!.state === "failed") failures++;
  if (!failures || !rows[0]!.ended_at) return null;
  const released = releasedAt(db, step);
  if (released && released > rows[0]!.ended_at) return null;
  if (o.fp !== undefined && failures === 1) {
    const rec = fpRecord(db, step, o.repo ?? null);
    if (rec && rec.job === rows[0]!.id && rec.fp !== o.fp) return null;
  }
  const until = Date.parse(rows[0]!.ended_at) + failureDelayMs(failures);
  return until > ms ? { until, failures } : null;
}

export const backoffUntil = (db: DatabaseSync, step: string, ms: number = Date.now()): number | null => failureBackoff(db, step, ms)?.until ?? null;

const hhmm = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the stage cannot start jobs now, or null. The one place a stage's pause is decided. A step's models are taken at their defaults. */
export function pauseReason(db: DatabaseSync, step: string, ms: number = Date.now(), o: { backoff?: boolean } = {}): string | null {
  const l = limitRow(db, step), used = usageToday(db, step, ms);
  if (l.per_day === 0) return "paused: the daily limit is 0";
  if (l.per_day !== null && used >= l.per_day) return `daily limit of ${l.per_day} items reached; resumes at 00:00 UTC`;
  const b = o.backoff === false ? null : failureBackoff(db, step, ms);
  if (b !== null) return `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row; retry at ${hhmm(b.until)}`;
  // Steps that call Claude (decide, opus-review, the Haiku part of classify-new) wait for an account with headroom.
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
export const LIMIT_STEPS = limitSteps();

/** Steps whose jobs cannot be sized to what remains of the day: only no limit or a pause makes sense. */
export const ZERO_ONLY = zeroOnlySteps();

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

/** Starts today's count of one step (or of all) again from zero. */
export function resetLimitCount(db: DatabaseSync, step: unknown, by: string): { steps: string[] } {
  const steps = step === "all" ? LIMIT_STEPS : typeof step === "string" && LIMIT_STEPS.includes(step) ? [step] : null;
  if (!steps) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  const at = now();
  for (const st of steps) setSetting(db, KEY_RESET + st, at);
  audit(db, by, "limit-reset", step === "all" ? "step:all" : `step:${step}`, { steps });
  return { steps };
}

/** What a stage is doing now: running, queued, or why it is not (the planner's last reading); null when unknown. */
function stepStatus(db: DatabaseSync, step: string, why: string | undefined): string | null {
  const j = db.prepare("SELECT state FROM jobs WHERE step = ? AND state IN ('running', 'queued') ORDER BY state = 'running' DESC LIMIT 1").get(step) as { state: string } | undefined;
  if (j) return j.state;
  return why ?? null;
}

export async function stageLimits(db: DatabaseSync): Promise<StageLimit[]> {
  const steps = await loadSteps();
  const why = stageStatus(db);
  return LIMIT_STEPS.map((step) => {
    const l = limitRow(db, step);
    return { step, title: steps.get(step)?.title ?? step, perDay: l.per_day, usedToday: usageToday(db, step), pausedReason: pauseReason(db, step), status: stepStatus(db, step, why[step]) };
  });
}

export async function pipelineState(db: DatabaseSync): Promise<PipelineState> {
  return {
    enabled: isEnabled(db), changedBy: getSetting(db, KEY_BY), changedAt: getSetting(db, KEY_AT),
    heartbeat: getSetting(db, "runner_heartbeat"), limits: await stageLimits(db), pilot: pilotItems(db),
  };
}

// ---- planner -------------------------------------------------------------------

export type PlanOptions = { lanes?: Lane[]; nowMs?: number; log?: (line: string) => void };

/** A job the detection pass wants queued; `params` include the `limit` the gate set. */
export type Proposal = { lane: string; step: string; params: Params; fp?: string; gate?: { step: string; params: Params } };
/** `wakeAt`: when a wait the pass found ends (ms), null when none. `status`: why each stage without a proposal is not starting. */
export type Detected = { proposals: Proposal[]; logs: string[]; wakeAt?: number | null; status?: Record<string, string> };

/** The most proposals one lane hands to apply, in case the first ones are refused at enqueue. */
const PROPOSALS_PER_LANE = 3;

const nextUtcMidnight = (ms: number): number => Date.parse(dayStart(ms)) + 86_400_000;

/**
 * Detection: reads the database and returns, per lane, the candidates whose step is idle, not backing off,
 * not unchanged since a job that handled nothing, and has limit left. Writes nothing, so the runner can do
 * it on another connection while it keeps polling; applyProposals() queues the result.
 */
export async function detectAutopilot(db: DatabaseSync, opts: PlanOptions = {}): Promise<Detected> {
  const lanes = opts.lanes ?? LANES, ms = opts.nowMs ?? Date.now();
  const logs: string[] = [];
  const log = (l: string) => { logs.push(l); opts.log?.(l); };
  const steps = await loadSteps();
  const proposals: Proposal[] = [];
  const ctx = planCtx(db);
  const scope = scopeRepos(db);
  const seqs = readSeqs(db);
  const status: Record<string, string> = {};
  // Pause and limit do not change during the pass: one answer per step.
  const paused = new Map<string, string | null>();
  const limitLeft = new Map<string, { limit?: number } | null>();

  const pausedWhy = (stepName: string): string | null => {
    if (!paused.has(stepName)) {
      const why = pauseReason(db, stepName, ms, { backoff: false });
      paused.set(stepName, why);
      if (why) ctx.wake?.push(/daily limit/.test(why) ? nextUtcMidnight(ms) : ms + 60_000);
    }
    return paused.get(stepName)!;
  };
  const note = (stepName: string, why: string) => { status[stepName] ??= why; };

  /**
   * The job's `limit` (undefined when the step has none), or null when it cannot start now. With `lane`, the
   * input checks apply too: failure backoff and "nothing changed since a job that handled nothing".
   */
  const gate = (stepName: string, params: Params, lane?: Lane, poll = false): { limit?: number } | null => {
    const step = steps.get(stepName);
    if (!step) return null;
    if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(stepName)) return null;
    const reason = pausedWhy(stepName);
    if (reason) { note(stepName, reason); return null; }
    if (lane) {
      const repo = typeof params.repo === "string" ? params.repo : null;
      const fp = fingerprintOf(db, lane, stepName, params, seqs);
      const b = failureBackoff(db, stepName, ms, { repo, fp });
      if (b) {
        ctx.wake?.push(b.until);
        note(stepName, `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row; retry at ${hhmm(b.until)}`);
        const key = `${stepName}:${b.until}`;
        if (!warned.has(key)) { warned.add(key); log(`autopilot: ${stepName}: failed ${b.failures} times in a row; retry at ${hhmm(b.until)}`); }
        return null;
      }
      if (!poll && unchangedSinceIdle(db, stepName, repo, fp)) { note(stepName, "nothing to do: its input has not changed since the last run"); return null; }
      if (lane.minGapMs) {
        const last = lastJobEnd(db, stepName, repo, AUTOPILOT_USER);
        const next = last ? Date.parse(last.endedAt) + lane.minGapMs : 0;
        if (next > ms) { ctx.wake?.push(next); return null; }
      }
    }
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

  const tops = new Map<string, number | null>();
  for (const lane of lanes) {
    if (!lane.topScore) continue;
    try { tops.set(lane.name, lane.topScore(db, ctx)); } catch (e) { log(`autopilot: ${lane.name}: ${(e as Error).message}`); }
  }
  for (const lane of orderLanes(lanes, tops)) {
    try {
      // A lane whose steps cannot start is not worth detecting.
      if (lane.steps && !lane.steps.some((s) => gate(s, {}))) continue;
      const candidates = lane.detect(db, ctx);
      if (!candidates.length) { for (const s of lane.steps ?? []) note(s, "nothing to do"); continue; }
      let taken = 0;
      for (const c of candidates) {
        const outside = [c, c.gate].find((x) => x && typeof x.params.repo === "string" && !scope.has(x.params.repo));
        if (outside) { note(outside.step, "outside the pipeline scope"); continue; }
        if (c.gate && !gate(c.gate.step, c.gate.params, lane, c.gate.poll)) continue;
        const g = gate(c.step, c.params, lane, c.poll);
        if (!g) continue;
        const params: Params = { ...c.params, ...(g.limit === undefined ? {} : { limit: g.limit }) };
        proposals.push({ lane: lane.name, step: c.step, params, fp: fingerprintOf(db, lane, c.step, c.params, seqs), ...(c.gate ? { gate: c.gate } : {}) });
        if (++taken >= PROPOSALS_PER_LANE) break;
      }
    } catch (e) {
      log(`autopilot: ${lane.name}: ${(e as Error).message}`);
    }
  }
  // A stage with a candidate the checks above held back says why; the others had no candidate or start now.
  Object.assign(status, ctx.notes ?? {});
  for (const p of proposals) delete status[p.step];
  const wakes = (ctx.wake ?? []).filter((t) => t > ms);
  return { proposals, logs, wakeAt: wakes.length ? Math.min(...wakes) : null, status };
}

/** True when the last autopilot job of the step (and repo) handled nothing and saw the input `fp` still describes. An operator release since then ends it. */
function unchangedSinceIdle(db: DatabaseSync, step: string, repo: string | null, fp: string): boolean {
  const last = lastJobEnd(db, step, repo, AUTOPILOT_USER);
  if (!last || last.state !== "done" || !wasIdle(last)) return false;
  const rec = fpRecord(db, step, repo);
  if (!rec || rec.job !== last.id || rec.fp !== fp) return false;
  return !((releasedAt(db, step) ?? "") > last.endedAt);
}

const warned = new Set<string>();

/** Queues the proposals: per lane the first one that is accepted. Returns the queued job ids. */
export async function applyProposals(db: DatabaseSync, proposals: Proposal[], opts: PlanOptions & { wakeAt?: number | null; status?: Record<string, string> } = {}): Promise<number[]> {
  const lanes = opts.lanes ?? LANES, log = opts.log ?? (() => {});
  const queued: number[] = [];
  const done = new Set<string>();
  try { applyUsedAnswers(db); } catch (e) { log(`autopilot: answers: ${(e as Error).message}`); }
  // Marks the next planner pass wants: when a wait ends, and why stages are not starting.
  if (opts.wakeAt) setSetting(db, KEY_WAKE_AT, new Date(opts.wakeAt).toISOString());
  else db.prepare("DELETE FROM settings WHERE key = ?").run(KEY_WAKE_AT);
  if (opts.status) setSetting(db, KEY_STATUS, JSON.stringify(opts.status));
  for (const p of proposals) {
    if (done.has(p.lane)) continue;
    try {
      // The detection ran a moment ago: a job of the same step may have been queued since.
      if (db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(p.step)) continue;
      const job = await enqueue(db, p.step, p.params, AUTOPILOT_USER);
      queued.push(job.id);
      done.add(p.lane);
      if (p.fp !== undefined) setSetting(db, fpKey(p.step, typeof p.params.repo === "string" ? p.params.repo : null), JSON.stringify({ job: job.id, fp: p.fp } satisfies FpRecord));
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
  const found = await detectAutopilot(db, opts);
  return applyProposals(db, found.proposals, { ...opts, wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) });
}

/** What the planner's marks say about the content stages read and the limits that apply to them. */
function inputSignature(db: DatabaseSync): string {
  const seqs = readSeqs(db);
  return [...INPUT_TOPICS.map((t) => seqs[t] ?? 0), limitsSig(db), tasksSig(db)].join(",");
}

/**
 * Whether the planner is due now: a content topic changed, an autopilot job finished, an operator released
 * work, a wait the last pass found has ended, or the fallback timer ran out. Moves the planner's marks when
 * it is, so the caller must then plan.
 */
export function planDue(db: DatabaseSync, nowMs: number = Date.now()): boolean {
  if (!isEnabled(db)) return false;
  const t = nowMs;
  const sig = inputSignature(db);
  const changed = sig !== (getSetting(db, KEY_SEQS_SEEN) ?? "");
  const plannedAt = getSetting(db, KEY_PLANNED_AT);
  const planned = plannedAt === null ? 0 : Date.parse(plannedAt);
  const wake = getSetting(db, KEY_WAKE_AT);
  const finished = db.prepare("SELECT 1 FROM jobs WHERE requested_by = ? AND ended_at > ?").get(AUTOPILOT_USER, plannedAt ?? "");
  const released = db.prepare(`SELECT 1 FROM audit WHERE action IN (${Object.keys(RELEASE_STEPS).map(() => "?").join(", ")}) AND at > ?`)
    .get(...Object.keys(RELEASE_STEPS), plannedAt ?? "");
  const woken = wake !== null && Date.parse(wake) <= t;
  if (!changed && plannedAt !== null && t - planned < PLAN_EVERY_MS && !finished && !released && !woken) return false;
  setSetting(db, KEY_SEQS_SEEN, sig);
  setSetting(db, KEY_PLANNED_AT, new Date(t).toISOString());
  return true;
}

/** One planner pass on this connection when due (tests and the CLI; the runner detects on a worker thread). */
export async function autopilotTick(db: DatabaseSync, opts: PlanOptions = {}): Promise<number[]> {
  return planDue(db, opts.nowMs) ? planAutopilot(db, opts) : [];
}

/** Why each stage is not starting, as the last planner pass saw it; keyed by step. */
export function stageStatus(db: DatabaseSync): Record<string, string> {
  try { return JSON.parse(getSetting(db, KEY_STATUS) ?? "{}") as Record<string, string>; } catch { return {}; }
}
