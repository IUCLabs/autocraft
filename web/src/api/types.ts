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

/** A maintainer's answer. It does nothing until an operator approves it. */
export interface Proposal {
  id: string;
  login: string;
  option: string;
  note: string | null;
  at: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decidedBy: string | null;
  decidedAt: string | null;
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
  /** Set when the answer came from an approved proposal. */
  proposedBy: string | null;
  proposals: Proposal[];
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

export interface Item extends ItemRef {
  kind: "pr" | "issue";
  title: string;
  state: ItemState;
  author: string;
  tier: Tier;
  authorMerged: number;
  authorClosedUnmerged: number;
  additions: number;
  deletions: number;
  files: ChangedFile[];
  ci: CiState;
  ciChecks: { name: string; state: CiState; minutes: number }[];
  mergeable: Mergeable;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  related: RelatedItem[];
  classifications: Classification[];
  stages: StageEntry[];
  decisionIds: string[];
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
  classified: number;
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
  /** open items at the end of each day since the run started */
  openTrend: number[];
}

export interface Progress {
  runStartedAt: string;
  now: string;
  funnel: Funnel;
  done: Done;
  /** items done per hour, oldest first, last 24 h */
  perHour: number[];
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
  /** Deployment setting `maintainer_writes`: when false every non-operator is read-only. */
  maintainerWrites: boolean;
}

export interface DecisionFilter {
  repo?: RepoName[];
  kind?: DecisionKind[];
  /** minimum age in days */
  minAge?: number;
  mine?: boolean;
  /** "proposals": open decisions with a pending proposal */
  status?: "open" | "proposals" | "answered";
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
