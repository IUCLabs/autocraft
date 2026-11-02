// GET /api/flow: the pipeline as a flowchart for the home page. Every node of
// docs/pipeline.md with its items split into branches, the edges between nodes
// with counts, movement in the last 24 hours, and the runner steps and prompts
// of each stage. Counts use the same rules as the stages themselves: settled
// labels (src/classify/settled.ts), scope decisions (src/decide/select.ts),
// review candidates (src/review/candidates.ts) and the merge queue
// (src/merge/queue.ts). Read-only, anyone signed in.
import type { DatabaseSync } from "node:sqlite";
import type { Flow, FlowBranch, FlowEdge, FlowLink, FlowNode, FlowWait } from "../../../web/src/api/types.ts";
import { latestRun, settledTable } from "../../classify/settled.ts";
import { latestJevRun, selectCandidates as decideCandidates } from "../../decide/select.ts";
import { SCOPE_OPTIONS } from "../../decide/decision.ts";
import { approvalOf } from "../../labels/approval.ts";
import { buildQueue, eligible, type QueueState } from "../../merge/queue.ts";
import { PROMPTS } from "../../prompts/index.ts";
import { trackedNames } from "../../repos.ts";
import { candidateRefs, scopeAnswers } from "../../review/candidates.ts";
import { loadSteps } from "../../runner/steps.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

const DAY = 24 * 3600_000;
// Through the scoping view the planner scans by repo; named date indexes on main.items read only the last day.
const TRACKED = "repo IN (SELECT name FROM main.tracked_repos)";

type Refs = Set<string>;
const ref = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

type Model = { flow: Flow; members: Map<string, Refs> };

type B = Omit<FlowBranch, "count" | "gate" | "link" | "hint"> & { count: number | null; gate?: boolean; link?: FlowLink | null; hint?: string };

/** The scope decision answers the step that applies them reads (docs/pipeline.md, Scope decisions). */
const ANSWERS: { key: keyof typeof SCOPE_OPTIONS; label: string; tone: FlowBranch["tone"]; hint: string }[] = [
  { key: "take", label: "Wanted in core", tone: "ok", hint: "Answered take: PRs go to review" },
  { key: "small-extra", label: "Small extra", tone: "ok", hint: "Answered small extra: kept in core, PRs go to review" },
  { key: "plugin", label: "Plug-in candidate", tone: "neutral", hint: "Answered plugin: kept open, labelled plugin candidate" },
  { key: "close", label: "Out of scope", tone: "neutral", hint: "Answered close: to be closed with a short reason" },
  { key: "need-info", label: "Check the reference app", tone: "warn", hint: "Answered need info: asked again once the reference app's behaviour is known" },
];

export function flowModel(db: DatabaseSync, repo: string | null): Model {
  const now = Date.now();
  const since = new Date(now - DAY).toISOString();
  const rp: Record<string, string> = repo ? { repo } : {};
  const andRepo = (col = "repo") => (repo ? `AND ${col} = :repo` : "");
  const inRepo = (k: string) => !repo || k.startsWith(`${repo}#`);
  const members = new Map<string, Refs>();
  const put = (key: string, refs: Refs) => (members.set(key, refs), refs.size);
  const count1 = (sql: string, params: Record<string, string> = {}) => (db.prepare(sql).get({ ...rp, ...params }) as { n: number }).n;
  const withRepo = (params: Record<string, string>) => (repo ? { ...params, repo } : params);

  // ---- Synced: every open item, with its settled verdict
  const run = latestRun(db);
  settledTable(db, run);
  const open = db.prepare(`SELECT i.repo, i.number, i.kind, s.status, s.label FROM items i
    LEFT JOIN temp.item_settled s ON s.repo = i.repo AND s.number = i.number
    WHERE i.state = 'OPEN' ${andRepo("i.repo")}`).all(rp) as { repo: string; number: number; kind: string; status: string | null; label: string | null }[];
  const openRefs = new Set(open.map(ref));
  const prs = open.filter((r) => r.kind === "pr").length;
  const lastSync = (db.prepare(`SELECT MAX(ended_at) AS t FROM sync_runs WHERE error IS NULL`).get() as { t: string | null }).t
    ?? (db.prepare("SELECT value AS t FROM settings WHERE key = 'org_high_water'").get() as { t: string } | undefined)?.t ?? null;

  // ---- Classify
  const byStatus = { settled: 0, waiting: 0, disagree: 0, unclassified: 0 };
  for (const r of open) byStatus[(r.status ?? "unclassified") as keyof typeof byStatus]++;
  const classified24 = run ? count1(`SELECT COUNT(*) AS n FROM classifications WHERE run_id = :run AND classifier = 'jev' AND at >= :since ${andRepo()}`, { run, since }) : 0;

  // ---- Decide: scope decisions per open item; a batch counts for each of its items
  const scope = db.prepare(`SELECT repo, number, items, answer, asked_at, answered_at FROM decisions WHERE kind = 'scope'`).all() as
    { repo: string | null; number: number | null; items: string | null; answer: string | null; asked_at: string; answered_at: string | null }[];
  const refsOf = (d: (typeof scope)[number]): string[] => {
    if (d.number !== null) return [`${d.repo}#${d.number}`];
    try {
      return (JSON.parse(d.items ?? "[]") as { repo: string; number: number }[]).map(ref);
    } catch { return []; }
  };
  const openDecided: Refs = new Set();
  let openDecisions = 0, asked24 = 0, answered24 = 0;
  for (const d of scope) {
    const refs = refsOf(d).filter(inRepo);
    if (!refs.length) continue;
    if (d.asked_at >= since) asked24++;
    if (d.answered_at && d.answered_at >= since) answered24++;
    if (d.answer !== null) continue;
    openDecisions++;
    for (const r of refs) if (openRefs.has(r)) openDecided.add(r);
  }
  const answers = scopeAnswers(db);
  const byAnswer = new Map<string, Refs>(ANSWERS.map((a) => [a.key, new Set()]));
  for (const [r, a] of answers) if (openRefs.has(r) && !openDecided.has(r)) byAnswer.get(a)?.add(r);
  const jevRun = latestJevRun(db);
  const notAsked: Refs = new Set(jevRun ? decideCandidates(db, jevRun, repo ? [repo] : undefined).map(ref) : []);
  const decideTotal = notAsked.size + openDecided.size + [...byAnswer.values()].reduce((a, s) => a + s.size, 0);

  // ---- Review: open PRs we review; a PR waiting for review at its head counts there, not under its old verdict
  const candidates = candidateRefs(db, repo ?? undefined);
  const last = db.prepare(`WITH last AS (SELECT repo, number, verdict, ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) AS k
      FROM reviews WHERE 1 ${andRepo()})
    SELECT l.repo, l.number, l.verdict FROM last l JOIN items i ON i.repo = l.repo AND i.number = l.number
    WHERE l.k = 1 AND i.state = 'OPEN'`).all(rp) as { repo: string; number: number; verdict: string }[];
  const byVerdict = new Map<string, Refs>(["take", "take-fix", "hold", "close"].map((v) => [v, new Set()]));
  for (const r of last) if (!candidates.has(ref(r))) byVerdict.get(r.verdict)?.add(ref(r));
  const reviewPop = new Set([...candidates, ...[...byVerdict.values()].flatMap((s) => [...s])]);
  const viaDecide = [...reviewPop].filter((r) => answers.get(r) === "take" || answers.get(r) === "small-extra").length;
  const reviewed24 = count1(`SELECT COUNT(*) AS n FROM reviews WHERE at >= :since ${andRepo()}`, { since });
  const taken = byVerdict.get("take")!.size + byVerdict.get("take-fix")!.size;

  // ---- Merge queue
  const tracked = new Set(trackedNames(db));
  const queue = buildQueue(db, repo ? { repo } : {}).filter((e) => tracked.has(e.repo));
  const qs = (pred: (e: (typeof queue)[number]) => boolean): number => queue.filter(pred).length;
  const st = (s: QueueState) => qs((e) => e.state === s);
  const merged24 = count1(`SELECT COUNT(DISTINCT repo || '#' || number) AS n FROM merges WHERE outcome = 'merged' AND at >= :since ${andRepo()}`, { since });
  const tried24 = count1(`SELECT COUNT(*) AS n FROM merges WHERE at >= :since ${andRepo()}`, { since });
  const inQueue = qs((e) => e.state !== "merged");

  // ---- Labels
  const repos = repo ? [repo] : [...tracked];
  const approved = new Set(repos.filter((r) => approvalOf(db, r)));
  const labelled = new Set((db.prepare(`SELECT DISTINCT repo, number FROM stages WHERE stage = 'labeled' ${andRepo()}`).all(rp) as { repo: string; number: number }[])
    .map(ref).filter((r) => openRefs.has(r)));
  const toLabel: Refs = new Set(), unapproved: Refs = new Set();
  for (const r of open) {
    if (r.status !== "settled" || labelled.has(ref(r))) continue;
    (approved.has(r.repo) ? toLabel : unapproved).add(ref(r));
  }
  const labelled24 = count1(`SELECT COUNT(*) AS n FROM stages WHERE stage = 'labeled' AND at >= :since ${andRepo()}`, { since });

  // ---- assemble
  const items = (node: string, branch: string): FlowLink => ({ page: "items", params: withRepo({ flow: `${node}.${branch}` }) });
  const promptsOf = (title: string) => PROMPTS.filter((p) => p.stage.startsWith(title)).map((p) => p.id);
  const node = (n: Omit<FlowNode, "waitsOn" | "branches"> & { branches: B[] }): FlowNode => {
    const branches = n.branches.map((b): FlowBranch => ({ gate: false, link: null, hint: "", ...b }));
    const waits = new Set<FlowWait>();
    for (const b of branches) if (b.count && b.waitsOn !== "nothing") waits.add(b.waitsOn);
    return { ...n, branches, waitsOn: [...waits] };
  };

  const nodes: FlowNode[] = [
    node({
      id: "synced", title: "Synced", stage: 1, mode: "auto", total: open.length,
      summary: `${open.length - prs} issues · ${prs} PRs open`,
      branches: [
        { id: "issues", label: "Open issues", count: open.length - prs, waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "issue" }) } },
        { id: "prs", label: "Open PRs", count: prs, waitsOn: "nothing", tone: "neutral", link: { page: "items", params: withRepo({ kind: "pr" }) } },
      ],
      recent: [
        { label: "new", count: count1(`SELECT COUNT(*) AS n FROM main.items INDEXED BY items_created WHERE created_at >= :since AND ${TRACKED} ${andRepo()}`, { since }) },
        { label: "closed", count: count1(`SELECT COUNT(*) AS n FROM main.items INDEXED BY items_closed WHERE closed_at >= :since AND state <> 'OPEN' AND ${TRACKED} ${andRepo()}`, { since }) },
      ],
      facts: [{ label: "Last sync", value: lastSync ?? "never" }],
      steps: [], prompts: [],
    }),
    node({
      id: "classify", title: "Classify", stage: 2, mode: "steps", total: open.length,
      summary: `${byStatus.settled} settled of ${open.length}`,
      branches: [
        { id: "settled", label: "Settled", count: byStatus.settled, waitsOn: "nothing", tone: "ok", hint: "Jev at 90 % or more, or Haiku agreeing with Jev",
          link: { page: "items", params: withRepo({ status: "settled" }) } },
        { id: "waiting", label: "Waiting for a second opinion", count: byStatus.waiting, waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet",
          link: { page: "items", params: withRepo({ status: "waiting" }) } },
        { id: "disagree", label: "Models disagree", count: byStatus.disagree, waitsOn: "person", tone: "bad", hint: "Haiku chose another label; a referee or a person settles it",
          link: { page: "items", params: withRepo({ status: "disagree" }) } },
        { id: "unclassified", label: "Not classified yet", count: byStatus.unclassified, waitsOn: "model", tone: "neutral", hint: "No Jev verdict in the current run",
          link: { page: "items", params: withRepo({ status: "unclassified" }) } },
      ],
      recent: [{ label: "classified", count: classified24 }],
      facts: [{ label: "Run", value: run ?? "none yet" }],
      steps: [], prompts: promptsOf("Classify"),
    }),
    node({
      id: "decide", title: "Decide", stage: 3, mode: "gate", total: decideTotal,
      summary: openDecisions ? `${openDecisions} decision${openDecisions === 1 ? "" : "s"} waiting` : "Nothing waiting",
      branches: [
        { id: "not-asked", label: "Not asked yet", count: put("decide.not-asked", notAsked), waitsOn: "model", tone: "neutral",
          hint: "Needs a decision; the decide step writes the question and summary", link: items("decide", "not-asked") },
        { id: "open", label: "Waiting for an answer", count: put("decide.open", openDecided), waitsOn: "person", gate: true, tone: "accent",
          hint: `${openDecisions} open scope decision${openDecisions === 1 ? "" : "s"}`, link: { page: "decisions", params: withRepo({ kind: "scope" }) } },
        ...ANSWERS.map((a): B => ({ id: a.key, label: a.label, count: put(`decide.${a.key}`, byAnswer.get(a.key)!), waitsOn: "nothing", tone: a.tone, hint: a.hint, link: items("decide", a.key) })),
      ],
      recent: [{ label: "asked", count: asked24 }, { label: "answered", count: answered24 }],
      facts: [{ label: "Open decisions", value: String(openDecisions) }],
      steps: [], prompts: promptsOf("Decide"),
    }),
    node({
      id: "labels", title: "Labels", stage: 4, mode: "steps", total: byStatus.settled,
      summary: `${labelled.size} labelled · ${approved.size} of ${repos.length} repo${repos.length === 1 ? "" : "s"} approved`,
      branches: [
        { id: "labelled", label: "Labelled on GitHub", count: put("labels.labelled", labelled), waitsOn: "nothing", tone: "ok", link: items("labels", "labelled") },
        { id: "pending", label: "To label", count: put("labels.pending", toLabel), waitsOn: "runner", tone: "neutral",
          hint: "Settled, in a repo approved for labelling", link: items("labels", "pending") },
        { id: "unapproved", label: "Repo not approved", count: put("labels.unapproved", unapproved), waitsOn: "person", gate: true, tone: "warn",
          hint: "An operator approves labelling per repo on the Repos page", link: items("labels", "unapproved") },
      ],
      recent: [{ label: "labelled", count: labelled24 }],
      facts: [{ label: "Repos approved", value: `${approved.size} of ${repos.length}` }],
      steps: [], prompts: [],
    }),
    node({
      id: "review", title: "Review", stage: 5, mode: "steps", total: reviewPop.size,
      summary: `${candidates.size} to review · ${reviewPop.size - candidates.size} reviewed`,
      branches: [
        { id: "not-reviewed", label: "Not reviewed yet", count: put("review.not-reviewed", candidates), waitsOn: "model", tone: "neutral",
          hint: "No review at the PR's current head commit", link: items("review", "not-reviewed") },
        { id: "take", label: "Take", count: put("review.take", byVerdict.get("take")!), waitsOn: "nothing", tone: "ok", link: items("review", "take") },
        { id: "take-fix", label: "Take with fixes", count: put("review.take-fix", byVerdict.get("take-fix")!), waitsOn: "nothing", tone: "ok", link: items("review", "take-fix") },
        { id: "hold", label: "Hold", count: put("review.hold", byVerdict.get("hold")!), waitsOn: "person", tone: "warn",
          hint: "Needs a person: reference behaviour, scope, overlaps or too large", link: items("review", "hold") },
        { id: "close", label: "Close", count: put("review.close", byVerdict.get("close")!), waitsOn: "nothing", tone: "bad",
          hint: "Wrong, not wanted, already done or superseded", link: items("review", "close") },
      ],
      recent: [{ label: "reviewed", count: reviewed24 }],
      facts: [],
      steps: [], prompts: promptsOf("Review"),
    }),
    node({
      id: "verify", title: "Verify", stage: 6, mode: "planned", total: null,
      summary: "Planned: tests, builds or screenshots, chosen per PR",
      branches: [
        { id: "pass", label: "Passes", count: null, waitsOn: "nothing", tone: "ok" },
        { id: "fail", label: "Fails: back to fix-up", count: null, waitsOn: "nothing", tone: "bad" },
      ],
      recent: [], facts: [], steps: [], prompts: [],
    }),
    node({
      id: "merge", title: "Merge queue", stage: 6, mode: "steps", total: inQueue,
      summary: `${qs(eligible)} may merge now · ${inQueue} in the queue`,
      branches: [
        { id: "eligible", label: "May merge now", count: qs(eligible), waitsOn: "runner", tone: "ok", hint: "Covered by the merge rule or answered merge; CI green and mergeable",
          link: { page: "queue", params: withRepo({}) } },
        { id: "needs-decision", label: "Waiting for a Merge? answer", count: st("needs-decision"), waitsOn: "person", gate: true, tone: "accent",
          hint: "Outside the merge rule", link: { page: "decisions", params: withRepo({ kind: "merge" }) } },
        { id: "waiting-ci", label: "Waiting for CI", count: st("waiting-ci"), waitsOn: "ci", tone: "neutral", link: { page: "queue", params: withRepo({ state: "waiting-ci" }) } },
        { id: "ci-failed", label: "Blocked: CI fails", count: st("ci-failed"), waitsOn: "ci", tone: "bad", link: { page: "queue", params: withRepo({ state: "ci-failed" }) } },
        { id: "conflict", label: "Blocked: conflicts", count: st("conflict"), waitsOn: "person", tone: "bad", link: { page: "queue", params: withRepo({ state: "conflict" }) } },
        { id: "needs-fix-up", label: "Needs fix-up", count: st("needs-fix-up"), waitsOn: "model", tone: "warn", hint: "Take with fixes: waits for the fix-up step",
          link: { page: "queue", params: withRepo({ state: "needs-fix-up" }) } },
        { id: "declined", label: "Declined", count: st("declined"), waitsOn: "nothing", tone: "neutral", hint: "The operator answered hold or close",
          link: { page: "queue", params: withRepo({ state: "declined" }) } },
        { id: "merged", label: "Merged in the last 24 h", count: merged24, waitsOn: "nothing", tone: "merged", link: { page: "queue", params: withRepo({ state: "merged" }) } },
      ],
      recent: [{ label: "merged", count: merged24 }, { label: "merge tries", count: tried24 }],
      facts: [{ label: "Merged since tracking began", value: String(st("merged")) }],
      steps: [], prompts: [],
    }),
  ];

  const edges: FlowEdge[] = [
    { from: "synced", to: "classify", branch: null, label: "open items", count: open.length },
    { from: "classify", to: "labels", branch: "settled", label: "settled", count: byStatus.settled },
    { from: "classify", to: "decide", branch: null, label: "needs a decision", count: decideTotal },
    { from: "classify", to: "review", branch: "settled", label: "PRs to review", count: reviewPop.size - viaDecide },
    { from: "decide", to: "review", branch: "take", label: "wanted PRs", count: viaDecide },
    { from: "review", to: "verify", branch: "take", label: "taken", count: taken },
    { from: "verify", to: "merge", branch: "pass", label: "passes straight through today", count: null },
  ];

  return { flow: { repo, now: new Date(now).toISOString(), lastSync, nodes, edges }, members };
}

const repoParam = (db: DatabaseSync, req: Req): string | null => {
  const repo = req.query.get("repo") || null;
  if (repo && !trackedNames(db).includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  return repo;
};

// A model is kept until the tables it reads change, or for a minute at most
// (the 24-hour windows move and buildQueue reads whitelist stats).
const cache = new WeakMap<DatabaseSync, Map<string, { sig: string; at: number; model: Model }>>();
const MAX_AGE = 60_000;

function signature(db: DatabaseSync): string {
  return JSON.stringify(db.prepare(`SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM main.classifications) AS c,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(asked_at), '') || ':' || COALESCE(MAX(answered_at), '') || ':' || COUNT(answer) FROM main.decisions) AS d,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM main.stages) AS s,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(at), '') FROM main.reviews) AS r,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(at), '') FROM main.merges) AS m,
      (SELECT COALESCE(MAX(fetched_at), '') FROM main.pr_checks) AS p,
      (SELECT MAX(synced_at) FROM main.repos) AS y,
      (SELECT group_concat(key || '=' || value) FROM main.settings WHERE key IN ('org_high_water', 'classify_run') OR key LIKE 'labels_approved:%') AS k,
      (SELECT group_concat(name) FROM main.tracked_repos) AS t`).get());
}

function cachedModel(db: DatabaseSync, repo: string | null): Model {
  const sig = signature(db);
  const per = cache.get(db) ?? cache.set(db, new Map()).get(db)!;
  const hit = per.get(repo ?? "");
  if (hit && hit.sig === sig && Date.now() - hit.at < MAX_AGE) return hit.model;
  const model = flowModel(db, repo);
  per.set(repo ?? "", { sig, at: Date.now(), model });
  return model;
}


export async function flow(db: DatabaseSync, req: Req): Promise<Flow> {
  const flow = cachedModel(db, repoParam(db, req)).flow;
  const steps = [...(await loadSteps()).values()];
  return { ...flow, nodes: flow.nodes.map((n) => ({ ...n, steps: n.mode === "planned" ? [] : steps.filter((s) => s.stage === n.stage).map((s) => s.name) })) };
}

/** The refs a `flow=<node>.<branch>` filter of the Items browser picks, or null for a branch without its own item set. */
export function flowMembers(db: DatabaseSync, key: string): Refs | null {
  return cachedModel(db, null).members.get(key) ?? null;
}
