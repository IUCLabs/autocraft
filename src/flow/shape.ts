// The flowchart (GET /api/flow) built from summed counts (src/flow/count.ts):
// nodes, branches, links and edges. No Node imports: the web mockup builds its
// flowchart with this file too.
import type { Flow, FlowBranch, FlowEdge, FlowLink, FlowNode, FlowWait } from "../../web/src/api/types.ts";
import { PROMPTS } from "../prompts/index.ts";

export type FlowMeta = {
  repo: string | null;
  now: string;
  lastSync: string | null;
  /** The current classification run. */
  run: string | null;
  /** When the counts were taken (the oldest repo's summary). */
  countedAt: string | null;
  /** Tracked repos without counts yet (the runner counts them on its next passes). */
  uncounted: number;
  /** Runner steps with their stage number. */
  steps: { name: string; stage: number }[];
};

type B = { id: string; label: string; waitsOn: FlowWait; tone: FlowBranch["tone"]; hint?: string; gate?: boolean; link?: FlowLink | null; planned?: boolean };

/** Runner steps (src/runner/steps.ts) each node shows. */
const NODE_STEPS: Record<FlowNode["id"], string[]> = {
  synced: ["embed"], dupes: ["dupes"], classify: ["classify-new", "classify-all", "referee"], priority: ["prioritize", "rank"], decide: ["decide"],
  labels: ["labels-ensure", "labels-apply"], review: ["review-batch", "opus-review", "checks"], fix: ["fixissue", "fixissue-collect"], fixup: ["fixup"],
  verify: ["verify", "verify-collect"], merge: ["merge"], act: ["act"],
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString("en");

export function buildFlow(c: Record<string, number>, meta: FlowMeta): Flow {
  const v = (k: string) => c[k] ?? 0;
  const withRepo = (p: Record<string, string>) => (meta.repo ? { ...p, repo: meta.repo } : p);
  const items = (node: string, b: string): FlowLink => ({ page: "items", params: withRepo({ flow: `${node}.${b}` }) });
  const anyState = (flow: string): FlowLink => ({ page: "items", params: withRepo({ flow, state: "all" }) });
  const queue = (b: string): FlowLink => ({ page: "queue", params: withRepo({ flow: `merge.${b}` }) });

  const node = (id: FlowNode["id"], title: string, stage: number, mode: FlowNode["mode"], summary: string, bs: B[], extra: { recent?: string[]; facts?: FlowNode["facts"]; promptStage?: string } = {}): FlowNode => {
    const branches = bs.map((b): FlowBranch => ({
      id: b.id, label: b.label, count: b.planned ? null : v(`${id}.${b.id}`), waitsOn: b.waitsOn, gate: b.gate ?? false, tone: b.tone,
      link: b.link === undefined ? items(id, b.id) : b.link, hint: b.hint ?? "",
    }));
    const waitsOn = [...new Set(branches.filter((b) => b.count && b.waitsOn !== "nothing").map((b) => b.waitsOn))];
    return {
      id, title, stage, mode, summary, total: mode === "planned" ? null : v(`${id}.total`), branches, waitsOn,
      recent: (extra.recent ?? []).map((l) => ({ label: l === "tries" ? "merge tries" : l, count: v(`${id}.recent.${l}`) })),
      facts: extra.facts ?? [],
      steps: mode === "planned" ? [] : meta.steps.filter((s) => NODE_STEPS[id].includes(s.name)).map((s) => s.name),
      prompts: extra.promptStage ? PROMPTS.filter((p) => p.stage.startsWith(extra.promptStage!)).map((p) => p.id) : [],
    };
  };

  const open = v("synced.total"), openDec = v("x.openDecisions"), repos = v("x.repos");
  const nodes: FlowNode[] = [
    node("synced", "Synced", 1, "auto", `${fmt(v("synced.issues"))} issues · ${fmt(v("synced.prs"))} PRs open`, [
      { id: "issues", label: "Open issues", waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "issue" }) } },
      { id: "prs", label: "Open PRs", waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "pr" }) } },
    ], { recent: ["new", "closed"], facts: [{ label: "Last sync", value: meta.lastSync ?? "never" }] }),
    node("dupes", "Duplicates", 2, "steps", `${plural(v("x.pairsUnchecked"), "pair")} to check · ${fmt(v("dupes.waiting"))} waiting for an answer`, [
      { id: "checking", label: "In a pair being checked", waitsOn: "model", tone: "neutral", hint: "Jev and Haiku have not judged the pair yet" },
      { id: "waiting", label: "Waiting for an answer", waitsOn: "person", gate: true, tone: "accent", hint: "A person decides whether it duplicates another item" },
      { id: "held", label: "Held out", waitsOn: "runner", tone: "warn", hint: "Answered close: held out of later steps until Act closes it" },
      { id: "closed", label: "Closed as duplicate", waitsOn: "nothing", tone: "neutral", link: anyState("dupes.closed") },
    ], { facts: [{ label: "Pairs to check", value: fmt(v("x.pairsUnchecked")) }], promptStage: "Duplicates" }),
    node("classify", "Classify", 3, "steps", `${fmt(v("classify.settled"))} settled of ${fmt(open)}`, [
      { id: "settled", label: "Settled", waitsOn: "nothing", tone: "ok", hint: "Jev at 90 % or more, or Haiku agreeing with Jev" },
      { id: "waiting", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "referee", label: "Waiting for the referee", waitsOn: "model", tone: "warn", hint: "Jev and Haiku chose different labels; Sonnet settles it unless it is a scope call" },
      { id: "disagree", label: "Models disagree", waitsOn: "person", tone: "bad", hint: "Scope calls go to Decide; other disagreements are here when Sonnet was unsure" },
      { id: "unclassified", label: "Not classified yet", waitsOn: "model", tone: "neutral", hint: "No Jev verdict in the current run" },
    ], { recent: ["classified"], facts: [{ label: "Run", value: meta.run ?? "none yet" }], promptStage: "Classify" }),
    node("priority", "Priority", 4, "steps", `${fmt(v("priority.scored") + v("priority.unsure"))} scored · ${fmt(v("priority.todo"))} not yet`, [
      { id: "scored", label: "Scored", waitsOn: "nothing", tone: "ok", hint: "Impact and reach give the work score" },
      { id: "unsure", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "todo", label: "Not scored yet", waitsOn: "model", tone: "neutral", hint: "No score at the item's current text" },
    ], { facts: [{ label: "Top level", value: v("max.topRank") ? `P${4 - Math.floor(v("max.topRank") / 10000)}` : "none yet" }, { label: "Items ranked", value: fmt(v("x.ranked")) }], promptStage: "Priority" }),
    node("decide", "Decide", 5, "gate", openDec ? `${plural(openDec, "decision")} waiting` : "Nothing waiting", [
      { id: "not-asked", label: "Not asked yet", waitsOn: "model", tone: "neutral", hint: "Needs a decision; the decide step writes the question and summary" },
      { id: "open", label: "Waiting for an answer", waitsOn: "person", gate: true, tone: "accent", hint: `${plural(openDec, "open scope decision")}` },
      { id: "take", label: "Wanted in core", waitsOn: "nothing", tone: "ok", hint: "Answered take: PRs go to review" },
      { id: "small-extra", label: "Small extra", waitsOn: "nothing", tone: "ok", hint: "Answered small extra: kept in core, PRs go to review" },
      { id: "plugin", label: "Plug-in candidate", waitsOn: "nothing", tone: "neutral", hint: "Answered plugin: kept open, labelled plugin candidate" },
      { id: "close", label: "Out of scope", waitsOn: "nothing", tone: "neutral", hint: "Answered close: to be closed with a short reason" },
      { id: "need-info", label: "Check the reference app", waitsOn: "nothing", tone: "warn", hint: "Answered need info: asked again once the reference app's behaviour is known" },
    ], { recent: ["asked", "answered"], facts: [{ label: "Open decisions", value: fmt(openDec) }], promptStage: "Decide" }),
    node("labels", "Labels", 6, "steps", `${fmt(v("labels.labelled"))} labelled · ${fmt(v("x.approved"))} of ${plural(repos, "repo")} approved`, [
      { id: "labelled", label: "Labelled on GitHub", waitsOn: "nothing", tone: "ok" },
      { id: "pending", label: "To label", waitsOn: "runner", tone: "neutral", hint: "Settled, in a repo approved for labelling" },
      { id: "unapproved", label: "Repo not approved", waitsOn: "person", gate: true, tone: "warn", hint: "An operator approves labelling per repo on the Repos page" },
    ], { recent: ["labelled"], facts: [{ label: "Repos approved", value: `${fmt(v("x.approved"))} of ${fmt(repos)}` }] }),
    node("review", "Review", 7, "steps", `${fmt(v("review.not-reviewed"))} to review · ${fmt(v("review.total") - v("review.not-reviewed"))} reviewed`, [
      { id: "not-reviewed", label: "Not reviewed yet", waitsOn: "model", tone: "neutral", hint: "No review at the PR's current head commit" },
      { id: "waiting-opus", label: "Waiting for the Opus review", waitsOn: "model", tone: "neutral", hint: "Sonnet rated take or take with fixes; Opus has not reviewed this head" },
      { id: "take", label: "Take", waitsOn: "nothing", tone: "ok" },
      { id: "take-fix", label: "Take with fixes", waitsOn: "nothing", tone: "ok" },
      { id: "hold", label: "Hold", waitsOn: "person", tone: "warn", hint: "Needs a person: reference behaviour, scope, overlaps or too large" },
      { id: "close", label: "Close", waitsOn: "nothing", tone: "bad", hint: "Wrong, not wanted, already done or superseded" },
    ], { recent: ["reviewed"], promptStage: "Review" }),
    node("fix", "Fix", 8, "steps", `${fmt(v("fix.candidates"))} candidates · ${fmt(v("fix.testing"))} in sandbox · ${fmt(v("fix.pr-opened"))} PRs`, [
      { id: "candidates", label: "Candidates", waitsOn: "model", tone: "neutral", hint: "Open bugfix issues without an attempt; Sonnet triages the highest work score first" },
      { id: "retry", label: "Patch due", waitsOn: "model", tone: "neutral", hint: "Triage found a clear fix; Sonnet writes the patch, or the next round" },
      { id: "testing", label: "In sandbox", waitsOn: "sandbox", tone: "neutral", hint: "The patched head and the base commit are built and tested" },
      { id: "passed", label: "Passed, PR next", waitsOn: "runner", tone: "ok", hint: "The next collect pushes the branch and opens the PR" },
      { id: "pr-opened", label: "PR opened", waitsOn: "nothing", tone: "ok", hint: "The PR goes through Review" },
      { id: "skipped", label: "Held: not a clear fix", waitsOn: "person", tone: "warn", hint: "Retried only when the issue text changes" },
      { id: "failed", label: "Held: rounds failed", waitsOn: "person", tone: "bad", hint: "Three failed rounds end the attempt" },
      { id: "unapproved", label: "Repo not approved for fixing", waitsOn: "person", gate: true, tone: "warn", hint: "Candidates in a repo without fix approval; an operator approves it on the Repos page" },
    ], { promptStage: "Fix" }),
    node("fixup", "Fix-up", 9, "steps", `${fmt(v("fixup.fix"))} to fix up · ${fmt(v("fixup.pushed"))} pushed`, [
      { id: "fix", label: "To fix up", waitsOn: "model", tone: "neutral", hint: "Take with fixes: Sonnet patches, then pushes to the PR branch" },
      { id: "pushed", label: "Pushed", waitsOn: "model", tone: "ok", hint: "The new head goes back to Review" },
      { id: "hold", label: "Cannot push (hold)", waitsOn: "person", tone: "warn", hint: "Branch closed to maintainers, patch refused or two tries used; held until the repo is approved for comments" },
      { id: "asked", label: "Asked the contributor", waitsOn: "person", tone: "neutral", hint: "The fixes were posted as a comment; a new head goes back to Review" },
      { id: "unapproved", label: "Repo not approved for pushing", waitsOn: "person", gate: true, tone: "warn", hint: "An operator approves pushing per repo on the Repos page" },
    ], { recent: ["pushed"], promptStage: "Integrate (fix-ups)" }),
    node("verify", "Verify", 10, "steps", `${fmt(v("verify.passed") + v("verify.ci-enough"))} verified · ${fmt(v("verify.waiting"))} to plan`, [
      { id: "waiting", label: "Not planned yet", waitsOn: "model", tone: "neutral", hint: "Taken, CI not failing, no verification at the head commit" },
      { id: "planned", label: "Planned", waitsOn: "sandbox", tone: "neutral", hint: "Tasks queued for a worker" },
      { id: "running", label: "Running", waitsOn: "sandbox", tone: "neutral" },
      { id: "passed", label: "Passed", waitsOn: "nothing", tone: "ok" },
      { id: "ci-enough", label: "CI is enough", waitsOn: "nothing", tone: "ok", hint: "The planner found nothing more to run" },
      { id: "failed", label: "Failed", waitsOn: "person", tone: "bad", hint: "Tests failed; the PR is on hold" },
      { id: "error", label: "Error", waitsOn: "person", tone: "bad", hint: "The plan was invalid or a task errored; retried once" },
    ], { recent: ["finished"], promptStage: "Verify" }),
    node("merge", "Merge queue", 11, "steps", `${fmt(v("merge.eligible"))} may merge now · ${fmt(v("merge.total"))} in the queue`, [
      { id: "eligible", label: "May merge now", waitsOn: "runner", tone: "ok", hint: "Covered by the merge rule or answered merge; CI green, Verify passed and mergeable", link: queue("eligible") },
      { id: "in-batch", label: "In an integration batch", waitsOn: "ci", tone: "accent", hint: "Merged into an integration branch; being checked in the sandbox or waiting for upstream CI on the batch PR", link: queue("in-batch") },
      { id: "unapproved", label: "Repo not approved for merging", waitsOn: "person", gate: true, tone: "warn", hint: "Ready to merge, but an operator has not approved merging in this repo; approve it on the Repos page", link: queue("unapproved") },
      { id: "needs-decision", label: "Waiting for a Merge? answer", waitsOn: "person", gate: true, tone: "accent", hint: "Outside the merge rule, not verified, no CI, or held by an open Duplicate?", link: queue("needs-decision") },
      { id: "waiting-ci", label: "Waiting for CI", waitsOn: "ci", tone: "neutral", link: queue("waiting-ci") },
      { id: "ci-failed", label: "Blocked: CI fails", waitsOn: "ci", tone: "bad", link: queue("ci-failed") },
      { id: "conflict", label: "Blocked: conflicts", waitsOn: "person", tone: "bad", link: queue("conflict") },
      { id: "waiting-verify", label: "Waiting for Verify", waitsOn: "model", tone: "neutral", hint: "No passed verification at the head commit yet", link: queue("waiting-verify") },
      { id: "verify-failed", label: "Blocked: Verify failed", waitsOn: "person", tone: "bad", link: queue("verify-failed") },
      { id: "verify-error", label: "Blocked: Verify error", waitsOn: "person", tone: "bad", link: queue("verify-error") },
      { id: "needs-fix-up", label: "Needs fix-up", waitsOn: "model", tone: "warn", hint: "Take with fixes: waits for the fix-up step", link: queue("needs-fix-up") },
      { id: "batch-failed", label: "Blocked: failed in a batch", waitsOn: "person", tone: "bad", hint: "Failed alone in a batch; on hold until it has a new head", link: queue("batch-failed") },
      { id: "declined", label: "Declined", waitsOn: "nothing", tone: "neutral", hint: "The operator answered hold or close", link: queue("declined") },
      { id: "merged", label: "Merged in the last 24 h", waitsOn: "nothing", tone: "merged", link: queue("merged") },
    ], { recent: ["merged", "tries"], facts: [{ label: "Merged since tracking began", value: fmt(v("x.mergedAll")) }] }),
    node("act", "Act", 12, "steps", `${fmt(v("act.todo"))} to act · ${fmt(v("act.done"))} done in 24 h`, [
      { id: "todo", label: "To comment and close", waitsOn: "runner", tone: "neutral", hint: "Answered close: out of scope, Close this PR or duplicate", link: anyState("act.todo") },
      { id: "failed", label: "Failed, retried", waitsOn: "runner", tone: "bad", hint: "The next run tries again", link: anyState("act.failed") },
      { id: "unapproved", label: "Repo not approved for commenting", waitsOn: "person", gate: true, tone: "warn", hint: "An operator approves commenting per repo on the Repos page", link: anyState("act.unapproved") },
      { id: "done", label: "Done in the last 24 h", waitsOn: "nothing", tone: "merged", link: null },
    ]),
  ];

  const e = (from: FlowEdge["from"], to: FlowEdge["to"], branch: string | null, label: string, planned = false): FlowEdge =>
    ({ from, to, branch, label, count: planned ? null : v(`edge.${from}.${to}`) });
  const edges: FlowEdge[] = [
    e("synced", "dupes", null, "open items"),
    e("dupes", "classify", null, "not held out"),
    e("classify", "priority", null, "open items"),
    e("classify", "decide", null, "needs a decision"),
    e("priority", "decide", null, "scored"),
    e("decide", "labels", null, "type settled"),
    e("decide", "act", null, "answered close"),
    e("labels", "review", null, "PRs to review"),
    e("labels", "fix", null, "issues"),
    e("fix", "review", "pr-opened", "our PR"),
    e("review", "fixup", "take-fix", "take with fixes"),
    e("fixup", "review", "pushed", "new head"),
    e("review", "verify", "take", "taken"),
    e("verify", "merge", "pass", "verified"),
  ];
  return { repo: meta.repo, now: meta.now, lastSync: meta.lastSync, countedAt: meta.countedAt, uncounted: meta.uncounted, nodes, edges };
}
