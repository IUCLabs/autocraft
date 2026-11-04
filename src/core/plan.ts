// The vocabulary of a Plan: what state an item is in and which actions are due. No imports: the web build may use it.

/** Queue states of PRs that have a take or take-fix review at their current head (the merge queue's list). */
export const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "waiting-premerge", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "declined", "merged", "held-duplicate", "held-backlog",
  "batch-checking", "in-batch", "batch-failed", "ci-approval", "changes-requested", "waiting-main-ci",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** States of open PRs outside the merge queue. */
export const OTHER_PR_STATES = [
  "out-of-scope", // repo pipeline off or not a pilot item, and not fast-tracked
  "integration", // an integration batch PR the pipeline opened itself
  "backlog", // a Backlog answer holds it (no take review at its head)
  "duplicate", // a duplicate decision holds it (no take review at its head)
  "draft", // a draft, or closed on GitHub, with no take review
  "opus-hold", // the review at the head says hold
  "opus-close", // the review at the head says close
  "review-stale", // reviewed, but the head moved or the discussion moved on: due a new review
  "label-not-reviewed", // its settled label is not one that gets a code review
  "scope", // waits for a scope answer (or the answer keeps it out of core)
  "not-reviewed", // no review yet: due a review
  "closed", // closed or merged on GitHub, outside the merge queue (post-merge review only)
] as const;

export const PLAN_STATES = [...QUEUE_STATES, ...OTHER_PR_STATES] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export type ActionKind =
  | "review" | "post-review" | "verify" | "approve-ci" | "premerge" | "ask-merge" | "merge"
  | "fixup" | "conflict" | "cifix" | "postmerge";

export type Action = { kind: ActionKind; head: string | null; params?: Record<string, unknown> };

export type Plan = {
  repo: string; number: number; head: string | null;
  state: PlanState;
  /** How it may merge. */
  path: "rule" | "operator" | null;
  /** Why it is outside the merge rule, in the queue's wording. */
  reasons: string[];
  note: string | null;
  /** Every action due now, in priority order. */
  actions: Action[];
  /** The conflict-handling note ("conflict: merging main"); apart from `note`, which is the queue's own. */
  conflictNote: string | null;
  /** What it waits on when no main-path action is due. */
  wait: string | null;
  /** The merge rule or an operator's answer lets it merge now (a refused PR still counts while its retry waits for a change). */
  eligible: boolean;
};

export const isQueueState = (s: PlanState): s is QueueState => (QUEUE_STATES as readonly string[]).includes(s);

// ---- facts of a PR ----------------------------------------------------------------------------------------------
// The type lives here, not in facts.ts, so that decide.ts can use it without reaching node:*. facts.ts re-exports it.

export type PrTier = "whitelisted" | "not" | "allow" | "deny";

/** The latest Opus review of the PR (newest `at`, then rowid; any verdict). */
export type ReviewFacts = {
  head: string;
  at: string;
  verdict: string;
  /** Unsure at this head or anywhere in the chain of heads AutoCraft pushed it from: only an operator's Merge answer given after this review lets it merge. */
  unsure: boolean;
  mode: string | null;
  reason: string;
  /** Number of fixes the review lists. */
  fixes: number;
  /** The discussion moved on after the review read it, or an operator marked it stale (no daily cap). */
  stale: boolean;
  /** `stale` as the Review step counts it: a PR at its daily cap of discussion-triggered re-reviews is not due again. */
  staleActionable: boolean;
};

export type PrFacts = {
  repo: string; number: number;
  /** Time of the decision, ms. */
  now: number;
  /** GitHub state as mirrored. */
  ghState: "OPEN" | "MERGED" | "CLOSED";
  /** The PR's current head commit (checks fetched after the mirror's last update win over the mirror). */
  head: string | null;
  /** A draft, or not open on GitHub, as the freshest of mirror and checks says. */
  draft: boolean;
  author: string | null;
  authorIsPipeline: boolean;
  tier: PrTier;
  lines: number;
  size: "S" | "M" | "L";
  /** Settled label of the current classification run. */
  label: string | null;
  needsDecisionFlag: boolean;
  /** The answer of the latest answered scope decision about the PR (a batch decision applies to its items). */
  scopeAnswer: string | null;

  // scope
  /** In scope: fast-tracked, or its repo's Pipeline switch is on and, with a pilot set, it is a pilot item. */
  inScope: boolean;
  /** An integration batch PR the pipeline opened itself. */
  integration: boolean;
  /** Any merge batch's own PR (without the author check). */
  batchPr: boolean;
  heldBacklog: boolean;
  /** Held by a duplicate decision (pair or group), not counting a Backlog answer. */
  heldDuplicate: boolean;
  /** An operator holds its merge. */
  mergeHeld: boolean;
  fast: boolean;
  /** Fast-track score, else the rank score; null when unranked. Lanes order by it, highest first, then by number. */
  score: number | null;
  repoFacts: {
    mergeApproved: boolean; pushApproved: boolean; commentApproved: boolean; ciApproved: boolean;
    /** The repo has no CI at all. */
    noCi: boolean;
    /** The default branch's CI is red. */
    mainRed: boolean;
  };

  review: ReviewFacts | null;
  /** Posting the review: whether there is public text (or an earlier post to edit), and our earlier post. */
  post: { postable: boolean; posted: { head: string | null; at: string | null; opusAt: string | null } | null };

  // checks at the reviewed head
  /** The checks were fetched for the reviewed head. */
  checksHere: boolean;
  /** At the reviewed head: the checks say open and not a draft. */
  checksOpen: boolean;
  /** CI at the reviewed head with optional checks applied; "pending" while approved runs have not finished; "unknown" when the checks are of another head. */
  ci: string;
  mergeable: string;
  /** Workflow runs waiting for approval at the head the checks describe (for an integration PR: at the batch tip). */
  runs: { waiting: number; reread: boolean; crossRepo: boolean; approvable: number } | null;

  /** The latest merge attempt at the reviewed head. */
  lastMerge: { outcome: string; reason: string | null; ci: string | null; mergeable: string | null } | null;
  /** Runs were approved after that attempt. */
  runsApprovedAfterMerge: boolean;
  verification: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  /** Why Verify cannot build the repo (private, not Rust without CI), or null. */
  verifyUnavailable: string | null;

  decision: {
    /** A Merge? question exists at the reviewed head. */
    asked: boolean;
    /** An unanswered Merge? question exists at any head. */
    openQuestion: boolean;
    /** The operator answer at the reviewed head that counts (not yet applied, not Backlog). */
    answer: string | null;
    /** The operator's Merge answer was given after the review's `at`. */
    mergeAnswerAfterReview: boolean;
    /** Member of an open duplicate group (asked after the group is answered). */
    inOpenGroup: boolean;
  };

  /** The pre-merge review row at the reviewed head. */
  premerge: { at: string; tries: number; hasFindings: boolean; defects: number; defectsAllFixable: boolean; /** Every defect's fix names a safe path, so a fix-up can apply them. */ fixesSafe: boolean; minor: number; error: string | null } | null;
  premergeFixUsed: boolean;
  /** The PR's head branch may be pushed to (source of the maintainer flag follows `checksHere`). */
  pushable: boolean;
  /** Heads the PR was pushed from by AutoCraft, newest first, starting with the reviewed head. */
  pushChain: string[];
  /** For a conflicting open PR: what fix-up does and the base branch. */
  conflict: { bucket: string; base: string; /** The base branch name is one fix-up may merge. */ baseOk: boolean } | null;
  /** Member of a merge batch that is checking or open, at any head. */
  inActiveBatch: boolean;
  /** Fix-up of a take-fix review at the current head: its usable fixes, the tries used and the final rows recorded at the head (fixups.state, no source). */
  fixup: { fixes: number; attempts: number; recorded: string[] } | null;
  /** Queued carry-over jobs of the duplicate groups (one per group decision) whose closed PRs left points to carry: tries used. */
  carry: { attempts: number }[];
  /** CI fix state at the reviewed head, loaded while CI fails. */
  cifix: {
    /** ci_fixes states at the head, oldest first. */
    states: string[]; tries: number; rerunAt: string | null; infraRuns: number[] | null;
    formattingTask: number | null; formatterEnded: boolean;
    totalPushes: number; totalTries: number;
    /** When the checks were fetched (ISO). */
    checksAt: string | null;
  } | null;
  /** The pipeline merged the PR: when, and what the stored post-merge review looks like. */
  postmerge: { mergedAt: string; head: string | null; since: string; review: { at: string; error: string | null } | null } | null;
  /** The batch the reviewed head is in. */
  batch: "batch-checking" | "in-batch" | "batch-failed" | null;
  /** The PR is one AutoCraft opened to fix main CI. */
  mainFix: boolean;
  /** A maintainer's formal block: why, and whether from a live read. */
  changesRequested: { why: string; live: boolean } | null;
  /** The note when live review reads failed several times in a row. */
  gateFailureNote: string | null;
};
