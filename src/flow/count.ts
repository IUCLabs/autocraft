// Counts for the flowchart (docs/dashboard-spec.md, Flow), one node at a time,
// for one repo or every tracked repo. Each count uses the rule of the stage it
// describes: settled labels (src/classify/settled.ts), scope decisions
// (src/decide/select.ts), review candidates (src/review/candidates.ts) and the
// merge queue (src/merge/queue.ts).
//
// Counts are flat keys that add up across repos:
//   "<node>.<branch>"         items in a branch
//   "<node>.total"            items in the node
//   "<node>.recent.<label>"   movement in the last 24 hours
//   "edge.<from>.<to>"        items on an edge
//   "x.<name>"                other facts (open decisions, approved repos, ...)
// Item-backed branches also return their refs ("repo#n") for the Items
// browser's flow filter.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledTable } from "../classify/settled.ts";
import { latestJevRun, selectCandidates as decideCandidates } from "../decide/select.ts";
import { approvalOf } from "../labels/approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { buildQueue, eligible, type QueueState } from "../merge/queue.ts";
import { trackedNames } from "../repos.ts";
import { candidateRefs, scopeAnswers } from "../review/candidates.ts";
import { selectCandidates as verifyCandidates } from "../verify/candidates.ts";

export type Counts = Record<string, number>;
export type Refs = Set<string>;
export type NodeCount = { counts: Counts; members: Map<string, Refs> };

const DAY = 24 * 3600_000;
const ref = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

/** Scope answers the step that applies them reads (docs/pipeline.md, Scope decisions). */
export const SCOPE_ANSWERS = ["take", "small-extra", "plugin", "close", "need-info"] as const;
export const VERDICTS = ["take", "take-fix", "hold", "close"] as const;

type OpenRow = { repo: string; number: number; kind: string; status: string | null };

/** What the node counters share for one repo (or all repos) on one connection. */
export class Ctx {
  readonly since: string;
  readonly rp: Record<string, string>;
  private openRows?: OpenRow[];
  private openSet?: Refs;
  private answers?: Map<string, string>;
  readonly db: DatabaseSync;
  readonly repo: string | null;
  /** The classification run every counter uses, resolved once. */
  readonly run: string | null;
  private jev?: string | null;
  constructor(db: DatabaseSync, repo: string | null, now = Date.now(), run: string | null = latestRun(db)) {
    this.run = run;
    this.db = db;
    this.repo = repo;
    this.since = new Date(now - DAY).toISOString();
    this.rp = repo ? { repo } : {};
  }
  jevRun(): string | null {
    return this.jev !== undefined ? this.jev : (this.jev = latestJevRun(this.db));
  }
  andRepo(col = "repo"): string {
    return this.repo ? `AND ${col} = :repo` : "";
  }
  inRepo(k: string): boolean {
    return !this.repo || k.startsWith(`${this.repo}#`);
  }
  n(sql: string, params: Record<string, string> = {}): number {
    return (this.db.prepare(sql).get({ ...this.rp, ...params }) as { n: number }).n;
  }
  /** Every open item with its settled status in the current run. */
  open(): OpenRow[] {
    if (!this.openRows) {
      settledTable(this.db, this.run);
      this.openRows = this.db.prepare(`SELECT i.repo, i.number, i.kind, s.status FROM items i
        LEFT JOIN temp.item_settled s ON s.repo = i.repo AND s.number = i.number
        WHERE i.state = 'OPEN' ${this.andRepo("i.repo")}`).all(this.rp) as OpenRow[];
    }
    return this.openRows;
  }
  openRefs(): Refs {
    return (this.openSet ??= new Set(this.open().map(ref)));
  }
  scopeAnswers(): Map<string, string> {
    return (this.answers ??= scopeAnswers(this.db));
  }
  /** Items created or closed since `since`. Over every repo the named date index reads only the last day; for one repo its own rows are fewer. */
  recentItems(col: "created_at" | "closed_at"): number {
    const extra = col === "closed_at" ? "AND state <> 'OPEN'" : "";
    if (this.repo) return this.n(`SELECT COUNT(*) AS n FROM main.items WHERE repo = :repo AND ${col} >= :since ${extra}`, { since: this.since });
    const idx = col === "created_at" ? "items_created" : "items_closed";
    return this.n(`SELECT COUNT(*) AS n FROM main.items INDEXED BY ${idx} WHERE ${col} >= :since ${extra}
      AND repo IN (SELECT name FROM main.tracked_repos)`, { since: this.since });
  }
}

function synced(c: Ctx): NodeCount {
  const open = c.open();
  const prs = open.filter((r) => r.kind === "pr").length;
  return {
    counts: {
      "synced.issues": open.length - prs, "synced.prs": prs, "synced.total": open.length,
      "synced.recent.new": c.recentItems("created_at"), "synced.recent.closed": c.recentItems("closed_at"),
      "edge.synced.classify": open.length,
    },
    members: new Map(),
  };
}

function classify(c: Ctx): NodeCount {
  const by: Counts = { settled: 0, waiting: 0, disagree: 0, unclassified: 0 };
  for (const r of c.open()) by[r.status ?? "unclassified"]!++;
  const run = c.run;
  const recent = run ? c.n(`SELECT COUNT(*) AS n FROM main.classifications INDEXED BY classifications_run WHERE run_id = :run AND classifier = 'jev' AND at >= :since
      AND repo IN (SELECT name FROM main.tracked_repos) ${c.andRepo()}`, { run, since: c.since }) : 0;
  return {
    counts: {
      ...Object.fromEntries(Object.entries(by).map(([k, v]) => [`classify.${k}`, v])),
      "classify.total": c.open().length, "classify.recent.classified": recent, "edge.classify.labels": by.settled!,
    },
    members: new Map(),
  };
}

function decide(c: Ctx): NodeCount {
  const rows = c.db.prepare(`SELECT repo, number, items, answer, asked_at, answered_at FROM decisions WHERE kind = 'scope'`).all() as
    { repo: string | null; number: number | null; items: string | null; answer: string | null; asked_at: string; answered_at: string | null }[];
  const openRefs = c.openRefs();
  const waiting: Refs = new Set();
  let openDecisions = 0, asked = 0, answered = 0;
  for (const d of rows) {
    let refs: string[] = [];
    if (d.number !== null) refs = [`${d.repo}#${d.number}`];
    else try { refs = (JSON.parse(d.items ?? "[]") as { repo: string; number: number }[]).map(ref); } catch { /* malformed batch */ }
    refs = refs.filter((r) => c.inRepo(r));
    if (!refs.length) continue;
    if (d.asked_at >= c.since) asked++;
    if (d.answered_at && d.answered_at >= c.since) answered++;
    if (d.answer !== null) continue;
    openDecisions++;
    for (const r of refs) if (openRefs.has(r)) waiting.add(r);
  }
  const byAnswer = new Map<string, Refs>(SCOPE_ANSWERS.map((a) => [a, new Set()]));
  for (const [r, a] of c.scopeAnswers()) if (openRefs.has(r) && !waiting.has(r) && c.inRepo(r)) byAnswer.get(a)?.add(r);
  const jevRun = c.jevRun();
  const notAsked: Refs = new Set(jevRun ? decideCandidates(c.db, jevRun, c.repo ? [c.repo] : undefined).map(ref) : []);
  const members = new Map<string, Refs>([["decide.not-asked", notAsked], ["decide.open", waiting], ...[...byAnswer].map(([k, v]) => [`decide.${k}`, v] as [string, Refs])]);
  const total = [...members.values()].reduce((a, s) => a + s.size, 0);
  return {
    counts: {
      ...Object.fromEntries([...members].map(([k, v]) => [k, v.size])),
      "decide.total": total, "decide.recent.asked": asked, "decide.recent.answered": answered,
      "x.openDecisions": openDecisions, "edge.classify.decide": total,
    },
    members,
  };
}

function review(c: Ctx): NodeCount {
  const candidates = candidateRefs(c.db, c.repo ?? undefined, c.run);
  const last = c.db.prepare(`WITH last AS (SELECT repo, number, verdict, ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) AS k
      FROM reviews WHERE 1 ${c.andRepo()})
    SELECT l.repo, l.number, l.verdict FROM last l JOIN items i ON i.repo = l.repo AND i.number = l.number
    WHERE l.k = 1 AND i.state = 'OPEN'`).all(c.rp) as { repo: string; number: number; verdict: string }[];
  // A PR waiting for a review at its new head counts there, not under its old verdict.
  const by = new Map<string, Refs>(VERDICTS.map((v) => [v, new Set()]));
  for (const r of last) if (!candidates.has(ref(r))) by.get(r.verdict)?.add(ref(r));
  const members = new Map<string, Refs>([["review.not-reviewed", candidates], ...[...by].map(([k, v]) => [`review.${k}`, v] as [string, Refs])]);
  const all = [...members.values()].flatMap((s) => [...s]);
  const answers = c.scopeAnswers();
  const viaDecide = all.filter((r) => answers.get(r) === "take" || answers.get(r) === "small-extra").length;
  return {
    counts: {
      ...Object.fromEntries([...members].map(([k, v]) => [k, v.size])),
      "review.total": all.length,
      "review.recent.reviewed": c.n(`SELECT COUNT(*) AS n FROM reviews WHERE at >= :since ${c.andRepo()}`, { since: c.since }),
      "edge.classify.review": all.length - viaDecide, "edge.decide.review": viaDecide,
      "edge.review.verify": by.get("take")!.size + by.get("take-fix")!.size,
    },
    members,
  };
}

/** Verification states shown as branches of the Verify node; `stale` ones are not counted. */
export const VERIFY_BRANCHES = ["planned", "running", "passed", "ci-enough", "failed", "error"] as const;

function verify(c: Ctx): NodeCount {
  const by = new Map<string, Refs>([["verify.waiting", new Set()], ...VERIFY_BRANCHES.map((s) => [`verify.${s}`, new Set()] as [string, Refs])]);
  for (const repo of c.repo ? [c.repo] : trackedNames(c.db))
    for (const cand of verifyCandidates(c.db, repo, c.run)) by.get("verify.waiting")!.add(ref(cand));
  // Verifications at the open PR's current head (same head rule as the queue); primary-key joins, no scan of closed PRs' rows.
  const rows = c.db.prepare(`SELECT v.repo, v.number, v.state FROM main.verifications v
    JOIN main.items i ON i.repo = v.repo AND i.number = v.number AND i.state = 'OPEN'
    LEFT JOIN main.pr_checks c ON c.repo = v.repo AND c.number = v.number
    WHERE v.state <> 'stale' AND v.repo IN (SELECT name FROM main.tracked_repos) ${c.andRepo("v.repo")}
      AND v.head_sha = COALESCE(CASE WHEN c.fetched_at IS NOT NULL AND (i.updated_at IS NULL OR c.fetched_at > i.updated_at) THEN c.head_oid END, i.head_oid, c.head_oid)`)
    .all(c.rp) as { repo: string; number: number; state: string }[];
  for (const r of rows) by.get(`verify.${r.state}`)?.add(ref(r));
  const total = [...by.values()].reduce((a, s) => a + s.size, 0);
  const passing = by.get("verify.passed")!.size + by.get("verify.ci-enough")!.size;
  return {
    counts: {
      ...Object.fromEntries([...by].map(([k, v]) => [k, v.size])),
      "verify.total": total,
      "verify.recent.finished": c.n(`SELECT COUNT(*) AS n FROM main.verifications INDEXED BY verifications_finished WHERE finished_at >= :since
        AND state IN ('passed', 'ci-enough', 'failed', 'error') AND repo IN (SELECT name FROM main.tracked_repos) ${c.andRepo()}`, { since: c.since }),
      "edge.verify.merge": passing,
    },
    members: by,
  };
}

function merge(c: Ctx): NodeCount {
  const tracked = new Set(trackedNames(c.db));
  const queue = buildQueue(c.db, { ...(c.repo ? { repo: c.repo } : {}), run: c.run }).filter((e) => tracked.has(e.repo));
  const st = (s: QueueState) => queue.filter((e) => e.state === s).length;
  const approvedRepos = new Set([...new Set(queue.map((e) => e.repo))].filter((r) => mergeApprovalOf(c.db, r)));
  const ready = queue.filter(eligible);
  const since = { since: c.since };
  return {
    counts: {
      "merge.eligible": ready.filter((e) => approvedRepos.has(e.repo)).length,
      "merge.unapproved": ready.filter((e) => !approvedRepos.has(e.repo)).length,
      ...Object.fromEntries((["needs-decision", "waiting-ci", "ci-failed", "conflict", "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "declined"] as const).map((s) => [`merge.${s}`, st(s)])),
      "merge.merged": c.n(`SELECT COUNT(DISTINCT repo || '#' || number) AS n FROM merges WHERE outcome = 'merged' AND at >= :since ${c.andRepo()}`, since),
      "merge.total": queue.length - st("merged"),
      "merge.recent.merged": c.n(`SELECT COUNT(DISTINCT repo || '#' || number) AS n FROM merges WHERE outcome = 'merged' AND at >= :since ${c.andRepo()}`, since),
      "merge.recent.tries": c.n(`SELECT COUNT(*) AS n FROM merges WHERE at >= :since ${c.andRepo()}`, since),
      "x.mergedAll": st("merged"),
    },
    members: new Map(),
  };
}

function labels(c: Ctx): NodeCount {
  const repos = c.repo ? [c.repo] : trackedNames(c.db);
  const approved = new Set(repos.filter((r) => approvalOf(c.db, r)));
  const openRefs = c.openRefs();
  const labelled = new Set((c.db.prepare(`SELECT DISTINCT repo, number FROM stages WHERE stage = 'labeled' ${c.andRepo()}`).all(c.rp) as { repo: string; number: number }[])
    .map(ref).filter((r) => openRefs.has(r)));
  const pending: Refs = new Set(), unapproved: Refs = new Set();
  for (const r of c.open()) {
    if (r.status !== "settled" || labelled.has(ref(r))) continue;
    (approved.has(r.repo) ? pending : unapproved).add(ref(r));
  }
  const members = new Map<string, Refs>([["labels.labelled", labelled], ["labels.pending", pending], ["labels.unapproved", unapproved]]);
  return {
    counts: {
      ...Object.fromEntries([...members].map(([k, v]) => [k, v.size])),
      "labels.total": labelled.size + pending.size + unapproved.size,
      "labels.recent.labelled": c.n(`SELECT COUNT(*) AS n FROM stages WHERE stage = 'labeled' AND at >= :since ${c.andRepo()}`, { since: c.since }),
      "x.repos": repos.length, "x.approved": approved.size,
    },
    members,
  };
}

export const COUNTERS = { synced, classify, decide, labels, review, verify, merge } as const;
export type CountedNode = keyof typeof COUNTERS;

/** Every count for one repo, or for every tracked repo when `repo` is null. */
export function countAll(db: DatabaseSync, repo: string | null, now = Date.now(), run: string | null = latestRun(db)): NodeCount {
  const c = new Ctx(db, repo, now, run);
  const out: NodeCount = { counts: {}, members: new Map() };
  for (const f of Object.values(COUNTERS)) {
    const r = f(c);
    Object.assign(out.counts, r.counts);
    for (const [k, v] of r.members) out.members.set(k, v);
  }
  return out;
}

/** The refs of one item-backed branch (`<node>.<branch>`) over every tracked repo, or null when the key names none. */
export function branchMembers(db: DatabaseSync, key: string): Refs | null {
  const node = key.split(".")[0] as CountedNode;
  if (!Object.hasOwn(COUNTERS, node)) return null;
  return COUNTERS[node](new Ctx(db, null)).members.get(key) ?? null;
}
