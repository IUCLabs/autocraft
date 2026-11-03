// Definition of the pipeline swimlane diagram (docs/pipeline.md, "The flow").
// Lanes are columns, rows run in pipeline order. Swimlane.tsx draws it.

export type LaneId = "contributor" | "auto" | "models" | "sandbox" | "operator" | "writes";

export interface Lane {
  id: LaneId;
  title: string;
  note: string;
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
  dashed?: boolean;
}

export const LANES: Lane[] = [
  { id: "contributor", title: "Contributor", note: "GitHub" },
  { id: "auto", title: "AutoCraft", note: "rules, no model" },
  { id: "models", title: "Models", note: "Jev, Haiku, Sonnet" },
  { id: "sandbox", title: "Sandbox", note: "build and test" },
  { id: "operator", title: "Operator", note: "decisions" },
  { id: "writes", title: "GitHub writes", note: "per-repo approval" },
];

export const STEPS: Step[] = [
  { id: "open", lane: "contributor", row: 0, lines: ["Opens or updates", "an issue or PR"] },
  { id: "sync", lane: "auto", row: 1, lines: ["Sync", "every minute, to local DB"] },
  { id: "embed", lane: "auto", row: 2, lines: ["Embed", "vector per item, local"] },
  { id: "dups", lane: "auto", row: 3, lines: ["Duplicates", "nearest neighbours"] },
  { id: "dupcheck", lane: "models", row: 4, lines: ["Duplicate check", "Jev first, Haiku settles"] },
  { id: "dupdec", lane: "operator", row: 5, lines: ["Duplicate?", "close / not / keep both"] },
  { id: "classify", lane: "models", row: 6, lines: ["Classify", "Jev, Haiku backup"] },
  { id: "priority", lane: "models", row: 7, lines: ["Priority", "Jev, level P0 to P4"] },
  { id: "decide", lane: "operator", row: 8, lines: ["Decide", "scope call on open items"] },
  { id: "label", lane: "writes", row: 9, lines: ["Label", "type labels"], approval: "label approval" },
  { id: "fix", lane: "sandbox", row: 10, lines: ["Fix (issues)", "Sonnet patch + test"], approval: "fix approval" },
  { id: "prfork", lane: "writes", row: 11, lines: ["Open PR from fork", "our fix, as a PR"], approval: "fix approval" },
  { id: "review", lane: "models", row: 12, lines: ["Review (PRs)", "Sonnet verdict"] },
  { id: "fixup", lane: "writes", row: 13, lines: ["Fix-up", "Sonnet patch, push to PR"], approval: "push approval" },
  { id: "closeq", lane: "operator", row: 14, lines: ["Close this PR?", "close / hold / keep open"] },
  { id: "verify", lane: "sandbox", row: 13, lines: ["Verify", "Sonnet plan, build + tests"] },
  { id: "ask", lane: "writes", row: 14, lines: ["Comment fixes", "asked the contributor"], approval: "comment approval" },
  { id: "vfail", lane: "models", row: 14, lines: ["Failure summary", "Haiku"] },
  { id: "queue", lane: "auto", row: 14, lines: ["Merge queue", "rule met at this head?"] },
  { id: "push", lane: "contributor", row: 15, lines: ["Pushes a new head", "or answers"] },
  { id: "hold1", lane: "operator", row: 11, lines: ["Hold", "waits for a person"] },
  { id: "hold2", lane: "operator", row: 13, lines: ["Hold", "waits for a person"] },
  { id: "hold3", lane: "operator", row: 16, lines: ["Hold", "waits for a person"] },
  { id: "act1", lane: "writes", row: 6, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "act2", lane: "writes", row: 10, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "act3", lane: "writes", row: 15, lines: ["Act", "comment, then close"], approval: "comment approval" },
  { id: "mergeq", lane: "operator", row: 15, lines: ["Merge?", "merge / hold / close"] },
  { id: "merge", lane: "writes", row: 16, lines: ["Merge", "safe-merge"], approval: "merge approval" },
];

export const EDGES: Edge[] = [
  { from: "open", to: "sync" },
  { from: "sync", to: "embed" },
  { from: "embed", to: "dups" },
  { from: "dups", to: "dupcheck", label: "pair" },
  { from: "dupcheck", to: "dupdec", label: "duplicate" },
  { from: "dupcheck", to: "classify", label: "distinct" },
  { from: "dupdec", to: "act1", label: "close" },
  { from: "dupdec", to: "classify", label: "not a duplicate", dashed: true },
  { from: "classify", to: "priority" },
  { from: "classify", to: "decide", label: "disagree", dashed: true },
  { from: "priority", to: "decide" },
  { from: "decide", to: "label", label: "type settled" },
  { from: "decide", to: "act2", label: "out of scope" },
  { from: "label", to: "fix", label: "issue" },
  { from: "label", to: "review", label: "PR" },
  { from: "fix", to: "prfork", label: "patch" },
  { from: "prfork", to: "review", label: "our PR" },
  { from: "fix", to: "hold1", label: "no clear fix", dashed: true },
  { from: "review", to: "fixup", label: "take-fix" },
  { from: "fixup", to: "review", label: "new head" },
  { from: "fixup", to: "ask", label: "cannot push" },
  { from: "ask", to: "push", label: "asked the contributor" },
  { from: "push", to: "review", label: "new head" },
  { from: "review", to: "hold2", label: "hold", dashed: true },
  { from: "review", to: "closeq", label: "close" },
  { from: "closeq", to: "act3", label: "yes" },
  { from: "review", to: "verify", label: "take" },
  { from: "verify", to: "queue", label: "passed" },
  { from: "verify", to: "vfail", label: "failed" },
  { from: "vfail", to: "hold3" },
  { from: "queue", to: "merge", label: "rule met" },
  { from: "queue", to: "mergeq", label: "no" },
  { from: "mergeq", to: "merge", label: "merge" },
];
