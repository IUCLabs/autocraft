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

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString("en");

export function buildFlow(c: Record<string, number>, meta: FlowMeta): Flow {
  const v = (k: string) => c[k] ?? 0;
  const withRepo = (p: Record<string, string>) => (meta.repo ? { ...p, repo: meta.repo } : p);
  const items = (node: string, b: string): FlowLink => ({ page: "items", params: withRepo({ flow: `${node}.${b}` }) });
  const queue = (state?: string): FlowLink => ({ page: "queue", params: withRepo(state ? { state } : {}) });

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
      steps: mode === "planned" ? [] : meta.steps.filter((s) => s.stage === stage).map((s) => s.name),
      prompts: extra.promptStage ? PROMPTS.filter((p) => p.stage.startsWith(extra.promptStage!)).map((p) => p.id) : [],
    };
  };

  const open = v("synced.total"), openDec = v("x.openDecisions"), repos = v("x.repos");
  const nodes: FlowNode[] = [
    node("synced", "Synced", 1, "auto", `${fmt(v("synced.issues"))} issues · ${fmt(v("synced.prs"))} PRs open`, [
      { id: "issues", label: "Open issues", waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "issue" }) } },
      { id: "prs", label: "Open PRs", waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "pr" }) } },
    ], { recent: ["new", "closed"], facts: [{ label: "Last sync", value: meta.lastSync ?? "never" }] }),
    node("classify", "Classify", 2, "steps", `${fmt(v("classify.settled"))} settled of ${fmt(open)}`, [
      { id: "settled", label: "Settled", waitsOn: "nothing", tone: "ok", hint: "Jev at 90 % or more, or Haiku agreeing with Jev", link: { page: "items", params: withRepo({ status: "settled" }) } },
      { id: "waiting", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet", link: { page: "items", params: withRepo({ status: "waiting" }) } },
      { id: "disagree", label: "Models disagree", waitsOn: "person", tone: "bad", hint: "Haiku chose another label; a referee or a person settles it", link: { page: "items", params: withRepo({ status: "disagree" }) } },
      { id: "unclassified", label: "Not classified yet", waitsOn: "model", tone: "neutral", hint: "No Jev verdict in the current run", link: { page: "items", params: withRepo({ status: "unclassified" }) } },
    ], { recent: ["classified"], facts: [{ label: "Run", value: meta.run ?? "none yet" }], promptStage: "Classify" }),
    node("decide", "Decide", 3, "gate", openDec ? `${plural(openDec, "decision")} waiting` : "Nothing waiting", [
      { id: "not-asked", label: "Not asked yet", waitsOn: "model", tone: "neutral", hint: "Needs a decision; the decide step writes the question and summary" },
      { id: "open", label: "Waiting for an answer", waitsOn: "person", gate: true, tone: "accent", hint: `${plural(openDec, "open scope decision")}`, link: { page: "decisions", params: withRepo({ kind: "scope" }) } },
      { id: "take", label: "Wanted in core", waitsOn: "nothing", tone: "ok", hint: "Answered take: PRs go to review" },
      { id: "small-extra", label: "Small extra", waitsOn: "nothing", tone: "ok", hint: "Answered small extra: kept in core, PRs go to review" },
      { id: "plugin", label: "Plug-in candidate", waitsOn: "nothing", tone: "neutral", hint: "Answered plugin: kept open, labelled plugin candidate" },
      { id: "close", label: "Out of scope", waitsOn: "nothing", tone: "neutral", hint: "Answered close: to be closed with a short reason" },
      { id: "need-info", label: "Check the reference app", waitsOn: "nothing", tone: "warn", hint: "Answered need info: asked again once the reference app's behaviour is known" },
    ], { recent: ["asked", "answered"], facts: [{ label: "Open decisions", value: fmt(openDec) }], promptStage: "Decide" }),
    node("labels", "Labels", 4, "steps", `${fmt(v("labels.labelled"))} labelled · ${fmt(v("x.approved"))} of ${plural(repos, "repo")} approved`, [
      { id: "labelled", label: "Labelled on GitHub", waitsOn: "nothing", tone: "ok" },
      { id: "pending", label: "To label", waitsOn: "runner", tone: "neutral", hint: "Settled, in a repo approved for labelling" },
      { id: "unapproved", label: "Repo not approved", waitsOn: "person", gate: true, tone: "warn", hint: "An operator approves labelling per repo on the Repos page" },
    ], { recent: ["labelled"], facts: [{ label: "Repos approved", value: `${fmt(v("x.approved"))} of ${fmt(repos)}` }] }),
    node("review", "Review", 5, "steps", `${fmt(v("review.not-reviewed"))} to review · ${fmt(v("review.total") - v("review.not-reviewed"))} reviewed`, [
      { id: "not-reviewed", label: "Not reviewed yet", waitsOn: "model", tone: "neutral", hint: "No review at the PR's current head commit" },
      { id: "take", label: "Take", waitsOn: "nothing", tone: "ok" },
      { id: "take-fix", label: "Take with fixes", waitsOn: "nothing", tone: "ok" },
      { id: "hold", label: "Hold", waitsOn: "person", tone: "warn", hint: "Needs a person: reference behaviour, scope, overlaps or too large" },
      { id: "close", label: "Close", waitsOn: "nothing", tone: "bad", hint: "Wrong, not wanted, already done or superseded" },
    ], { recent: ["reviewed"], promptStage: "Review" }),
    node("verify", "Verify", 6, "steps", `${fmt(v("verify.passed") + v("verify.ci-enough"))} verified · ${fmt(v("verify.waiting"))} to plan`, [
      { id: "waiting", label: "Not planned yet", waitsOn: "model", tone: "neutral", hint: "Taken, CI not failing, no verification at the head commit" },
      { id: "planned", label: "Planned", waitsOn: "sandbox", tone: "neutral", hint: "Tasks queued for a worker" },
      { id: "running", label: "Running", waitsOn: "sandbox", tone: "neutral" },
      { id: "passed", label: "Passed", waitsOn: "nothing", tone: "ok" },
      { id: "ci-enough", label: "CI is enough", waitsOn: "nothing", tone: "ok", hint: "The planner found nothing more to run" },
      { id: "failed", label: "Failed", waitsOn: "person", tone: "bad", hint: "Tests failed; the PR is on hold" },
      { id: "error", label: "Error", waitsOn: "person", tone: "bad", hint: "The plan was invalid or a task errored; retried once" },
    ], { recent: ["finished"], promptStage: "Verify" }),
    node("merge", "Merge queue", 6, "steps", `${fmt(v("merge.eligible"))} may merge now · ${fmt(v("merge.total"))} in the queue`, [
      { id: "eligible", label: "May merge now", waitsOn: "runner", tone: "ok", hint: "Covered by the merge rule or answered merge; CI green, Verify passed and mergeable", link: queue() },
      { id: "unapproved", label: "Repo not approved for merging", waitsOn: "person", gate: true, tone: "warn", hint: "Ready to merge, but an operator has not approved merging in this repo; approve it on the Repos page", link: null },
      { id: "needs-decision", label: "Waiting for a Merge? answer", waitsOn: "person", gate: true, tone: "accent", hint: "Outside the merge rule", link: { page: "decisions", params: withRepo({ kind: "merge" }) } },
      { id: "waiting-ci", label: "Waiting for CI", waitsOn: "ci", tone: "neutral", link: queue("waiting-ci") },
      { id: "ci-failed", label: "Blocked: CI fails", waitsOn: "ci", tone: "bad", link: queue("ci-failed") },
      { id: "conflict", label: "Blocked: conflicts", waitsOn: "person", tone: "bad", link: queue("conflict") },
      { id: "waiting-verify", label: "Waiting for Verify", waitsOn: "model", tone: "neutral", hint: "No passed verification at the head commit yet", link: queue("waiting-verify") },
      { id: "verify-failed", label: "Blocked: Verify failed", waitsOn: "person", tone: "bad", link: queue("verify-failed") },
      { id: "verify-error", label: "Blocked: Verify error", waitsOn: "person", tone: "bad", link: queue("verify-error") },
      { id: "needs-fix-up", label: "Needs fix-up", waitsOn: "model", tone: "warn", hint: "Take with fixes: waits for the fix-up step", link: queue("needs-fix-up") },
      { id: "declined", label: "Declined", waitsOn: "nothing", tone: "neutral", hint: "The operator answered hold or close", link: queue("declined") },
      { id: "merged", label: "Merged in the last 24 h", waitsOn: "nothing", tone: "merged", link: queue("merged") },
    ], { recent: ["merged", "tries"], facts: [{ label: "Merged since tracking began", value: fmt(v("x.mergedAll")) }] }),
  ];

  const e = (from: FlowEdge["from"], to: FlowEdge["to"], branch: string | null, label: string, planned = false): FlowEdge =>
    ({ from, to, branch, label, count: planned ? null : v(`edge.${from}.${to}`) });
  const edges: FlowEdge[] = [
    e("synced", "classify", null, "open items"),
    e("classify", "labels", "settled", "settled"),
    e("classify", "decide", null, "needs a decision"),
    e("classify", "review", "settled", "PRs to review"),
    e("decide", "review", "take", "wanted PRs"),
    e("review", "verify", "take", "taken"),
    e("verify", "merge", "pass", "verified"),
  ];
  return { repo: meta.repo, now: meta.now, lastSync: meta.lastSync, countedAt: meta.countedAt, uncounted: meta.uncounted, nodes, edges };
}
