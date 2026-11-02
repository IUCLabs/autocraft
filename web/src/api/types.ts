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
  | "fixed-by-us";

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
}

/**
 * Settled type label for one classification run: Jev's label when its top
 * probability is at least 0.9, else Haiku's when Haiku agrees with Jev.
 * `waiting`: Jev unsure, Haiku hasn't answered; `disagree`: Haiku gave another label.
 */
export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export interface Settled {
  status: SettledStatus;
  /** Set only when `status` is `settled`. */
  label: TypeLabel | null;
  source: "jev" | "haiku" | null;
  /** Jev's top probability. */
  confidence: number | null;
  jevLabel: TypeLabel | null;
  haikuLabel: TypeLabel | null;
  /** Jev's flags when Jev is sure, otherwise every flag either classifier raised. */
  flags: string[];
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
  /** page size (server default 100, at most 500) and offset; `total` counts every match */
  limit?: number;
  offset?: number;
}

export interface DecisionList {
  decisions: Decision[];
  total: number;
  byKind: Partial<Record<DecisionKind, number>>;
  oldestAskedAt: string | null;
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
}

// ---- merge queue ------------------------------------------------------------

/**
 * Where a taken PR stands in the merge queue:
 * ready (may merge by the rule now), decision-answered-merge (the operator answered merge),
 * refused (the merge command or a pre-merge check said no; tried again next run),
 * waiting-ci (CI pending or none, or GitHub still computing mergeability), ci-failed, conflict,
 * needs-fix-up (take-fix), needs-decision (outside the rule; Merge? asked or about to be),
 * declined (the operator answered hold or close), merged.
 */
export type QueueState =
  | "ready"
  | "decision-answered-merge"
  | "refused"
  | "waiting-ci"
  | "ci-failed"
  | "conflict"
  | "needs-fix-up"
  | "needs-decision"
  | "declined"
  | "merged";

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
}

export interface QueueFilter {
  repo?: RepoName;
  state?: QueueState;
}

export interface QueueList {
  rows: QueueRow[];
  /** Per state, for the repo filter (ignores the state filter). */
  counts: Record<QueueState, number>;
  total: number;
}
