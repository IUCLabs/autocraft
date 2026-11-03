// Definition of the pipeline swimlane diagram (docs/pipeline.md, "The flow").
// Lanes are columns, rows run in pipeline order. Swimlane.tsx draws it.

export type LaneId = "contributor" | "auto" | "models" | "sandbox" | "operator" | "writes";

export interface Lane {
  id: LaneId;
  title: string;
}

export interface Step {
  id: string;
  lane: LaneId;
  row: number;
  /** First line is the step name, the rest is detail (28 characters each at most). */
  lines: string[];
  /** Per-repo approval the step needs. */
  approval?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
  /** Steps that run without a person: the main line, drawn heavy and straight where it can be. */
  main?: boolean;
  /** Branches that wait for a person or are rare. */
  dashed?: boolean;
}

export const LANES: Lane[] = [
  { id: "contributor", title: "Contributor" },
  { id: "auto", title: "AutoCraft" },
  { id: "models", title: "Models" },
  { id: "sandbox", title: "Sandbox" },
  { id: "operator", title: "Operator" },
  { id: "writes", title: "GitHub writes" },
];

export const STEPS: Step[] = [
  { id: "open", lane: "contributor", row: 0, lines: ["Opens or updates", "an issue or PR"] },
  { id: "sync", lane: "auto", row: 1, lines: ["Sync", "every minute, to local DB"] },
  { id: "embed", lane: "auto", row: 2, lines: ["Embed", "vector per item, local"] },
  { id: "dups", lane: "auto", row: 3, lines: ["Duplicates", "nearest neighbours"] },
  { id: "dupcheck", lane: "models", row: 4, lines: ["Duplicate check", "Jev first, Haiku settles"] },
  { id: "dupdec", lane: "operator", row: 5, lines: ["Duplicate?", "close / not / keep both"] },
  { id: "classify", lane: "models", row: 6, lines: ["Classify", "Jev, Haiku backup"] },
  { id: "act1", lane: "writes", row: 6, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "priority", lane: "models", row: 7, lines: ["Priority", "Jev, level P0 to P4"] },
  { id: "label", lane: "writes", row: 7, lines: ["Label", "type labels"], approval: "label approval" },
  { id: "decide", lane: "operator", row: 8, lines: ["Decide", "scope call"] },
  { id: "review", lane: "models", row: 11, lines: ["Review (PRs)", "Sonnet verdict"] },
  { id: "fix", lane: "sandbox", row: 9, lines: ["Fix (issues)", "Sonnet patch + test"], approval: "fix approval" },
  { id: "act2", lane: "writes", row: 9, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "verify", lane: "sandbox", row: 12, lines: ["Verify", "Sonnet plan, build + tests"] },
  { id: "hold1", lane: "operator", row: 10, lines: ["Hold", "waits for a person"] },
  { id: "prfork", lane: "writes", row: 10, lines: ["Open PR from fork", "our fix, as a PR"], approval: "fix approval" },
  { id: "vfail", lane: "models", row: 13, lines: ["Failure summary", "Haiku"] },
  { id: "queue", lane: "auto", row: 13, lines: ["Merge queue", "rule met at this head?"] },
  { id: "closeq", lane: "operator", row: 12, lines: ["Close this PR?", "close / hold / keep open"] },
  { id: "fixup", lane: "writes", row: 12, lines: ["Fix-up", "Sonnet patch, push to PR"], approval: "push approval" },
  { id: "hold2", lane: "operator", row: 13, lines: ["Hold", "waits for a person"] },
  { id: "ask", lane: "writes", row: 13, lines: ["Comment fixes", "asked the contributor"], approval: "comment approval" },
  { id: "mergeq", lane: "operator", row: 14, lines: ["Merge?", "merge / hold / close"] },
  { id: "push", lane: "contributor", row: 14, lines: ["Pushes a new head", "or answers"] },
  { id: "act3", lane: "writes", row: 14, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "merge", lane: "writes", row: 15, lines: ["Merge", "safe-merge"], approval: "merge approval" },
];

export const EDGES: Edge[] = [
  { from: "open", to: "sync", main: true },
  { from: "sync", to: "embed", main: true },
  { from: "embed", to: "dups", main: true },
  { from: "dups", to: "dupcheck", label: "pair", main: true },
  { from: "dupcheck", to: "classify", label: "distinct", main: true },
  { from: "dupcheck", to: "dupdec", label: "duplicate", dashed: true },
  { from: "dupdec", to: "act1", label: "close", dashed: true },
  { from: "dupdec", to: "classify", label: "not a duplicate", dashed: true },
  { from: "classify", to: "priority", main: true },
  { from: "classify", to: "label", label: "settled type" },
  { from: "classify", to: "decide", label: "needs decision / disagree", dashed: true },
  { from: "priority", to: "review", label: "PR", main: true },
  { from: "priority", to: "fix", label: "issue", main: true },
  { from: "decide", to: "review", label: "take", dashed: true },
  { from: "decide", to: "fix", label: "take", dashed: true },
  { from: "decide", to: "act2", label: "out of scope", dashed: true },
  { from: "fix", to: "prfork", label: "patch" },
  { from: "prfork", to: "review", label: "our PR" },
  { from: "fix", to: "hold1", label: "no clear fix", dashed: true },
  { from: "review", to: "verify", label: "take", main: true },
  { from: "verify", to: "queue", label: "passed", main: true },
  { from: "queue", to: "merge", label: "rule met", main: true },
  { from: "queue", to: "mergeq", label: "otherwise", dashed: true },
  { from: "mergeq", to: "merge", label: "merge", dashed: true },
  { from: "verify", to: "vfail", label: "failed" },
  { from: "vfail", to: "hold2" },
  { from: "review", to: "fixup", label: "take-fix" },
  { from: "fixup", to: "review", label: "new head" },
  { from: "fixup", to: "ask", label: "cannot push" },
  { from: "ask", to: "push" },
  { from: "push", to: "review", label: "new head" },
  { from: "review", to: "hold2", label: "hold", dashed: true },
  { from: "review", to: "closeq", label: "close", dashed: true },
  { from: "closeq", to: "act3", label: "yes", dashed: true },
];
