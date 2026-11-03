// Wire types for the dashboard API. They mirror the server's tables
// (docs/dashboard-spec.md, Data) in camelCase.

export type RepoName = string;

export interface ItemRef {
  repo: RepoName;
  number: number;
}

export type DecisionKind = "scope" | "duplicate" | "close" | "merge" | "split" | "other";

export interface DecisionOption {
  key: string;
  label: string;
  /** One short line shown under the label on wide layouts. */
  hint?: string;
  /** What picking this option does on GitHub, e.g. "closes the PR on GitHub"; absent when it writes nothing. */
  writes?: string;
}

export type Relation = "duplicate-of" | "duplicated-by" | "links" | "overlaps" | "fixes";

export interface RelatedItem extends ItemRef {
  relation: Relation;
  title: string;
  state: ItemState;
}

export type Classifier = "haiku" | "jev" | "sonnet" | "owner";
export type TypeLabel = "bugfix" | "performance" | "missing feature" | "small extra" | "plugin candidate" | "infra";
export type Want = "yes" | "no" | "unclear";

export interface Classification {
  classifier: Classifier;
  at: string;
  typeLabel: TypeLabel;
  want: Want;
  reference: string | null;
  topics: "1" | "many";
  area: string;
  reason: string;
  dupOf: number | null;
}

export interface Claim {
  login: string;
  since: string;
}

/**
 * A non-binding pick by anyone signed in. Shown to people with the giver's GitHub
 * permission on the repo; never read by the pipeline. The operator can adopt it.
 */
export interface Opinion {
  id: string;
  login: string;
  /** option key, or null for a note without a pick */
  option: string | null;
  note: string | null;
  at: string;
  permission: "write" | "none";
}

export interface Decision {
  id: string;
  kind: DecisionKind;
  repo: RepoName;
  /** null for a batch */
  number: number | null;
  items: (ItemRef & { title: string })[];
  title: string;
  question: string;
  /** AI summary of the item or batch, 2–6 sentences. */
  summary: string;
  summaryBy: string;
  summaryAt: string;
  /** The issue or PR description (GitHub-flavoured Markdown); null for a batch. */
  body: string | null;
  context: string[];
  facts: string[];
  options: DecisionOption[];
  recommended: string;
  publicText: string | null;
  askedAt: string;
  askedBy: string;
  docket: string | null;
  answer: string | null;
  answerNote: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  appliedAt: string | null;
  /** The opinion the operator adopted as the answer, if any. */
  adoptedOpinion: Opinion | null;
  opinions: Opinion[];
  exceptions: (ItemRef & { answer: string })[];
  claim: Claim | null;
  commentCount: number;
  related: RelatedItem[];
  classifications: Classification[];
  /** null or absent for a batch and before the item was rated. */
  priority?: PriorityInfo | null;
}

export interface DecisionComment {
  id: string;
  login: string;
  at: string;
  body: string;
}

export type ItemState = "open" | "merged" | "closed";
export type CiState = "passing" | "failing" | "pending" | "none";
export type Mergeable = "clean" | "conflicts" | "unknown";
export type Tier = "whitelisted" | "not" | "override-allow" | "override-deny";
export type Stage =
  | "classified"
  | "reviewed"
  | "take"
  | "hold"
  | "close"
  | "needs-decision"
  | "batched"
  | "merged"
  | "closed"
  | "fixed-by-us"
  | "verify-planned"
  | "verify-ci-enough"
  | "verify-error"
  | "verify-unavailable"
  | "verified"
  | "verify-failed";

export interface StageEntry {
  stage: Stage;
  at: string;
  by: string;
  note: string | null;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/** A GitHub comment or review on an item, from the mirror. Untrusted text: render as Markdown, never as HTML. */
export interface ItemComment {
  id: string;
  author: string;
  at: string;
  body: string;
  kind: "comment" | "review";
  /** reviews: APPROVED | CHANGES_REQUESTED | COMMENTED */
  reviewState: string | null;
}

/** Priority level, P0 (critical) to P4 (backlog). */
export type PriorityLevel = "P0" | "P1" | "P2" | "P3" | "P4";

/** Priority level of an item (src/priority). `model`: jev, haiku or jev-unsure. */
export interface PriorityInfo {
  level: PriorityLevel;
  model: string;
  reason: string | null;
}

export interface Item extends ItemRef {
  kind: "pr" | "issue";
  title: string;
  body: string;
  state: ItemState;
  author: string;
  tier: Tier;
  authorMerged: number;
  authorClosedUnmerged: number;
  additions: number;
  deletions: number;
  /** PRs: how many files the PR changes, from the mirror; null when unknown. */
  changedFiles: number | null;
  /** Per-file changes; empty when the mirror has none. */
  files: ChangedFile[];
  /** "none" also when the mirror has no check data for the item. */
  ci: CiState;
  ciChecks: { name: string; state: CiState; minutes: number }[];
  mergeable: Mergeable;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergedBy: string | null;
  related: RelatedItem[];
  classifications: Classification[];
  stages: StageEntry[];
  comments: ItemComment[];
  decisionIds: string[];
  /** For the latest classification run. */
  settled: Settled;
  /** PRs: the Verify stage's result for the newest head it looked at; null when none. */
  verification: ItemVerification | null;
  /** PRs: the Fix-up step's tries, oldest first. */
  fixups: ItemFixup[];
  /** Opus checks of the patches we wrote for this item (Fix-up, Fix), oldest first. */
  patchChecks?: ItemPatchCheck[];
  /** The Act step's GitHub writes after an operator's answer, oldest first. */
  actions: ItemAction[];
  /** Releases an operator can use on this item now (the item waits for a person). */
  releases: ItemReleases;
  /** null or absent before the item was rated. */
  priority?: PriorityInfo | null;
}

export type VerificationKind = "ci-enough" | "tests" | "regression" | "error" | "unavailable";
export type VerificationState = "planned" | "running" | "passed" | "failed" | "error" | "ci-enough" | "stale" | "unavailable";
export interface ItemVerification {
  headSha: string;
  baseSha: string | null;
  /** False when the PR has a newer head than the one verified. */
  current: boolean;
  kind: VerificationKind;
  reason: string;
  /** Crates and test filters (kind tests), or the crate and size of the added regression test. */
  plan: { crates: string[]; tests: string[]; testLines: number | null } | null;
  state: VerificationState;
  summary: string | null;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Head task first, then the base task of a regression. */
  tasks: { id: number; role: "head" | "base"; state: TaskState; results: TaskResult[]; endedAt: string | null }[];
}

export type FixupState = "pushed" | "failed" | "refused" | "cannot-push" | "too-large" | "asked" | "rejected";
/** The operator releases of an item: the last path segment of POST /api/items/:repo/:n/<action>. */
export type ReleaseAction = "review-again" | "verify-again" | "fix-again";

/** Operator releases that apply to an item right now. */
export interface ItemReleases {
  /** A hold review at the current head can be cleared so the head is reviewed again. */
  reviewAgain: boolean;
  /** A failed or errored verification at the current head can be planned again. */
  verifyAgain: boolean;
  /** A skipped or failed fix attempt can be tried again. */
  fixAgain: boolean;
}

export interface ItemPatchCheck {
  kind: "fixup" | "fixissue";
  /** The commit the patch applies to. */
  subject: string;
  patchHash: string;
  round: number;
  verdict: "approve" | "reject";
  reasons: string;
  problems: string[];
  model: string;
  createdAt: string;
}

export interface ItemFixup {
  fromHead: string;
  toHead: string | null;
  state: FixupState;
  reason: string | null;
  files: string[];
  attempt: number;
  createdAt: string;
}

export interface ItemAction {
  decisionId: string;
  kind: string;
  state: "done" | "skipped" | "failed";
  commentUrl: string | null;
  reason: string | null;
  createdAt: string;
}

/**
 * Settled type label for one classification run: Jev's label when its top
 * probability is at least 0.9, else Haiku's when Haiku agrees with Jev.
 * `waiting`: Jev unsure, Haiku hasn't answered; `disagree`: Haiku gave another label and the Sonnet referee is unsure or has not answered yet; a referee that is sure settles it.
 */
export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export interface Settled {
  status: SettledStatus;
  /** Set only when `status` is `settled`. */
  label: TypeLabel | null;
  source: "jev" | "haiku" | "sonnet" | null;
  /** Jev's top probability. */
  confidence: number | null;
  jevLabel: TypeLabel | null;
  haikuLabel: TypeLabel | null;
  /** Jev's flags when Jev is sure, otherwise every flag either classifier raised. */
  flags: string[];
  /** The Sonnet referee's answer to a Jev/Haiku disagreement; settles the item when `sure`, else a person decides. */
  referee: { label: TypeLabel; sure: boolean; reason: string } | null;
}

/** Where a text query matched. `text` marks each match with U+0002 before and U+0003 after it. */
export interface Snippet {
  field: "title" | "body" | "comment";
  /** The comment's author. */
  author: string | null;
  text: string;
}

export type ItemSort = "relevance" | "updated" | "created" | "number";

/** `status: "unsettled"` stands for waiting and disagree together. */
export type StatusFilter = SettledStatus | "unsettled";

export interface ItemFilter {
  /** Full-text query: words (all must match), "quoted phrases", prefix*, -excluded, OR. */
  q?: string;
  /** Only `text`; other search modes may be added. */
  mode?: "text";
  repo?: RepoName[];
  kind?: "pr" | "issue";
  /** Default `open`. */
  state?: ItemState | "all";
  /** Settled label. */
  label?: TypeLabel;
  status?: StatusFilter[];
  /** Every flag listed must be set. */
  flag?: string[];
  author?: string;
  /** Updated on or after this date (YYYY-MM-DD). */
  since?: string;
  /** A flowchart branch, `<node>.<branch>` (FlowNode.id, FlowBranch.id): only the items it counts. */
  flow?: string;
  /** Default `relevance` with a query, else `updated`. */
  sort?: ItemSort;
  /** Default true. */
  desc?: boolean;
  limit?: number;
  offset?: number;
  /** Classification run; default the latest. */
  run?: string;
}

export interface ItemListRow extends ItemRef {
  kind: "pr" | "issue";
  state: ItemState;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  settled: Settled;
  /** Latest pipeline stage. */
  stage: Stage | null;
  /** With a text query only. */
  snippet: Snippet | null;
}

export interface ItemList {
  total: number;
  rows: ItemListRow[];
  /** Matches per settled status, under every filter except `status`. */
  byStatus: Record<SettledStatus, number>;
  run: string | null;
}

export interface SearchHit extends ItemRef {
  kind: "pr" | "issue";
  title: string;
  author: string;
  state: ItemState;
}

export interface Done {
  mergedByPipeline: number;
  closedByPipeline: number;
  closedByOthers: number;
}

export interface Funnel {
  open: number;
  /** Settled type label (see `Settled`). */
  classified: number;
  /** Jev unsure, Haiku hasn't answered yet. */
  secondOpinion: number;
  /** Jev unsure and Haiku gave another label. */
  disagreement: number;
  reviewed: number;
  take: number;
  hold: number;
  close: number;
  waiting: number;
  batched: number;
}

export interface RepoProgress {
  repo: RepoName;
  funnel: Funnel;
  done: Done;
  decisionsOpen: number;
  /** open items at the end of each day since tracking began */
  openTrend: number[];
}

export interface Progress {
  /** When tracking began; done counts and trends start here. */
  trackingSince: string;
  now: string;
  funnel: Funnel;
  done: Done;
  /** items closed or merged per hour by anyone, oldest first, last 24 h */
  perHour: number[];
  /** the same, by the pipeline only */
  perHourPipeline: number[];
  decisionsOpen: number;
  decisionsAnsweredToday: number;
  repos: RepoProgress[];
}

export type Role = "operator" | "maintainer" | "viewer";

export interface User {
  login: string;
  role: Role;
  /** repos where GitHub grants write, maintain or admin */
  writeRepos: RepoName[];
  /** Deployment setting `maintainer_writes`, reserved: off here, and it has no effect in the UI. */
  maintainerWrites: boolean;
}

export interface DecisionFilter {
  repo?: RepoName[];
  kind?: DecisionKind[];
  /** minimum age in days */
  minAge?: number;
  mine?: boolean;
  /** "opinions": open decisions that have at least one opinion */
  status?: "open" | "opinions" | "answered";
  /** page size (server default 100, at most 500); `total` counts every match */
  limit?: number;
  /** the `next` of the previous page */
  after?: string;
  offset?: number;
}

export interface DecisionList {
  decisions: Decision[];
  total: number;
  byKind: Partial<Record<DecisionKind, number>>;
  oldestAskedAt: string | null;
  /** Cursor for the next page (`after`), or null on the last one. */
  next: string | null;
}

export interface AnswerInput {
  answer: string;
  note?: string;
  exceptions?: (ItemRef & { answer: string })[];
}

// ---- Contributors, Repos and Access (docs/dashboard-spec.md, Pages) ----

export type OverrideStatus = "allow" | "deny";

export interface WhitelistRule {
  minMerged: number;
  /** 0 to 1 */
  minRate: number;
}

export interface Contributor {
  login: string;
  /** Effective status: an override wins over the automatic tier. */
  tier: Tier;
  /** From merge history under the current rule, ignoring any override. */
  autoTier: "whitelisted" | "not";
  override: OverrideStatus | null;
  /** Operators only; absent for everyone else. */
  overrideNote?: string | null;
  overrideBy: string | null;
  overrideAt: string | null;
  merged: number;
  closedUnmerged: number;
  open: number;
  /** merged / (merged + closed unmerged); null with no finished PRs */
  mergeRate: number | null;
  lastMerge: string | null;
  repos: RepoName[];
}

export type ContributorSort = "login" | "tier" | "merged" | "closed" | "open" | "rate" | "last" | "repos";

export interface ContributorFilter {
  /** part of the login */
  q?: string;
  tier?: Tier;
  repo?: RepoName;
  sort?: ContributorSort;
  desc?: boolean;
  /** page size (server default 50, at most 500) and offset */
  limit?: number;
  offset?: number;
}

export interface ContributorList {
  rule: WhitelistRule;
  /** rows matching every filter */
  total: number;
  /** authors matching `q` and `repo`, per effective tier (before the tier filter) */
  byTier: Record<Tier, number>;
  contributors: Contributor[];
}

/** What a whitelist rule would do, before it is saved. Counts are of every author. */
export interface RulePreview {
  rule: WhitelistRule;
  authors: number;
  /** allowed under the current rule: whitelisted by the rule or by an allow override */
  allowedNow: number;
  allowedAfter: number;
  /** status changes; overrides never change; at most 20 logins each, most merged first */
  gained: { count: number; logins: string[] };
  lost: { count: number; logins: string[] };
}

export interface OverrideInput {
  /** null clears the override */
  status: OverrideStatus | null;
  /** private note, at most 300 characters */
  note?: string;
}

/** The Label stage for one repo: approval and what the plan holds. */
export interface RepoApproval {
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface RepoLabels {
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  /** open items that would get labels */
  toAdd: number;
  /** open items with nothing to add: already labelled or not settled */
  skipped: number;
  /** open items with a different type label set by a person */
  conflicts: number;
}

export interface TrackedRepo {
  name: RepoName;
  tracked: boolean;
  openPrs: number | null;
  openIssues: number | null;
  /** issue and PR rows in the mirror */
  mirrored: number;
  syncedAt: string | null;
  /** null for repos that are not tracked */
  labels: RepoLabels | null;
  /** Whether the pipeline may merge pull requests here; null for repos that are not tracked */
  merging: RepoApproval | null;
  /** Whether the Fix-up step may push to contributor branches here; null for repos that are not tracked */
  pushing: RepoApproval | null;
  /** Whether the Act step may comment on and close items here; null for repos that are not tracked */
  commenting: RepoApproval | null;
  /** Fix issues: pushes to the pipeline's fork and opens PRs and comments for issue fixes. */
  fixing: RepoApproval | null;
}

export interface AccessEntry {
  login: string;
  role: Role;
  addedBy: string | null;
  addedAt: string | null;
  note: string | null;
  /** active sessions */
  sessions: number;
}

export interface SessionInfo {
  id: number;
  login: string;
  createdAt: string;
  lastSeen: string;
  expiresAt: string;
  userAgent: string | null;
  /** the session making this request */
  current: boolean;
}

export interface AccessOverview {
  entries: AccessEntry[];
  sessions: SessionInfo[];
}

export interface AuditEntry {
  at: string;
  login: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditFilter {
  /** the actor or the target */
  login?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

// ---- classifiers ----------------------------------------------------------

/** One run in which at least two classifiers judged the same items. */
export interface ClassifierRun {
  id: string;
  at: string;
  /** Pairs with items in both, `a` being the one with probabilities when only one has them. */
  pairs: { a: string; b: string; items: number }[];
}

export interface Agreement {
  n: number;
  agree: number;
}

export interface ConfidenceBand {
  /** Label such as "≥0.99" or "0.95–0.99". */
  band: string;
  n: number;
  agree: number;
  /** Items at or above this band's lower bound, and those that agree. */
  cumN: number;
  cumAgree: number;
}

export interface FlagAgreement {
  flag: string;
  n: number;
  agree: number;
  both: number;
  onlyA: number;
  onlyB: number;
}

export interface ClassifierReport {
  runs: ClassifierRun[];
  run: string;
  a: string;
  b: string;
  labels: string[];
  items: number;
  overall: Agreement;
  byKind: { pr: Agreement; issue: Agreement };
  /** Grouped by classifier `a`'s label. */
  byLabel: ({ label: string } & Agreement)[];
  byRepo: ({ repo: string } & Agreement)[];
  /** `confusion[i][j]`: `a` said labels[i], `b` said labels[j]. */
  confusion: number[][];
  /** Bands of classifier `a`'s top-label probability; empty when `a` recorded none. */
  bands: ConfidenceBand[];
  flags: FlagAgreement[];
}

export interface Disagreement {
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  a: { label: string | null; prob: number | null };
  b: { label: string | null; prob: number | null };
}

export interface DisagreementList {
  total: number;
  rows: Disagreement[];
}

export interface DisagreementFilter {
  run: string;
  a: string;
  b: string;
  /** Either classifier's label. */
  label?: string;
  /** A band label from `ClassifierReport.bands`. */
  band?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  /** every action the log knows, for the filter */
  actions: string[];
}

// ---- run and cost ---------------------------------------------------------

export interface UsageTotals {
  calls: number;
  items: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the costs agents reported; null when none did. */
  usd: number | null;
  /** First start to last end, in seconds. */
  wallSeconds: number;
}

export interface CostReport {
  runs: { id: string; from: string; to: string }[];
  /** A run id, or "" for all runs. */
  run: string;
  total: UsageTotals;
  /** Distinct items with a classification in the run (or all runs); `total.items` counts an item once per model. */
  itemsClassified: number;
  stages: ({ stage: string; model: string } & UsageTotals)[];
  repos: ({ repo: string } & UsageTotals)[];
  /** Spend per time bucket; `bucket` is an ISO hour or day. */
  series: { bucket: string; tokens: number; usd: number | null }[];
  bucketSize: "hour" | "day";
}

// ---- pipeline (runner jobs, steps, the on/off switch and stage limits) ------------------------------

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A step parameter. Only enums, tracked repos, bounded whole numbers and run ids: never free text. */
export type StepParam =
  | { name: string; label: string; help?: string; required: boolean; kind: "enum"; options: string[]; default?: string }
  | { name: string; label: string; help?: string; required: boolean; kind: "repo"; options: string[] }
  | { name: string; label: string; help?: string; required: boolean; kind: "int"; min: number; max: number; default?: number }
  | { name: string; label: string; help?: string; required: boolean; kind: "run-id"; default?: string };

export type JobParams = Record<string, string | number>;

export interface JobUsage {
  /** Model calls (token_usage rows) made by the job. */
  calls: number;
  input: number;
  output: number;
  /** Sum of reported costs; null when no call reported one. */
  costUsd: number | null;
}

export interface Job {
  id: number;
  step: string;
  params: JobParams;
  /** A login, `pipeline` (the autopilot) or `cli`. */
  requestedBy: string;
  requestedAt: string;
  state: JobState;
  startedAt: string | null;
  endedAt: string | null;
  progress: string | null;
  summary: string | null;
  error: string | null;
  cancelRequested: boolean;
  usage: JobUsage | null;
  /** Models the job's step uses, e.g. ["jev", "haiku"]; known before any call is made. */
  models: string[];
  /** Labels of the Claude accounts used by the job's agent runs, running or finished. */
  accounts: string[];
}

export interface JobDetail extends Job {
  /** The end of the job's log, with anything token-like replaced. */
  log: string;
  logTruncated: boolean;
}

export interface JobList {
  jobs: Job[];
  total: number;
}

export interface JobFilter {
  step?: string;
  state?: JobState;
  limit?: number;
  offset?: number;
}

export type StageLimit = { step: string; title: string; perDay: number | null; usedToday: number; pausedReason: string | null };
export type PipelineState = { enabled: boolean; changedBy: string | null; changedAt: string | null; heartbeat: string | null; limits: StageLimit[] };

export interface PipelineStep {
  name: string;
  title: string;
  description: string;
  stage: number;
  requires: "operator";
  group: string;
  params: StepParam[];
  /** null when the step can run; otherwise why not. */
  unavailable: string | null;
  lastJob: Job | null;
}

export interface PipelineStage {
  n: number;
  name: string;
  /** How the stage runs today. */
  mode: "automatic" | "steps" | "planned";
  steps: string[];
  state: "running" | "queued" | "ok" | "failed" | "idle" | "planned";
}

export interface SyncRun {
  startedAt: string;
  endedAt: string | null;
  mode: string | null;
  items: number | null;
  error: string | null;
}

export interface PipelineOverview {
  stages: PipelineStage[];
  steps: PipelineStep[];
  runner: { lastSeen: string | null; alive: boolean };
  sync: { lastFinishedAt: string | null; runs: SyncRun[] };
  counts: { queued: number; running: number };
}

// ---- prompts ----------------------------------------------------------------

/** One registered model prompt (src/prompts), as the Prompts page shows it. */
export interface PromptInfo {
  id: string;
  stage: string;
  purpose: string;
  /** The first is the default. */
  models: string[];
  runner: "claude" | "jev";
  /** The command line, as a shell would show it; the prompt or request goes on stdin. */
  command: string;
  settings: { label: string; value: string }[];
  /** Static text with `{{name}}` placeholders; for Jev, the request body. */
  template: string;
  placeholders: { name: string; meaning: string }[];
  /** Jev only: every question with its type and criteria. */
  questions: { id: string; type: string; instructions: string; criteria: Record<string, string> | null }[];
  output: string;
  validation: string;
  /** Exactly what would be sent for `exampleItems` (made-up items). */
  example: string;
  exampleItems: string[];
}

export interface PromptsReport {
  /** Git commit the server runs, or null when unknown. */
  commit: string | null;
  prompts: PromptInfo[];
  /** Comments the pipeline posts on GitHub; fixed text, no model. */
  comments: CommentTemplate[];
}

export interface CommentTemplate {
  id: string;
  stage: string;
  purpose: string;
  /** The text with `{{name}}` placeholders. */
  text: string;
  placeholders: { name: string; meaning: string }[];
  /** The text for made-up values. */
  example: string;
}

// ---- merge queue ------------------------------------------------------------

/**
 * Where a taken PR stands in the merge queue:
 * ready (may merge by the rule now), decision-answered-merge (the operator answered merge),
 * refused (the merge command or a pre-merge check said no; tried again next run),
 * waiting-ci (CI pending or none, or GitHub still computing mergeability), ci-failed, conflict,
 * needs-fix-up (take-fix), waiting-verify (no passed verification at the head yet), verify-failed, verify-error,
 * needs-decision (outside the rule; Merge? asked or about to be),
 * declined (the operator answered hold or close), merged,
 * held-duplicate (an open Duplicate? decision keeps it out of every later stage).
 */
export type QueueState =
  | "ready"
  | "decision-answered-merge"
  | "refused"
  | "waiting-ci"
  | "ci-failed"
  | "conflict"
  | "needs-fix-up"
  | "waiting-verify"
  | "verify-failed"
  | "verify-error"
  | "needs-decision"
  | "declined"
  | "merged"
  | "held-duplicate";

export interface QueueRow {
  repo: RepoName;
  number: number;
  title: string;
  author: string;
  tier: Tier;
  /** Head commit the review is for. */
  head: string;
  size: "S" | "M" | "L";
  label: TypeLabel | null;
  verdict: "take" | "take-fix";
  reason: string;
  fixes: number;
  /** CI at the reviewed head: success | failure | pending | none, or unknown before checks were fetched for it. */
  ci: "success" | "failure" | "pending" | "none" | "unknown";
  mergeable: Mergeable;
  state: QueueState;
  /** How it may merge: by the rule, by the operator's answer, or not yet. */
  path: "rule" | "operator" | null;
  /** Why the merge-without-asking rule doesn't cover it. */
  outsideRule: string[];
  decisionId: string | null;
  answer: string | null;
  refusedReason: string | null;
  reviewedAt: string;
  /** The Verify stage's result at the reviewed head; null when none. `summary` is the failure or error text, or the plan's reason. */
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
}

export interface QueueFilter {
  repo?: RepoName;
  /** "merged" lists merged PRs; without a state they are left out. */
  state?: QueueState;
  /** page size (server default 100, at most 500) and the `next` cursor of the previous page */
  limit?: number;
  after?: string;
}

export interface QueueList {
  rows: QueueRow[];
  /** Per state, for the repo filter (ignores the state filter). */
  counts: Record<QueueState, number>;
  /** Rows matching the filters, every page. */
  total: number;
  /** Cursor for the next page (`after`), or null on the last one. */
  next: string | null;
}

export interface WorkBreakdown {
  /** The level used for the order, after the security raise. */
  level: PriorityLevel;
  /** The stored level, null when the item has not been rated (P2 counts). */
  rated: PriorityLevel | null;
  security: boolean;
  type: string | null;
  size: "S" | "M" | "L" | "XL";
  /** lines (PR), triage (issue, from Fix triage) or default (not known yet). */
  sizeSource: "lines" | "triage" | "default";
  /** 0 to 99, breaks ties inside a level. */
  reach: number;
}

export interface WorkRow {
  repo: RepoName;
  number: number;
  kind: "pr" | "issue";
  title: string;
  /** Sort key (see src/rank/score.ts); for a tooltip only. */
  score: number;
  level: PriorityLevel;
  size: "S" | "M" | "L" | "XL";
  breakdown: WorkBreakdown;
  label: TypeLabel | null;
  /** The pipeline step the item waits for, in words. */
  next: string;
  /** App path of the list where a person resolves what the item waits for, or null. */
  nextHref: string | null;
}

export interface WorkFilter {
  repo?: RepoName;
  kind?: "pr" | "issue";
  limit?: number;
  offset?: number;
}

export interface WorkList {
  rows: WorkRow[];
  /** Open ranked items matching the filters, every page. */
  total: number;
  /** `offset` of the next page, or null on the last one. */
  next: number | null;
}

/** A search hit ranked by embedding similarity (`/api/similar`, `/api/search?mode=semantic`). */
export interface SimilarHit extends SearchHit {
  /** Cosine similarity of the two embeddings; near-duplicates score about 0.9 and up. */
  score: number;
  /** How a closed issue was closed. */
  stateReason: "completed" | "not-planned" | "duplicate" | null;
  /** The item's settled type label (see src/classify/settled.ts); null while unsettled. */
  label: string | null;
  labelBy: string | null;
}

// ---- flowchart (home page) ----------------------------------------------------

/** The nodes of the flowchart, in pipeline order (docs/pipeline.md). */
export type FlowNodeId = "synced" | "dupes" | "classify" | "priority" | "decide" | "labels" | "review" | "fix" | "fixup" | "verify" | "merge" | "act";

/** What items in a branch wait on: a model step, CI, a person, the runner (a step that needs no model), a build environment (a build task), or nothing. */
export type FlowWait = "model" | "ci" | "person" | "runner" | "sandbox" | "nothing";

/**
 * Where a branch's link goes. `items` opens the Items browser with these params
 * (`flow=<node>.<branch>` picks exactly the branch's items); `decisions`,
 * `queue` and `work` open those pages with these params.
 */
export interface FlowLink {
  page: "items" | "decisions" | "queue" | "work";
  params: Record<string, string>;
}

export interface FlowBranch {
  /** Unique within the node. */
  id: string;
  label: string;
  /** null where nothing is counted yet (a planned stage). */
  count: number | null;
  waitsOn: FlowWait;
  /** A person acts on the items here. */
  gate: boolean;
  tone: "ok" | "warn" | "bad" | "neutral" | "merged" | "accent";
  link: FlowLink | null;
  hint: string;
}

export interface FlowNode {
  id: FlowNodeId;
  title: string;
  /** Stage number in docs/pipeline.md. */
  stage: number;
  /** auto: runs on its own; steps: runner steps; gate: a person decides; planned: not built yet. */
  mode: "auto" | "steps" | "gate" | "planned";
  /** One line under the title, e.g. "21,310 open". */
  summary: string;
  /** Items in the node, where that is one number. */
  total: number | null;
  branches: FlowBranch[];
  /** Movement in the last 24 hours. */
  recent: { label: string; count: number }[];
  /** What the node waits on now: the waitsOn of its branches that hold items. */
  waitsOn: FlowWait[];
  /** Extra facts shown on the node, e.g. "Repos approved: 3 of 26". */
  facts: { label: string; value: string }[];
  /** Runner steps (src/runner/steps.ts) of the stage. */
  steps: string[];
  /** Prompt ids (src/prompts) the stage sends. */
  prompts: string[];
}

export interface FlowEdge {
  from: FlowNodeId;
  to: FlowNodeId;
  /** The branch of `from` the edge leaves from, if any. */
  branch: string | null;
  label: string;
  /** null on planned edges. */
  count: number | null;
}

export interface Flow {
  repo: RepoName | null;
  now: string;
  lastSync: string | null;
  /** When the counts were taken: the oldest of the per-repo summaries they add up. */
  countedAt: string | null;
  /** Tracked repos left out because they have no counts yet; the runner adds them within minutes. */
  uncounted: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---- Claude accounts, agent runs and rates -------------------------------------------------------------

export type AccountUsage = {
  fiveHourPct: number | null; fiveHourResetsAt: string | null;   // ISO
  weeklyPct: number | null; weeklyResetsAt: string | null;
  readAt: string | null;                                          // when the reading was taken
};
export type ClaudeAccount = {
  id: string;            // short key from the box config, e.g. "b"; never an email or path
  label: string;         // set by an operator; the only name the UI shows
  enabled: boolean;
  maxConcurrent: number; // agent runs at once on this account
  running: number;       // agent runs active now
  usage: AccountUsage;
  pausedReason: string | null; // e.g. "5-hour use 92 % (pauses at 90 %)"
};
export type AccountInput = { label?: string; enabled?: boolean; maxConcurrent?: number };

export type AgentRunState = "running" | "done" | "failed";
export type AgentRun = {
  id: number;
  jobId: number | null;
  step: string;              // runner step name
  stage: number;             // stage number from docs/pipeline.md
  promptId: string;          // prompt registry id
  promptVersion: string;     // registry version or content hash
  provider: "claude" | "jev";
  model: string;             // e.g. "sonnet", "haiku", "jev"
  accountId: string | null;  // null for Jev
  accountLabel: string | null;
  items: ItemRef[];          // at most 50
  itemCount: number;         // all items in the call
  state: AgentRunState;
  startedAt: string;
  endedAt: string | null;
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  summary: string | null;    // one line: verdict counts, error class
};
export type AgentRunDetail = AgentRun & {
  prompt: string | null;     // rendered prompt; null once past retention (14 days)
  output: string | null;     // raw model output, same retention
  error: string | null;
};
export type AgentRunPage = { runs: AgentRun[]; nextCursor: string | null };
export type AgentRunFilter = { state?: AgentRunState | "recent"; step?: string; account?: string; repo?: string; cursor?: string; limit?: number };

export type RateBucket = { t: string; items: number; runs: number; failed: number };
export type Rates = {
  window: "24h" | "7d"; bucket: "hour" | "day";
  stages: { step: string; title: string; buckets: RateBucket[] }[];
  accounts: { id: string; label: string; samples: { t: string; fiveHourPct: number | null; weeklyPct: number | null }[] }[];
};

// ---- Build environments and tasks -----------------------------------------------------------------------

export type Capabilities = {
  os: "linux" | "macos" | "windows";
  arch: "x86_64" | "aarch64";
  cpus: number; memGb: number; diskGb: number;
  display: boolean;          // can render UI (Xvfb or real) for screenshots
  gpu: boolean;
  toolchains: string[];      // e.g. ["rust-stable", "node-24"]
};
export type Requires = Partial<Pick<Capabilities, "os" | "arch" | "display" | "gpu">> & {
  toolchains?: string[]; minMemGb?: number; minDiskGb?: number;
};
export type EnvKind = "local-sandbox" | "remote";
export type BuildEnv = {
  id: string; label: string; kind: EnvKind;
  enabled: boolean; online: boolean; lastSeenAt: string | null;
  slots: number; running: number;
  capabilities: Capabilities | null;   // as last reported by the worker
  version: string | null;              // worker software version
  pausedReason: string | null;         // e.g. "disk 12 GB free (needs 20)"
};
export type EnvInput = { label?: string; enabled?: boolean; slots?: number };
export type EnvCreate = { id: string; label: string; kind: EnvKind; slots: number };
export type TaskStep = {
  name: string;                         // "fetch deps", "build", "test", "screenshot"
  cmd: string[];                        // argv, run inside the container
  network: "fetch" | "none";            // "fetch": registry/GitHub egress allowed; "none": no network
  timeoutSec: number;
  artifacts?: string[];                 // globs under /out to return
};
export type TaskState = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled" | "lost";
export type TaskResult = { step: string; exitCode: number | null; durationMs: number; timedOut: boolean };
export type TaskArtifact = { name: string; bytes: number; contentType: string };
export type BuildTask = {
  id: number; jobId: number | null; step: string;   // pipeline step that created it
  repo: RepoName; number: number | null;            // PR
  headSha: string; baseSha: string | null;
  requires: Requires; priority: number;
  plan: TaskStep[];
  state: TaskState; envId: string | null; envLabel: string | null;
  cancelRequested: boolean;
  queuedAt: string; claimedAt: string | null; startedAt: string | null; endedAt: string | null;
  heartbeatAt: string | null;
  results: TaskResult[];
  artifacts: TaskArtifact[];
  summary: string | null;
  /** Bytes of the unified diff applied to the checkout before the plan; null when the task has none. */
  patchBytes: number | null;
  /** Shared build cache: `build` fills it, `use` reads it. */
  warm: { key: string; role: "use" | "build" } | null;
};
/** Worker-sent text: shown as plain text only, never as markup. */
export type BuildTaskDetail = BuildTask & { logTail: string; logBytes: number; logTruncated: boolean; patch: string | null };
export type TaskFilter = { state?: TaskState | "active"; env?: string; repo?: string; cursor?: string; limit?: number };
export type TaskPage = { tasks: BuildTask[]; next: string | null };
/** Queued and running tasks and the slots left over the online, enabled environments (the flowchart's Verify node). */
export type BuildSummary = { queued: number; running: number; slots: number; free: number; online: number };
