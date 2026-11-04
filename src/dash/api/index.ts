// JSON API for the dashboard frontend (web/src/api/client.ts `Api`). The
// server has already checked the session, and on POSTs the Origin, the CSRF
// header and the per-session limits; these handlers check roles and GitHub
// permissions themselves. Item and comment text is returned as data only.
import { checksOf } from "../../patchcheck/index.ts";
import { priorityOf } from "../../priority/read.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CiState, DecisionKind, Done, Funnel, Item, ItemAction, ItemComment, ItemFixup, ItemPremerge, ItemReviews, ItemVerification, ReviewSide, Mergeable, Progress, RepoProgress, Tier, User,
} from "../../../web/src/api/types.ts";
import { trackedNames } from "../../repos.ts";
import { excludeHidden, hiddenRepos, needVisible, visibleRepos } from "./visible.ts";
import { withoutHidden } from "./decisions.ts";
import { contributors } from "../../whitelist.ts";
import { CLOSED_ITEMS, TRACKED, doneByRepo, funnelByRepo, latestCte, trackingStart, trend, type DoneRow, type FunnelRow } from "./stats.ts";
import { HttpError, RateLimiter } from "../server/util.ts";
import { findingsOf, type PremergeRow } from "../../premerge/store.ts";
import type { Req, Res, Route } from "../types.ts";
import * as adm from "./admin.ts";
import * as agents from "./agents.ts";
import * as build from "./build.ts";
import * as dec from "./decisions.ts";
import * as conv from "./conversations.ts";
import * as areas from "./areas.ts";
import * as directions from "./directions.ts";
import * as insight from "./insight.ts";
import * as pipeline from "./pipeline.ts";
import { prompts } from "./prompts.ts";
import { queue, queueBatches } from "./queue.ts";
import { githubActivity } from "./github-activity.ts";
import { work } from "./work.ts";
import { flow } from "./flow.ts";
import { queueSlots } from "../../rank/position.ts";
import * as items from "./items.ts";
import { postmergeOf } from "./postmerge.ts";
import { canSeeInternals } from "./staff.ts";
import * as operator from "./operator.ts";
import { actionsOf as releasesOf } from "../../operator-actions.ts";
import { verificationOf } from "../../verify/results.ts";
import { areaNameOf } from "../../areas/store.ts";
import { settledOf } from "../../classify/settled.ts";
import { classificationsOf, itemState, relatedOf } from "./decisions.ts";
import * as sim from "./similar.ts";
import { localEmbedder, type Embedder } from "../../embed/model.ts";
import type { Exec } from "../../fixup/git.ts";
import { batchRemovePr, batchStop, fastTrackAdd, fastTrackRefs, fastTrackRemove, heldMergeRefs, mergeHoldPr, pipelineRepoNames, queuePage } from "./queue-page.ts";
import { VectorIndex } from "../../embed/vectors.ts";
import { mainCiRepos, summarize } from "../../mainci/index.ts";

export type ApiOptions = {
  // Opinions and comments by non-operators, per login per hour.
  writesPerHour?: number;
  // Embeds search queries and items without a stored vector; default: the local model, loaded on first use.
  embedder?: Embedder;
  // Runs `gh` for the batch controls that close a PR; default: the real one. Tests fake it.
  exec?: Exec;
};

const ok = (fn: (db: DatabaseSync, req: Req) => unknown) => async (db: DatabaseSync, req: Req): Promise<Res> => {
  try {
    const v = await fn(db, req);
    return v === undefined ? { status: 204 } : { json: v };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
};

async function writeRepos(db: DatabaseSync, req: Req): Promise<string[]> {
  const repos = await visibleRepos(db, req);
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

async function me(db: DatabaseSync, req: Req): Promise<User> {
  const mw = db.prepare("SELECT value FROM settings WHERE key = 'maintainer_writes'").get() as { value: string } | undefined;
  return {
    login: req.user.login,
    role: req.user.role,
    writeRepos: await writeRepos(db, req),
    maintainerWrites: mw?.value === "1",
  };
}

// ---- items and search ------------------------------------------------------

const CI: Record<string, CiState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };

type ItemRow = {
  repo: string; number: number; kind: string; state: string; title: string | null; body: string | null; author: string | null;
  created_at: string | null; updated_at: string | null; labels: string | null; additions: number | null; deletions: number | null; changed_files: number | null;
  mergeable: string | null; ci_state: string | null; closed_at: string | null; merged_at: string | null; merged_by: string | null;
};

async function item(db: DatabaseSync, req: Req): Promise<Item> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const it = db.prepare("SELECT * FROM items WHERE repo = ? AND number = ?").get(repo, n) as ItemRow | undefined;
  if (!it) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const c = it.author ? contributors(db, { login: it.author }).find((x) => x.login === it.author) : undefined;
  let labels: string[] = [];
  try {
    const l = JSON.parse(it.labels ?? "[]") as unknown;
    if (Array.isArray(l)) labels = l.filter((x): x is string => typeof x === "string");
  } catch { /* malformed: no labels */ }
  const stages = db.prepare("SELECT stage, at, actor AS \"by\", note FROM stages WHERE repo = ? AND number = ? ORDER BY at, rowid").all(repo, n) as
    { stage: Item["stages"][number]["stage"]; at: string; by: string | null; note: string | null }[];
  const comments = db.prepare(`SELECT id, author, created_at AS at, body, kind, review_state AS reviewState FROM comments
    WHERE repo = ? AND number = ? AND NOT (kind = 'review' AND COALESCE(TRIM(body), '') = '') ORDER BY created_at, rowid`).all(repo, n) as unknown as ItemComment[];
  const decisionIds = (db.prepare(`SELECT id FROM decisions WHERE (repo = :repo AND number = :n) OR (number IS NULL AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
      WHERE json_extract(j.value, '$.repo') = :repo AND json_extract(j.value, '$.number') = :n)) ORDER BY asked_at`).all({ repo, n }) as { id: string }[]).map((r) => r.id);
  return {
    repo, number: n, kind: it.kind === "pr" ? "pr" : "issue",
    title: it.title ?? "", body: it.body ?? "", state: itemState(it.state), author: it.author ?? "",
    tier: TIER[c?.tier ?? "not"] ?? "not", authorMerged: c?.merged ?? 0, authorClosedUnmerged: c?.closed ?? 0,
    additions: it.additions ?? 0, deletions: it.deletions ?? 0,
    changedFiles: it.kind === "pr" ? it.changed_files : null,
    // The mirror stores only the rollup state and the counts, not per-file or per-check rows.
    files: [], ciChecks: [],
    ci: it.kind === "pr" ? (CI[it.ci_state ?? ""] ?? "none") : "none",
    mergeable: MERGEABLE[it.mergeable ?? ""] ?? "unknown",
    labels, createdAt: it.created_at ?? "", updatedAt: it.updated_at ?? "",
    closedAt: it.closed_at, mergedAt: it.merged_at, mergedBy: it.merged_by,
    related: relatedOf(db, repo, n), classifications: classificationsOf(db, repo, n), area: areaNameOf(db, repo, n),
    stages: stages.map((s) => ({ ...s, by: s.by ?? "" })),
    comments: comments.map((x) => ({ ...x, author: x.author ?? "", body: x.body ?? "" })),
    decisionIds, settled: settledOf(db, repo, n) as Item["settled"], priority: priorityOf(db, repo, n),
    ...(it.kind === "pr" ? prWork(db, repo, n) : { verification: null, fixups: [] }),
    patchChecks: checksOf(db, repo, n).map(({ kind, subject, patchHash, round, verdict, reasons, problems, model, createdAt }) => ({ kind, subject, patchHash, round, verdict, reasons, problems, model, createdAt })),
    reviews: it.kind === "pr" ? reviewsOf(db, repo, n) : null,
    premerge: it.kind === "pr" ? premergeOf(db, repo, n) : [],
    postmerge: it.kind === "pr" ? postmergeOf(db, repo, n, canSeeInternals(req)) : null,
    actions: actionsOf(db, repo, n), releases: releasesOf(db, repo, n),
    queue: queueSlots(db, await visibleRepos(db, req)).get(`${repo}#${n}`) ?? null,
  };
}

/** Pre-merge review rows of the PR, newest first. */
function premergeOf(db: DatabaseSync, repo: string, n: number): ItemPremerge[] {
  const rows = db.prepare("SELECT * FROM premerge_reviews WHERE repo = ? AND number = ? ORDER BY at DESC, head_oid DESC").all(repo, n) as unknown as PremergeRow[];
  return rows.map((r) => ({ head: r.head_oid, at: r.at, model: r.model, findings: findingsOf(r), searched: r.searched, error: r.error, tries: r.tries }));
}

/** The Opus review of the newest reviewed head, which is also the final verdict. */
/** The active directions the Opus or the pre-merge review at the head named, with the reviews' reasons. */
function directionsNamed(db: DatabaseSync, repo: string, n: number, head: string): ItemReviews["directions"] {
  const stored = [
    (db.prepare("SELECT directions FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, n, head) as { directions: string | null } | undefined)?.directions,
    (db.prepare("SELECT directions FROM premerge_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, n, head) as { directions: string | null } | undefined)?.directions,
  ];
  const out: ItemReviews["directions"] = [];
  for (const raw of stored) {
    let v: unknown = [];
    try { v = JSON.parse(raw ?? "[]"); } catch { /* unreadable: none */ }
    for (const h of Array.isArray(v) ? (v as { id?: unknown; reason?: unknown }[]) : []) {
      if (typeof h?.id !== "number" || out.some((d) => d.id === h.id)) continue;
      const d = db.prepare("SELECT text FROM repo_directions WHERE id = ? AND retired_at IS NULL").get(h.id) as { text: string } | undefined;
      if (d) out.push({ id: h.id, text: d.text, reason: typeof h.reason === "string" ? h.reason : "" });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

function reviewsOf(db: DatabaseSync, repo: string, n: number): ItemReviews | null {
  const o = db.prepare(`SELECT head_oid, at, mode, base_head, verdict, sure, reason, fixes, risks FROM final_reviews
    WHERE repo = ? AND number = ? ORDER BY at DESC, head_oid DESC LIMIT 1`).get(repo, n) as
    { head_oid: string; at: string; mode: "full" | "delta"; base_head: string | null; verdict: ReviewSide["verdict"]; sure: number; reason: string; fixes: string | null; risks: string | null } | undefined;
  if (!o) return null;
  const list = <T>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
  const head = (db.prepare("SELECT head_oid FROM items WHERE repo = ? AND number = ?").get(repo, n) as { head_oid: string | null } | undefined)?.head_oid ?? null;
  return {
    head: o.head_oid, current: o.head_oid === head, directions: directionsNamed(db, repo, n, o.head_oid),
    opus: { verdict: o.verdict, reason: o.reason, fixes: list(o.fixes), risks: list(o.risks), at: o.at, sure: o.sure === 1, mode: o.mode, baseHead: o.base_head },
    final: { verdict: o.verdict, reason: o.reason, decided: true },
  };
}

function prWork(db: DatabaseSync, repo: string, n: number): Pick<Item, "verification" | "fixups"> {
  const head = (db.prepare("SELECT head_oid FROM items WHERE repo = ? AND number = ?").get(repo, n) as { head_oid: string | null } | undefined)?.head_oid ?? null;
  const latest = db.prepare("SELECT head_sha FROM verifications WHERE repo = ? AND number = ? ORDER BY (head_sha = ?) DESC, created_at DESC LIMIT 1").get(repo, n, head) as { head_sha: string } | undefined;
  const v = latest ? verificationOf(db, repo, n, latest.head_sha) : null;
  const plan = (v?.plan ?? null) as Record<string, unknown> | null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const fixups = (db.prepare("SELECT from_head, to_head, state, reason, files, attempt, created_at FROM fixups WHERE repo = ? AND number = ? ORDER BY created_at, rowid").all(repo, n) as
    { from_head: string; to_head: string | null; state: string; reason: string | null; files: string | null; attempt: number; created_at: string }[])
    .map((f): ItemFixup => {
      let files: string[] = [];
      try { files = strings(JSON.parse(f.files ?? "[]")); } catch { /* malformed: none */ }
      return { fromHead: f.from_head, toHead: f.to_head, state: f.state as ItemFixup["state"], reason: f.reason, files, attempt: f.attempt, createdAt: f.created_at };
    });
  // CI fix tries are listed with the fix-ups, oldest first.
  const ciFixes = (db.prepare("SELECT head, to_head, state, reason, files, attempt, created_at FROM ci_fixes WHERE repo = ? AND number = ? ORDER BY created_at, rowid").all(repo, n) as
    { head: string; to_head: string | null; state: string; reason: string | null; files: string | null; attempt: number; created_at: string }[])
    .map((f): ItemFixup => {
      let files: string[] = [];
      try { files = strings(JSON.parse(f.files ?? "[]")); } catch { /* malformed: none */ }
      return { kind: "ci-fix", fromHead: f.head, toHead: f.to_head, state: f.state as ItemFixup["state"], reason: f.reason, files, attempt: f.attempt, createdAt: f.created_at };
    });
  fixups.push(...ciFixes);
  fixups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    fixups,
    verification: !v ? null : {
      headSha: v.headSha, baseSha: v.baseSha, current: v.headSha === head, kind: v.kind as ItemVerification["kind"], reason: v.reason,
      plan: !plan ? null : { crates: plan.crate ? [String(plan.crate)] : strings(plan.crates), tests: strings(plan.tests), testLines: typeof plan.test_lines === "number" ? plan.test_lines : null },
      state: v.state, summary: v.summary, note: v.note, createdAt: v.createdAt, finishedAt: v.finishedAt,
      tasks: v.tasks.map((t) => ({ id: t.id, role: t.role, state: t.state, results: t.results, endedAt: t.endedAt })),
    },
  };
}

function actionsOf(db: DatabaseSync, repo: string, n: number): ItemAction[] {
  return (db.prepare("SELECT decision_id, kind, state, comment_url, reason, created_at, (SELECT d.kind FROM decisions d WHERE d.id = actions.decision_id) AS decision_kind FROM actions WHERE repo = ? AND number = ? ORDER BY created_at, id").all(repo, n) as
    { decision_id: string; kind: string; state: string; comment_url: string | null; reason: string | null; created_at: string; decision_kind: string | null }[])
    .map((a): ItemAction => ({ decisionId: a.decision_id, decisionKind: a.decision_kind as DecisionKind | null, kind: a.kind, state: a.state as ItemAction["state"], commentUrl: a.comment_url, reason: a.reason, createdAt: a.created_at }));
}

// ---- progress ----------------------------------------------------------------

const toFunnel = (r: FunnelRow | undefined): Funnel => ({
  open: r?.open ?? 0, classified: r?.classified ?? 0, secondOpinion: r?.second_opinion ?? 0, disagreement: r?.disagreement ?? 0, reviewed: r?.reviewed ?? 0, take: r?.take ?? 0,
  hold: r?.hold ?? 0, close: r?.close ?? 0, waiting: r?.needs_decision ?? 0, batched: r?.batched ?? 0,
});
const toDone = (r: DoneRow | undefined): Done => ({
  mergedByPipeline: r?.merged_pipeline ?? 0, closedByPipeline: r?.closed_pipeline ?? 0, closedByOthers: r?.closed_others ?? 0,
});
const sum = <T extends object>(xs: T[], zero: T): T => {
  const out = { ...zero } as Record<string, number>;
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + (v as number);
  return out as T;
};

type Heavy = Omit<Progress, "decisionsOpen" | "decisionsAnsweredToday" | "mainCi">;
// One entry per set of hidden repos (nearly always the operator's empty set and one other).
const progressCache = new WeakMap<DatabaseSync, Map<string, { key: string; at: number; value: Heavy }>>();
const PROGRESS_MAX_AGE = 60_000;

// The item-based part of Progress: scans most of the mirror, so it is kept until
// the mirror, the stages or the tracked repos change, or for a minute at most
// (classifier verdicts and the hourly counts show within that minute).
function progressItems(db: DatabaseSync, hidden: string[]): Heavy {
  const sig = db.prepare(`SELECT (SELECT MAX(synced_at) FROM main.repos) AS synced,
      (SELECT value FROM main.settings WHERE key = 'org_high_water') AS hw,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM main.stages) AS st,
      (SELECT group_concat(name) FROM main.tracked_repos) AS tr`).get() as Record<string, string | null>;
  const key = JSON.stringify(sig);
  const cache = progressCache.get(db) ?? progressCache.set(db, new Map()).get(db)!;
  const slot = JSON.stringify(hidden);
  const hit = cache.get(slot);
  if (hit && hit.key === key && Date.now() - hit.at < PROGRESS_MAX_AGE) return hit.value;
  const hide = new Set(hidden);
  const hp: Record<string, SQLInputValue> = { since: "" };
  const hideSql = excludeHidden("i.repo", hidden, hp);

  const start = trackingStart(db);
  const now = Date.now();
  const funnels = new Map(funnelByRepo(db).filter((r) => !hide.has(r.repo)).map((r) => [r.repo, r]));
  const done = new Map(doneByRepo(db, start).filter((r) => !hide.has(r.repo)).map((r) => [r.repo, r]));
  const perHour = new Array<number>(24).fill(0);
  const perHourPipeline = new Array<number>(24).fill(0);
  const since = now - 24 * 3600_000;
  for (const r of db.prepare(`WITH ${latestCte()} SELECT i.closed_at, l.stage IN ('merged', 'closed', 'fixed-by-us') AS ours
      FROM ${CLOSED_ITEMS} LEFT JOIN latest l ON l.repo = i.repo AND l.number = i.number
      WHERE i.closed_at >= :since AND i.state <> 'OPEN' AND i.${TRACKED}${hideSql ? ` AND ${hideSql}` : ""}`).all({ ...hp, since: new Date(since).toISOString() }) as { closed_at: string; ours: number | null }[]) {
    const h = Math.floor((Date.parse(r.closed_at) - since) / 3600_000);
    if (h >= 0 && h < 24) {
      perHour[h]!++;
      if (r.ours) perHourPipeline[h]!++;
    }
  }
  const names = [...new Set([...trackedNames(db), ...funnels.keys(), ...done.keys()])].filter((n) => !hide.has(n)).sort();
  const { series } = trend(db, start, new Map(names.map((n) => [n, funnels.get(n)?.open ?? 0])));
  const repos: RepoProgress[] = names.map((repo) => ({
    repo, funnel: toFunnel(funnels.get(repo)), done: toDone(done.get(repo)),
    decisionsOpen: 0, openTrend: series.get(repo)!,
  }));
  const value: Heavy = {
    trackingSince: start, now: new Date(now).toISOString(),
    funnel: sum(repos.map((r) => r.funnel), toFunnel(undefined)),
    done: sum(repos.map((r) => r.done), toDone(undefined)),
    perHour, perHourPipeline, repos,
  };
  cache.set(slot, { key, at: now, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return value;
}

function progress(db: DatabaseSync, hidden: string[]): Progress {
  const heavy = progressItems(db, hidden);
  const dp: Record<string, string> = {};
  const hideDec = withoutHidden(hidden, dp);
  const openDec = new Map<string, number>();
  let decisionsOpen = 0;
  for (const r of db.prepare(`SELECT repo, number, items FROM decisions WHERE answer IS NULL${hideDec ? ` AND ${hideDec}` : ""}`).all(dp) as { repo: string | null; number: number | null; items: string | null }[]) {
    decisionsOpen++;
    let repos = r.number !== null && r.repo ? [r.repo] : [];
    if (r.number === null) {
      try {
        repos = [...new Set((JSON.parse(r.items ?? "[]") as { repo: string }[]).map((x) => x.repo))];
      } catch { /* malformed batch: counted for no repo */ }
    }
    for (const x of repos) openDec.set(x, (openDec.get(x) ?? 0) + 1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const answeredToday = (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE answered_at >= :t${hideDec ? ` AND ${hideDec}` : ""}`).get({ ...dp, t: `${today}T00:00:00` }) as { n: number }).n;
  return {
    ...heavy,
    repos: heavy.repos.map((r) => ({ ...r, decisionsOpen: openDec.get(r.repo) ?? 0 })),
    decisionsOpen, decisionsAnsweredToday: answeredToday,
    mainCi: summarize(mainCiRepos(db, hidden)),
  };
}

// ---- routes --------------------------------------------------------------

export function apiRoutes(opts: ApiOptions = {}): Route[] {
  const limiter = new RateLimiter(opts.writesPerHour ?? 60, 3600_000);
  const vectors = new VectorIndex(opts.embedder ?? localEmbedder({ threads: 2 }));
  const get = (pattern: string, fn: (db: DatabaseSync, req: Req) => unknown): Route => ({ method: "GET", pattern, handler: ok(fn) });
  const post = (pattern: string, fn: (db: DatabaseSync, req: Req) => unknown): Route => ({ method: "POST", pattern, handler: ok(fn) });
  return [
    get("/api/me", me),
    get("/api/repos", visibleRepos),
    get("/api/decisions", (db, req) => dec.listDecisions(db, req, () => writeRepos(db, req))),
    get("/api/decisions/:id", dec.getOne),
    get("/api/decisions/:id/thread", dec.thread),
    post("/api/decisions/:id/answer", dec.answer),
    post("/api/decisions/:id/undo", dec.undo),
    post("/api/decisions/:id/reopen", dec.reopen),
    { method: "POST", pattern: "/api/decisions/backlog", operator: true, handler: ok(dec.backlogBulk) },
    post("/api/decisions/:id/adopt", dec.adopt),
    post("/api/decisions/:id/feedback", (db, req) => dec.feedback(db, req, limiter)),
    post("/api/decisions/:id/retract", (db, req) => dec.retract(db, req, limiter)),
    post("/api/decisions/:id/claim", dec.claim),
    get("/api/items/:repo/:n", item),
    get("/api/items/:repo/:n/decision", dec.forItem),
    get("/api/conversations/:repo/:n", conv.getConversation),
    { method: "POST", pattern: "/api/conversations/:repo/:n/messages", operator: true, handler: ok((db, req) => conv.postMessage(db, req)) },
    { method: "POST", pattern: "/api/conversation-cards/:id/edit", operator: true, handler: ok(conv.editCardText) },
    { method: "POST", pattern: "/api/conversation-cards/:id/do", operator: true, handler: ok((db, req) => conv.doIt(db, req)) },
    { method: "POST", pattern: "/api/conversation-cards/:id/dismiss", operator: true, handler: ok(conv.dismiss) },
    { method: "POST", pattern: "/api/items/:repo/:n/review-again", operator: true, handler: ok(operator.reviewItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/verify-again", operator: true, handler: ok(operator.verifyItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/fix-again", operator: true, handler: ok(operator.fixItemAgain) },
    get("/api/areas/:repo", areas.repoAreas),
    { method: "POST", pattern: "/api/areas/:repo/edit", operator: true, handler: ok(areas.edit) },
    { method: "POST", pattern: "/api/areas/:repo/run", operator: true, handler: ok(areas.run) },
    { method: "POST", pattern: "/api/area-proposals/:id/accept", operator: true, handler: ok(areas.acceptProposalApi) },
    { method: "POST", pattern: "/api/area-proposals/:id/dismiss", operator: true, handler: ok(areas.dismiss) },
    get("/api/directions/:repo", directions.get),
    { method: "POST", pattern: "/api/directions/:repo", operator: true, handler: ok(directions.add) },
    { method: "POST", pattern: "/api/direction/:id/edit", operator: true, handler: ok(directions.edit) },
    { method: "POST", pattern: "/api/direction/:id/retire", operator: true, handler: ok(directions.retire) },
    { method: "POST", pattern: "/api/direction-proposals/:id/accept", operator: true, handler: ok(directions.acceptProposalApi) },
    { method: "POST", pattern: "/api/direction-proposals/:id/dismiss", operator: true, handler: ok(directions.dismissProposalApi) },
    get("/api/decisions/:id/direction-proposals", directions.forDecision),
    { method: "POST", pattern: "/api/items/:repo/:n/batch-again", operator: true, handler: ok(operator.batchItemAgain) },
    get("/api/items", items.listItems),
    get("/api/search", (db, req) => req.query.get("mode") === "semantic" ? sim.semanticSearch(db, req, vectors) : items.quickSearch(db, req)),
    get("/api/progress", async (db, req) => progress(db, await hiddenRepos(db, req))),
    get("/api/main-ci", async (db, req) => {
      const repos = mainCiRepos(db, await hiddenRepos(db, req));
      return { summary: summarize(repos), repos };
    }),
    get("/api/main-ci/summary", async (db, req) => summarize(mainCiRepos(db, await hiddenRepos(db, req)))),
    get("/api/contributors", adm.listContributors),
    get("/api/contributors/rule-preview", adm.previewRule),
    post("/api/contributors/rule", adm.saveRule),
    post("/api/contributors/:login/override", adm.override),
    get("/api/repos/all", adm.allRepos),
    post("/api/repos/track", (db, req) => adm.track(db, req, true)),
    post("/api/repos/untrack", (db, req) => adm.track(db, req, false)),
    post("/api/repos/labels-approve", (db, req) => adm.labelsApproval(db, req, true)),
    post("/api/repos/labels-revoke", (db, req) => adm.labelsApproval(db, req, false)),
    post("/api/repos/merge-approve", (db, req) => adm.mergeApproval(db, req, true)),
    post("/api/repos/merge-revoke", (db, req) => adm.mergeApproval(db, req, false)),
    post("/api/repos/ci-approve", (db, req) => adm.ciApproval(db, req, true)),
    post("/api/repos/ci-revoke", (db, req) => adm.ciApproval(db, req, false)),
    get("/api/sandbox/workspace", adm.workspaceInfo),
    { method: "PUT", pattern: "/api/sandbox/workspace", operator: true, handler: ok(adm.setWorkspaceInfo) },
    get("/api/merge/single", adm.singleMerge),
    { method: "PUT", pattern: "/api/merge/single", operator: true, handler: ok(adm.setSingleMerge) },
    post("/api/repos/comment-approve", (db, req) => adm.commentApproval(db, req, true)),
    post("/api/repos/comment-revoke", (db, req) => adm.commentApproval(db, req, false)),
    post("/api/repos/push-approve", (db, req) => adm.pushApproval(db, req, true)),
    post("/api/repos/push-revoke", (db, req) => adm.pushApproval(db, req, false)),
    post("/api/repos/fixissue-approve", (db, req) => adm.fixIssueApproval(db, req, true)),
    post("/api/repos/fixissue-revoke", (db, req) => adm.fixIssueApproval(db, req, false)),
    post("/api/repos/mainfix-approve", (db, req) => adm.mainFixApproval(db, req, true)),
    post("/api/repos/mainfix-revoke", (db, req) => adm.mainFixApproval(db, req, false)),
    post("/api/repos/optional-check-add", (db, req) => adm.optionalCheck(db, req, true)),
    post("/api/repos/optional-check-remove", (db, req) => adm.optionalCheck(db, req, false)),
    post("/api/repos/pipeline-on", (db, req) => adm.pipelineSwitch(db, req, true)),
    post("/api/repos/pipeline-off", (db, req) => adm.pipelineSwitch(db, req, false)),
    get("/api/access", adm.accessOverview),
    post("/api/access/add", adm.accessAdd),
    post("/api/access/remove", adm.accessRemove),
    post("/api/access/role", adm.accessRole),
    post("/api/access/sessions/revoke", adm.revokeSession),
    get("/api/audit", adm.auditLog),
    get("/api/classifiers", insight.classifiersReport),
    get("/api/classifiers/disagreements", insight.disagreements),
    get("/api/cost", insight.cost),
    get("/api/pipeline", pipeline.overview),
    get("/api/pipeline/jobs", pipeline.jobs),
    get("/api/pipeline/jobs/:id", pipeline.job),
    { method: "POST", pattern: "/api/pipeline/jobs", operator: true, handler: ok(pipeline.request) },
    { method: "POST", pattern: "/api/pipeline/jobs/:id/cancel", operator: true, handler: ok(pipeline.cancel) },
    get("/api/pipeline/state", (db) => pipeline.state(db)),
    { method: "PUT", pattern: "/api/pipeline/state", operator: true, handler: ok(pipeline.putState) },
    { method: "PUT", pattern: "/api/pipeline/limits/:step", operator: true, handler: ok(pipeline.putLimit) },
    { method: "POST", pattern: "/api/pipeline/limits/:step/reset", operator: true, handler: ok(pipeline.resetLimit) },
    { method: "POST", pattern: "/api/pipeline/trips/:stage/resume", operator: true, handler: ok(pipeline.resumeTrip) },
    { method: "PUT", pattern: "/api/pipeline/pilot", operator: true, handler: ok(adm.putPilot) },
    get("/api/prompts", prompts),
    get("/api/accounts", agents.accounts),
    get("/api/accounts/pause", agents.getPause),
    { method: "PUT", pattern: "/api/accounts/pause", operator: true, handler: ok(agents.putPause) },
    get("/api/accounts/jev", agents.getJev),
    { method: "PUT", pattern: "/api/accounts/jev", operator: true, handler: ok(agents.putJev) },
    { method: "PUT", pattern: "/api/accounts/:id", operator: true, handler: ok(agents.putAccount) },
    { method: "POST", pattern: "/api/accounts", operator: true, handler: ok(agents.postAccount) },
    { method: "POST", pattern: "/api/accounts/:id/login", operator: true, handler: ok(agents.loginStart) },
    { method: "POST", pattern: "/api/accounts/:id/login/code", operator: true, handler: ok(agents.loginCode) },
    { method: "POST", pattern: "/api/accounts/:id/login/cancel", operator: true, handler: ok(agents.loginCancel) },
    { method: "POST", pattern: "/api/accounts/:id/sign-out", operator: true, handler: ok(agents.accountSignOut) },
    { method: "POST", pattern: "/api/accounts/:id/refresh", operator: true, handler: ok(agents.accountRefresh) },
    get("/api/agents", agents.list),
    get("/api/agents/:id", agents.detail),
    get("/api/rates", agents.rates),
    get("/api/envs", build.envs),
    { method: "POST", pattern: "/api/envs", operator: true, handler: ok(build.postEnv) },
    { method: "PUT", pattern: "/api/envs/:id", operator: true, handler: ok(build.putEnv) },
    { method: "POST", pattern: "/api/envs/:id/rotate-key", operator: true, handler: ok(build.postRotate) },
    get("/api/tasks", build.tasks),
    get("/api/tasks/:id", build.task),
    { method: "POST", pattern: "/api/tasks/:id/cancel", operator: true, handler: ok(build.cancel) },
    { method: "GET", pattern: "/api/tasks/:id/artifacts/:name", handler: build.artifact },
    get("/api/build/summary", build.buildSummary),
    get("/api/queue", queue),
    get("/api/queue/batches", queueBatches),
    get("/api/github-activity", githubActivity),
    get("/api/work", work),
    get("/api/queue/page", queuePage),
    get("/api/repos/pipeline", pipelineRepoNames),
    get("/api/fast-track", fastTrackRefs),
    get("/api/merge/held", heldMergeRefs),
    { method: "POST", pattern: "/api/fast-track", operator: true, handler: ok(fastTrackAdd) },
    { method: "POST", pattern: "/api/fast-track/remove", operator: true, handler: ok(fastTrackRemove) },
    { method: "POST", pattern: "/api/merge/hold", operator: true, handler: ok((db, req) => mergeHoldPr(db, req, true)) },
    { method: "POST", pattern: "/api/merge/release", operator: true, handler: ok((db, req) => mergeHoldPr(db, req, false)) },
    { method: "POST", pattern: "/api/merge/batch-remove", operator: true, handler: ok((db, req) => batchRemovePr(db, req, opts.exec)) },
    { method: "POST", pattern: "/api/queue/batches/:id/stop", operator: true, handler: ok((db, req) => batchStop(db, req, opts.exec)) },
    get("/api/flow", flow),
    get("/api/similar/:repo/:n", (db, req) => sim.similar(db, req, vectors)),
  ];
}
