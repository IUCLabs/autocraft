// The pipeline's stages in one place: states, runner steps, lanes, limits, models,
// prompts, swimlane cards, waits and edges. Plain data with type-only imports, so the
// dashboard bundle and the runner both load it. No Node imports, no prompt texts.
import type { FlowBranch, FlowWait } from "../../web/src/api/types.ts";
import type { LaneId } from "../../web/src/ui/organisms/swimlaneDef.ts";

export type Wait = FlowWait;
export type Tone = FlowBranch["tone"];
export type StageId = "synced" | "dupes" | "classify" | "priority" | "decide" | "labels" | "review" | "fix" | "fixup" | "verify" | "merge" | "act";
/** Where a state's count links to: the Items list filtered to the state (default), the merge queue, the Items list across all states, or the items of one kind. */
export type StateLink = "items" | "queue" | "anyState" | "kind-issue" | "kind-pr" | null;

export type StageDef = {
  id: StageId;
  title: string;
  /** Position in the flowchart, 1 to 12. */
  order: number;
  /** Stage number stored in agent_runs.stage (docs/pipeline.md numbering of the runner). */
  runStage: number;
  /** The "## " heading of the stage's section in docs/pipeline.md. */
  docSection: string;
  /** Plain words, for the README table and the flow hint. */
  description: string;
  /** auto: runs on its own; steps: runner steps; gate: a person decides; planned: not built yet. */
  mode: "auto" | "steps" | "gate" | "planned";
  /** Runner steps the stage owns. label: the name in the daily limits table, for steps with a limit. limit: default items per day when no row exists (null: limited by setting only, absent: not limited). seeded: the value src/schema.sql inserts into a new database. */
  steps: { name: string; label?: string; limit?: number | null; seeded?: number; zeroOnly?: boolean }[];
  /** Autopilot lanes. order is the lane's place in the autopilot's pass; a step may sit in lanes of other stages. */
  lanes: { name: string; steps: string[]; order: number }[];
  reads: string[];
  sets: string[];
  /** The branches of the flow node. A hint that interpolates a count is built in code and left out here. */
  states: { id: string; label: string; waitsOn: Wait; tone: Tone; hint?: string; gate?: boolean; link?: StateLink }[];
  models: { model: "jev" | "haiku" | "sonnet" | "opus" | "local"; use: string; remark?: string }[];
  promptIds: string[];
  /** The `stage` label of the stage's prompts: equal, or followed by " (...)". */
  promptStage: string;
  waits: { name: string; why: string; howLong: string; showsAs: string; kind: "external" | "backoff" }[];
  writes: { what: string; approval?: "label" | "comment" | "push" | "fix" | "merge" | "ci" }[];
  /** What stops for a person, or null. */
  person: string | null;
  swimlane: { id: string; lane: LaneId; row: number; lines: string[]; approval?: string }[];
  edges: { to: StageId; branch: string | null; label: string }[];
};

export const STAGES: StageDef[] = [
  {
    id: "synced", title: "Synced", order: 1, runStage: 1, docSection: "Sync", mode: "auto",
    description: "Mirrors every issue, PR and comment of the tracked repos into the local database each minute, and makes a vector of each item's title and body for similar-item search.",
    steps: [{ name: "embed", label: "Embed", limit: null }],
    lanes: [{ name: "embed", steps: ["embed"], order: 3 }],
    reads: ["GitHub issues, PRs and comments"],
    sets: ["Mirror rows", "Item vectors"],
    states: [
      { id: "issues", label: "Open issues", waitsOn: "nothing", tone: "neutral", link: "kind-issue" },
      { id: "prs", label: "Open PRs", waitsOn: "nothing", tone: "neutral", link: "kind-pr" },
    ],
    models: [{ model: "local", use: "Embeds each item's title and body" }],
    promptIds: [], promptStage: "Synced",
    waits: [
      { name: "Sync", why: "Poll of GitHub", howLong: "1 minute; the search catch-up runs hourly, the reconcile daily", showsAs: "Syncs list", kind: "external" },
    ],
    writes: [],
    person: null,
    swimlane: [
      { id: "open", lane: "contributor", row: 0, lines: ["Opens or updates", "an issue or PR"] },
      { id: "sync", lane: "auto", row: 1, lines: ["Sync", "every minute, to local DB"] },
      { id: "embed", lane: "auto", row: 2, lines: ["Embed", "vector per item, local"] },
    ],
    edges: [{ to: "dupes", branch: null, label: "open items" }],
  },
  {
    id: "dupes", title: "Duplicates", order: 2, runStage: 3, docSection: "Duplicates", mode: "steps",
    description: "Finds items that describe the same bug or request as another open item, or one closed in the last year, and compares each group.",
    steps: [{ name: "dupes", label: "Duplicates", limit: 2000 }, { name: "dupes-compare", label: "Compare duplicate groups", limit: 200 }],
    lanes: [{ name: "dupes", steps: ["dupes"], order: 4 }, { name: "dupes-compare", steps: ["dupes-compare"], order: 5 }],
    reads: ["Item vectors", "Duplicate decisions already answered"],
    sets: ["Duplicate pair verdicts", "Duplicate decisions"],
    states: [
      { id: "checking", label: "In a pair being checked", waitsOn: "model", tone: "neutral", hint: "Jev and Haiku have not judged the pair yet" },
      { id: "waiting", label: "Waiting for an answer", waitsOn: "person", tone: "accent", hint: "A person decides whether it duplicates another item", gate: true },
      { id: "held", label: "Held out", waitsOn: "runner", tone: "warn", hint: "Answered close: held out of later steps until Act closes it" },
      { id: "closed", label: "Closed as duplicate", waitsOn: "nothing", tone: "neutral", link: "anyState" },
    ],
    models: [
      { model: "jev", use: "Judges each candidate pair first" },
      { model: "haiku", use: "Settles pairs Jev is unsure of" },
      { model: "opus", use: "Compares each group of pull requests" },
      { model: "sonnet", use: "Compares each group of issues" },
    ],
    promptIds: ["dupes.jev", "dupes.haiku", "dupes.compare-prs.opus", "dupes.compare-issues.sonnet"], promptStage: "Duplicates",
    waits: [
      { name: "Duplicate set changed on GitHub", why: "Wait for the sync to bring the set", howLong: "10 minutes", showsAs: "Duplicates stage", kind: "external" },
      { name: "Rule fallback of a duplicate group", why: "The model call failed; retried up to 3 times", howLong: "15 minutes", showsAs: "Duplicates stage", kind: "backoff" },
    ],
    writes: [],
    person: "Duplicate? decision",
    swimlane: [
      { id: "dups", lane: "auto", row: 3, lines: ["Duplicates", "nearest neighbours"] },
      { id: "dupcheck", lane: "models", row: 4, lines: ["Duplicate check", "Jev first, Haiku settles"] },
      { id: "dupdec", lane: "operator", row: 5, lines: ["Duplicate?", "close / not / keep both"] },
    ],
    edges: [{ to: "classify", branch: null, label: "not held out" }],
  },
  {
    id: "classify", title: "Classify", order: 3, runStage: 2, docSection: "Classify", mode: "steps",
    description: "Gives each open item one type label and two flags (security, needs decision). Jev goes first, Haiku gives a second opinion, and a referee settles disagreements outside the scope labels.",
    steps: [{ name: "classify-new", label: "Classify", limit: null, seeded: 2000 }, { name: "classify-all" }, { name: "referee", label: "Referee", limit: 500 }, { name: "areas-propose" }, { name: "areas-suggest" }, { name: "areas-rescan" }],
    lanes: [{ name: "classify", steps: ["classify-new"], order: 0 }, { name: "referee", steps: ["referee"], order: 17 }],
    reads: ["Item text", "Area list"],
    sets: ["Type label and flags per item", "Area list"],
    states: [
      { id: "settled", label: "Settled", waitsOn: "nothing", tone: "ok", hint: "Jev at 90 % or more, or Haiku agreeing with Jev" },
      { id: "waiting", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "referee", label: "Waiting for the referee", waitsOn: "model", tone: "warn", hint: "Jev and Haiku chose different labels; Sonnet settles it unless it is a scope call" },
      { id: "disagree", label: "Models disagree", waitsOn: "person", tone: "bad", hint: "Scope calls go to Decide; other disagreements are here when Sonnet was unsure" },
      { id: "unclassified", label: "Not classified yet", waitsOn: "model", tone: "neutral", hint: "No Jev or Haiku verdict in the current run" },
    ],
    models: [
      { model: "jev", use: "Classifies every item first", remark: "Reports how sure it is; at 90 % or more it matched maintainers' labels 98 % of the time" },
      { model: "haiku", use: "Second opinion where Jev is unsure", remark: "Does every item while Jev is unavailable" },
      { model: "sonnet", use: "Referee for label disagreements; area suggestions", remark: "The referee asks a person only when it is unsure" },
      { model: "opus", use: "Proposes area lists" },
    ],
    promptIds: ["classify.jev", "classify.haiku", "referee.sonnet", "areas.jev", "areas.haiku", "areas.propose", "areas.suggest"], promptStage: "Classify",
    waits: [

    ],
    writes: [],
    person: "Labels the models disagree on",
    swimlane: [
      { id: "classify", lane: "models", row: 6, lines: ["Classify", "Jev, Haiku backup"] },
      { id: "referee", lane: "models", row: 7, lines: ["Sonnet referee", "settles type disagreements"] },
    ],
    edges: [{ to: "priority", branch: null, label: "open items" }, { to: "decide", branch: null, label: "needs a decision" }],
  },
  {
    id: "priority", title: "Priority", order: 4, runStage: 2, docSection: "Priority", mode: "steps",
    description: "Gives each open item a level from P0 to P4, then orders the candidates of later stages by a work rank.",
    steps: [{ name: "prioritize", label: "Priority", limit: null, seeded: 3000 }, { name: "rank" }],
    lanes: [{ name: "priority", steps: ["prioritize"], order: 1 }, { name: "rank", steps: ["rank"], order: 2 }],
    reads: ["Item text", "Type, size and security flag"],
    sets: ["Priority level", "Work rank"],
    states: [
      { id: "scored", label: "Scored", waitsOn: "nothing", tone: "ok", hint: "Impact and reach give the work score" },
      { id: "unsure", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "todo", label: "Not scored yet", waitsOn: "model", tone: "neutral", hint: "No score at the item's current text" },
    ],
    models: [{ model: "jev", use: "Picks the level" }, { model: "haiku", use: "Decides where Jev is unsure" }],
    promptIds: ["priority.jev", "priority.haiku"], promptStage: "Priority",
    waits: [
      { name: "Work rank recompute", why: "Its input moves in bursts while a sync writes; nothing waits on it", howLong: "at most once a minute", showsAs: "none", kind: "backoff" },
    ],
    writes: [],
    person: null,
    swimlane: [
      { id: "priority", lane: "models", row: 8, lines: ["Priority", "Jev, level P0 to P4"] },
    ],
    edges: [{ to: "decide", branch: null, label: "scored" }],
  },
  {
    id: "decide", title: "Decide", order: 5, runStage: 3, docSection: "Decide", mode: "gate",
    description: "Asks an operator for scope calls, with a summary and a recommendation, and answers questions about an item in its conversation.",
    steps: [{ name: "decide", label: "Decide", limit: null, seeded: 100 }, { name: "conversation", label: "Conversations", limit: 30 }],
    lanes: [{ name: "decide", steps: ["decide"], order: 6 }, { name: "conversation", steps: ["conversation"], order: 19 }],
    reads: ["Classified items", "Reviews", "Operator answers"],
    sets: ["Decisions with summary and recommendation", "Conversation replies"],
    states: [
      { id: "not-asked", label: "Not asked yet", waitsOn: "model", tone: "neutral", hint: "Needs a decision; the decide step writes the question and summary" },
      { id: "open", label: "Waiting for an answer", waitsOn: "person", tone: "accent", gate: true },
      { id: "take", label: "Wanted in core", waitsOn: "nothing", tone: "ok", hint: "Answered take: PRs go to review" },
      { id: "small-extra", label: "Small extra", waitsOn: "nothing", tone: "ok", hint: "Answered small extra: kept in core, PRs go to review" },
      { id: "plugin", label: "Plug-in candidate", waitsOn: "nothing", tone: "neutral", hint: "Answered plugin: kept open, labelled plugin candidate" },
      { id: "close", label: "Out of scope", waitsOn: "nothing", tone: "neutral", hint: "Answered close: to be closed with a short reason" },
      { id: "need-info", label: "Check the reference app", waitsOn: "nothing", tone: "warn", hint: "Answered need info: asked again once the reference app's behaviour is known" },
      { id: "backlog", label: "Backlog", waitsOn: "nothing", tone: "neutral", hint: "Answered backlog: held undecided, no later step takes it up" },
    ],
    models: [
      { model: "sonnet", use: "Writes decision summaries" },
      { model: "haiku", use: "Summaries of duplicate decisions" },
      { model: "opus", use: "Writes the scope recommendation and conversation replies" },
    ],
    promptIds: ["decide.summary", "decide.recommend", "conversation.turn"], promptStage: "Decide",
    waits: [
      { name: "Failed recommendation", why: "A scope recommendation call that keeps failing must not re-run Decide", howLong: "1 hour between tries, at most 3; then the decision keeps no recommendation", showsAs: "none (the decision shows no recommendation)", kind: "backoff" },
    ],
    writes: [],
    person: "An operator answers",
    swimlane: [
      { id: "decide", lane: "operator", row: 9, lines: ["Decide", "scope call, unsure type"] },
    ],
    edges: [{ to: "labels", branch: null, label: "type settled" }, { to: "act", branch: null, label: "answered close" }],
  },
  {
    id: "labels", title: "Labels", order: 6, runStage: 4, docSection: "Label", mode: "steps",
    description: "Writes each settled type label and flag to GitHub. A label a person set is never changed.",
    steps: [{ name: "labels-ensure" }, { name: "labels-apply", label: "Label", limit: null }],
    lanes: [{ name: "labels", steps: ["labels-apply"], order: 8 }],
    reads: ["Settled types and flags", "Repo label approval"],
    sets: ["Labels on GitHub"],
    states: [
      { id: "labelled", label: "Labelled on GitHub", waitsOn: "nothing", tone: "ok" },
      { id: "pending", label: "To label", waitsOn: "runner", tone: "neutral", hint: "Settled, in a repo approved for labelling" },
      { id: "unapproved", label: "Repo not approved", waitsOn: "person", tone: "warn", hint: "An operator approves labelling per repo on the Repos page", gate: true },
    ],
    models: [],
    promptIds: [], promptStage: "Label",
    waits: [

    ],
    writes: [{ what: "Type and flag labels", approval: "label" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "label", lane: "writes", row: 9, lines: ["Label", "type labels"], approval: "label approval" },
    ],
    edges: [{ to: "review", branch: null, label: "PRs to review" }, { to: "fix", branch: null, label: "issues" }],
  },
  {
    id: "review", title: "Review", order: 7, runStage: 5, docSection: "Review", mode: "steps",
    description: "Opus reviews every wanted PR at its current head, reading the repo, and gives a verdict with the complete fix list. It writes nothing to GitHub until the final review is posted.",
    steps: [{ name: "opus-review", label: "Review (Opus)", limit: null, seeded: 40 }, { name: "checks", label: "Checks", limit: null, zeroOnly: true }, { name: "review-post", label: "Post reviews", limit: null, seeded: 40 }],
    lanes: [{ name: "review", steps: ["checks", "opus-review"], order: 7 }, { name: "review-post", steps: ["review-post"], order: 18 }],
    reads: ["PR head and diff", "CI results", "Repo checkout"],
    sets: ["Review verdict and fix list"],
    states: [
      { id: "not-reviewed", label: "Not reviewed yet", waitsOn: "model", tone: "neutral", hint: "No review at the PR's current head commit" },
      { id: "take", label: "Take", waitsOn: "nothing", tone: "ok" },
      { id: "take-fix", label: "Take with fixes", waitsOn: "nothing", tone: "ok" },
      { id: "hold", label: "Hold", waitsOn: "person", tone: "warn", hint: "Needs a person: reference behaviour, a design or scope choice, or too large" },
      { id: "close", label: "Close", waitsOn: "nothing", tone: "bad", hint: "Wrong, not wanted, already done or superseded" },
    ],
    models: [{ model: "opus", use: "Reviews every wanted PR", remark: "The review gives a verdict, a complete fix list and how sure Opus is" }],
    promptIds: ["review.opus"], promptStage: "Review",
    waits: [
      { name: "Checks before Review and Verify", why: "CI data younger than 5 minutes is reused", howLong: "5 minutes", showsAs: "Job list", kind: "backoff" },
    ],
    writes: [{ what: "Final review comment", approval: "comment" }],
    person: "Hold, close and merge-outside-rule verdicts",
    swimlane: [
      { id: "review", lane: "models", row: 12, lines: ["Opus review", "reads the repo"] },
      { id: "closeq", lane: "operator", row: 13, lines: ["Close this PR?", "close / hold / keep open"] },
    ],
    edges: [{ to: "fixup", branch: "take-fix", label: "take with fixes" }, { to: "verify", branch: "take", label: "taken" }],
  },
  {
    id: "fix", title: "Fix", order: 8, runStage: 7, docSection: "Fix", mode: "steps",
    description: "Writes a patch for a bugfix issue where the fix is clear, tests it in the sandbox and opens a PR.",
    steps: [{ name: "fixissue", label: "Fix", limit: null, seeded: 10 }, { name: "fixissue-collect" }],
    lanes: [{ name: "fixissue", steps: ["fixissue"], order: 15 }, { name: "fixissue-collect", steps: ["fixissue-collect"], order: 16 }],
    reads: ["Open bugfix issues", "Repo checkout at the base commit"],
    sets: ["Fix attempts", "Pull requests"],
    states: [
      { id: "candidates", label: "Candidates", waitsOn: "model", tone: "neutral", hint: "Open bugfix issues without an attempt; Sonnet triages the highest work score first" },
      { id: "retry", label: "Patch due", waitsOn: "model", tone: "neutral", hint: "Triage found a clear fix; Sonnet writes the patch, or the next round" },
      { id: "testing", label: "In sandbox", waitsOn: "sandbox", tone: "neutral", hint: "The patched head and the base commit are built and tested" },
      { id: "passed", label: "Passed, PR next", waitsOn: "runner", tone: "ok", hint: "The next collect pushes the branch and opens the PR" },
      { id: "pr-opened", label: "PR opened", waitsOn: "nothing", tone: "ok", hint: "The PR goes through Review" },
      { id: "skipped", label: "Held: not a clear fix", waitsOn: "person", tone: "warn", hint: "Retried only when the issue text changes" },
      { id: "failed", label: "Held: rounds failed", waitsOn: "person", tone: "bad", hint: "Three failed rounds end the attempt" },
      { id: "unapproved", label: "Repo not approved for fixing", waitsOn: "person", tone: "warn", hint: "Candidates in a repo without fix approval; an operator approves it on the Repos page", gate: true },
    ],
    models: [
      { model: "sonnet", use: "Triages the issue and writes the patch" },
      { model: "opus", use: "Checks the patch" },
      { model: "haiku", use: "Failure summaries" },
    ],
    promptIds: ["fixissue.triage", "fixissue.patch", "fixissue.check"], promptStage: "Fix",
    waits: [

    ],
    writes: [{ what: "Branch and pull request", approval: "fix" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "fix", lane: "sandbox", row: 10, lines: ["Fix (issues)", "Sonnet patch, Opus check"], approval: "fix approval" },
      { id: "hold1", lane: "operator", row: 11, lines: ["Hold", "waits for a person"] },
      { id: "prfork", lane: "writes", row: 11, lines: ["Open PR from fork", "our fix, as a PR"], approval: "fix approval" },
    ],
    edges: [{ to: "review", branch: "pr-opened", label: "our PR" }],
  },
  {
    id: "fixup", title: "Fix-up", order: 9, runStage: 6, docSection: "Fix-up", mode: "steps",
    description: "For a take-with-fixes review, applies the listed small fixes to the contributor's branch, or posts them as a comment when the branch cannot be pushed to.",
    steps: [{ name: "fixup", label: "Fix-up", limit: null, seeded: 20 }],
    lanes: [{ name: "fixup", steps: ["fixup"], order: 12 }],
    reads: ["Review fix lists", "Repo checkout at the PR head"],
    sets: ["Pushed commits", "Fix comments"],
    states: [
      { id: "fix", label: "To fix up", waitsOn: "model", tone: "neutral", hint: "Take with fixes: Sonnet patches, then pushes to the PR branch" },
      { id: "pushed", label: "Pushed", waitsOn: "model", tone: "ok", hint: "The new head goes back to Review" },
      { id: "hold", label: "Cannot push (hold)", waitsOn: "person", tone: "warn", hint: "Branch closed to maintainers, patch refused or two tries used; held until the repo is approved for comments" },
      { id: "asked", label: "Asked the contributor", waitsOn: "person", tone: "neutral", hint: "The fixes were posted as a comment; a new head goes back to Review" },
      { id: "unapproved", label: "Repo not approved for pushing", waitsOn: "person", tone: "warn", hint: "An operator approves pushing per repo on the Repos page", gate: true },
    ],
    models: [{ model: "sonnet", use: "Writes the patch and resolves conflicts" }, { model: "opus", use: "Checks the patch" }],
    promptIds: ["fixup.patch", "fixup.check", "fixup.conflict"], promptStage: "Integrate (fix-ups)",
    waits: [

    ],
    writes: [{ what: "Push to the PR branch", approval: "push" }, { what: "Comment with the fixes", approval: "comment" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "fixup", lane: "writes", row: 13, lines: ["Fix-up", "Sonnet patch, Opus check"], approval: "push approval" },
      { id: "ask", lane: "writes", row: 14, lines: ["Comment fixes", "asked the contributor"], approval: "comment approval" },
      { id: "push", lane: "contributor", row: 15, lines: ["Pushes a new head", "or answers"] },
    ],
    edges: [{ to: "review", branch: "pushed", label: "new head" }],
  },
  {
    id: "verify", title: "Verify", order: 10, runStage: 6, docSection: "Verify", mode: "steps",
    description: "Records upstream CI as the verification of taken PRs in repos that have it. A repo without CI, and a bugfix that changes a test file, get a model-planned build in a build environment; a model summarises failures.",
    steps: [{ name: "verify", label: "Verify", limit: null, seeded: 30 }, { name: "verify-collect" }],
    lanes: [{ name: "verify", steps: ["checks", "verify"], order: 13 }, { name: "verify-collect", steps: ["verify-collect"], order: 14 }],
    reads: ["Taken PRs", "CI results"],
    sets: ["Verification tasks and results"],
    states: [
      { id: "waiting", label: "Not planned yet", waitsOn: "model", tone: "neutral", hint: "Taken, CI not failing, no verification at the head commit" },
      { id: "planned", label: "Planned", waitsOn: "sandbox", tone: "neutral", hint: "Tasks queued for a worker" },
      { id: "running", label: "Running", waitsOn: "sandbox", tone: "neutral" },
      { id: "passed", label: "Passed", waitsOn: "nothing", tone: "ok" },
      { id: "ci-enough", label: "CI is enough", waitsOn: "nothing", tone: "ok", hint: "Upstream CI is the check; the merge waits for it to be green" },
      { id: "failed", label: "Failed", waitsOn: "person", tone: "bad", hint: "Tests failed; the PR is on hold" },
      { id: "error", label: "Error", waitsOn: "person", tone: "bad", hint: "The plan was invalid or a task errored; retried once" },
    ],
    models: [{ model: "sonnet", use: "Plans a regression test (bugfixes that change a test file) or, in a repo without CI, the build and tests" }, { model: "haiku", use: "Failure summaries" }],
    promptIds: ["verify.plan", "verify.summary"], promptStage: "Verify",
    waits: [
      { name: "Sandbox build", why: "External", howLong: "Until the task ends; a build-environment error queues it again once per head", showsAs: "Verification state `planned` or `running`", kind: "external" },
      { name: "Warm build of the default branch", why: "Limits sandbox load; never blocks a PR", howLong: "Once a day per repo", showsAs: "Sandbox tasks", kind: "backoff" },
    ],
    writes: [],
    person: "Failures and errors",
    swimlane: [
      { id: "verify", lane: "sandbox", row: 13, lines: ["Verify", "CI, or Sonnet plan + build"] },
      { id: "vfail", lane: "models", row: 14, lines: ["Failure summary", "Haiku"] },
    ],
    edges: [{ to: "merge", branch: null, label: "verified" }],
  },
  {
    id: "merge", title: "Merge queue", order: 11, runStage: 6, docSection: "Merge queue", mode: "steps",
    description: "Merges PRs that pass the rules in integration batches (up to 50 PRs, checked by upstream CI on the batch PR) through safe-merge, and asks for a Merge? decision on PRs outside the rules. Approves held CI runs of outside contributors where the repo allows it.",
    steps: [{ name: "merge", label: "Merge", limit: null, seeded: 10 }, { name: "merge-ask" }, { name: "ci-approve", label: "Approve CI runs", limit: 30 }],
    lanes: [{ name: "merge-ask", steps: ["merge-ask"], order: 9 }, { name: "merge", steps: ["checks", "merge"], order: 10 }, { name: "ci-approve", steps: ["ci-approve"], order: 20 }],
    reads: ["Reviews", "Verification results", "CI state", "Merge decisions"],
    sets: ["Integration batches", "Merged PRs", "Merge? decisions"],
    states: [
      { id: "eligible", label: "May merge now", waitsOn: "runner", tone: "ok", hint: "Covered by the merge rule or answered merge; CI green, Verify passed (or CI is enough) and mergeable", link: "queue" },
      { id: "in-batch", label: "In an integration batch", waitsOn: "ci", tone: "accent", hint: "Merged into an integration branch; waiting for upstream CI on the batch PR", link: "queue" },
      { id: "unapproved", label: "Repo not approved for merging", waitsOn: "person", tone: "warn", hint: "Ready to merge, but an operator has not approved merging in this repo; approve it on the Repos page", gate: true, link: "queue" },
      { id: "needs-decision", label: "Waiting for a Merge? answer", waitsOn: "person", tone: "accent", hint: "Outside the merge rule, not verified, no CI, or held by an open Duplicate?", gate: true, link: "queue" },
      { id: "waiting-ci", label: "Waiting for CI", waitsOn: "ci", tone: "neutral", link: "queue" },
      { id: "ci-approval", label: "Waiting for CI run approval", waitsOn: "runner", tone: "neutral", hint: "GitHub holds the workflow runs of an outside contributor's PR; the pipeline approves them", link: "queue" },
      { id: "ci-approval-person", label: "CI runs need a person to approve", waitsOn: "person", tone: "warn", hint: "The repo's CI approval is off, or approving a run failed twice; approve the runs on GitHub or the repo on the Repos page", link: "queue" },
      { id: "ci-failed", label: "Blocked: CI fails", waitsOn: "ci", tone: "bad", link: "queue" },
      { id: "conflict", label: "Blocked: conflicts", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "waiting-verify", label: "Waiting for Verify", waitsOn: "model", tone: "neutral", hint: "No passed verification at the head commit yet", link: "queue" },
      { id: "verify-failed", label: "Blocked: Verify failed", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "verify-error", label: "Blocked: Verify error", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "needs-fix-up", label: "Needs fix-up", waitsOn: "model", tone: "warn", hint: "Take with fixes: waits for the fix-up step", link: "queue" },
      { id: "batch-failed", label: "Blocked: failed in a batch", waitsOn: "person", tone: "bad", hint: "Failed alone in a batch; on hold until it has a new head", link: "queue" },
      { id: "declined", label: "Declined", waitsOn: "nothing", tone: "neutral", hint: "The operator answered hold or close", link: "queue" },
      { id: "merged", label: "Merged in the last 24 h", waitsOn: "nothing", tone: "merged", link: "queue" },
    ],
    models: [{ model: "haiku", use: "Short summaries in the merge run" }],
    promptIds: [], promptStage: "Merge",
    waits: [
      { name: "Upstream CI of PRs and open batch PRs", why: "External", howLong: "Read again every minute per repo while any waits", showsAs: "\"waiting for CI on N PRs in repo\"", kind: "external" },
      { name: "Runs waiting for approval", why: "GitHub holds the runs of an outside contributor's PR until a maintainer approves them; the pipeline approves them once the head has a final take or take-fix review and the repo's CI approval is on", howLong: "Until the step runs (read again with each checks job)", showsAs: "Queue state `ci-approval`", kind: "external" },
      { name: "Changes requested", why: "A reviewer with write access has a formal review that blocks the merge", howLong: "Until that reviewer approves or a maintainer dismisses the review; no timer. Blocked PRs are read again every merge run", showsAs: "Queue state `changes-requested` with the reviewer in its note", kind: "external" },
    ],
    writes: [{ what: "Merge of the batch PR", approval: "merge" }, { what: "Approval of held workflow runs", approval: "ci" }],
    person: "Merge? decision for PRs outside the rules",
    swimlane: [
      { id: "queue", lane: "auto", row: 14, lines: ["Merge queue", "rule met at this head?"] },
      { id: "hold2", lane: "operator", row: 14, lines: ["Hold", "waits for a person"] },
      { id: "mergeq", lane: "operator", row: 15, lines: ["Merge?", "merge / hold / close"] },
      { id: "batch", lane: "sandbox", row: 16, lines: ["Integration batch", "up to 50 PRs, upstream CI"] },
      { id: "merge", lane: "writes", row: 17, lines: ["Merge", "batch PR, safe-merge --merge"], approval: "merge approval" },
    ],
    edges: [],
  },
  {
    id: "act", title: "Act", order: 12, runStage: 6, docSection: "Act", mode: "steps",
    description: "Makes the comments and closes that follow an operator's answer, from fixed templates.",
    steps: [{ name: "act", label: "Act", limit: null, seeded: 20 }],
    lanes: [{ name: "act", steps: ["act"], order: 11 }],
    reads: ["Operator answers", "Close? decisions"],
    sets: ["Comments and closes on GitHub"],
    states: [
      { id: "todo", label: "To comment and close", waitsOn: "runner", tone: "neutral", hint: "Answered close: out of scope, Close this PR or duplicate", link: "anyState" },
      { id: "failed", label: "Failed, retried", waitsOn: "runner", tone: "bad", hint: "The next run tries again", link: "anyState" },
      { id: "unapproved", label: "Repo not approved for commenting", waitsOn: "person", tone: "warn", hint: "An operator approves commenting per repo on the Repos page", gate: true, link: "anyState" },
      { id: "done", label: "Done in the last 24 h", waitsOn: "nothing", tone: "merged", link: null },
    ],
    models: [],
    promptIds: [], promptStage: "Act",
    waits: [

    ],
    writes: [{ what: "Comment, then close", approval: "comment" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "act1", lane: "writes", row: 6, lines: ["Act", "comment, then close"], approval: "comment approval" },
      { id: "act2", lane: "writes", row: 10, lines: ["Act", "comment, then close"], approval: "comment approval" },
      { id: "act3", lane: "writes", row: 15, lines: ["Act", "comment, then close"], approval: "comment approval" },
    ],
    edges: [],
  },
];

/** Waits that belong to no single stage. */
export const GLOBAL_WAITS: { name: string; why: string; howLong: string; showsAs: string; kind: "external" | "backoff" }[] = [
  { name: "Failed job", why: "Retry a real failure without hammering", howLong: "1, 2, 4, 8, 16, then 30 minutes; ends on a release, and after a single failure also on a changed input", showsAs: "\"failed N times in a row; retry at HH:MM UTC\"", kind: "backoff" },
  { name: "Daily limit", why: "Cost control", howLong: "Until 00:00 UTC", showsAs: "\"daily limit of N items reached; resumes at 00:00 UTC\"", kind: "backoff" },
  { name: "Jev unavailable", why: "Jev is switched off (`autocraft accounts jev off`), the `jev` command is missing, or its account fails: out of credit, or a missing or rejected key (status 401, 402, 403, or a message about credit, billing, quota or the key). Haiku does Jev's classify, priority and duplicate work through the Claude accounts. Off or not installed: no retry until it is switched on or the command exists (checked on each pass). Account failure: the first pass an hour after the last failure tries Jev again; no timer runs. Other Jev errors (timeouts, server errors, bad answers) are retried as before", howLong: "1 hour after an account failure", showsAs: "Accounts page and run logs", kind: "external" },
  { name: "Claude usage pause", why: "Account headroom", howLong: "Until usage reading recovers; re-read every minute", showsAs: "Claude pause reason", kind: "external" },
  { name: "Rate limits", why: "GitHub", howLong: "Per the API's reset", showsAs: "Job log", kind: "external" },
  { name: "Planner fallback", why: "Safety net; the planner normally runs on a change", howLong: "5 minutes", showsAs: "none", kind: "backoff" },
  { name: "Flow summary and vector index", why: "Display and search caches", howLong: "10 and 30 minutes at most; also rebuilt on change", showsAs: "none", kind: "backoff" },
  { name: "Retention", why: "Pruning old rows and logs", howLong: "Days to months", showsAs: "none", kind: "backoff" },
];

export function stageById(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stage ${id}`);
  return s;
}

/** The stage that owns a runner step. */
export function stageOfStep(step: string): StageDef | undefined {
  return STAGES.find((s) => s.steps.some((x) => x.name === step));
}

export function stagesInOrder(): StageDef[] {
  return [...STAGES].sort((a, b) => a.order - b.order);
}

/** Every autopilot lane with its stage, in the autopilot's order. */
export function lanesInOrder(): { name: string; steps: string[]; order: number; stage: StageId }[] {
  return STAGES.flatMap((s) => s.lanes.map((l) => ({ ...l, stage: s.id }))).sort((a, b) => a.order - b.order);
}

/** Steps that have a daily limit setting. */
export function limitSteps(): string[] {
  return STAGES.flatMap((s) => s.steps.filter((x) => x.limit !== undefined).map((x) => x.name));
}

/** Default items per day of the steps that have one. */
export function defaultPerDay(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STAGES) for (const x of s.steps) if (typeof x.limit === "number") out[x.name] = x.limit;
  return out;
}

/** Steps whose limit may only be none or 0. */
export function zeroOnlySteps(): string[] {
  return STAGES.flatMap((s) => s.steps.filter((x) => x.zeroOnly).map((x) => x.name));
}
