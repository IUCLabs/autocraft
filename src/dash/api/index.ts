// JSON API for the dashboard frontend (web/src/api/client.ts `Api`). The
// server has already checked the session, and on POSTs the Origin, the CSRF
// header and the per-session limits; these handlers check roles and GitHub
// permissions themselves. Item and comment text is returned as data only.
import type { DatabaseSync } from "node:sqlite";
import type {
  CiState, Done, Funnel, Item, ItemComment, Mergeable, Progress, RepoProgress, SearchHit, Tier, User,
} from "../../../web/src/api/types.ts";
import { trackedNames } from "../../repos.ts";
import { contributors } from "../../whitelist.ts";
import { doneByRepo, funnelByRepo, runStart, trend, type DoneRow, type FunnelRow } from "./stats.ts";
import { HttpError, RateLimiter } from "../server/util.ts";
import type { Req, Res, Route } from "../types.ts";
import * as adm from "./admin.ts";
import * as dec from "./decisions.ts";
import * as insight from "./insight.ts";
import { classificationsOf, itemState, relatedOf } from "./decisions.ts";

export type ApiOptions = {
  // Opinions and comments by non-operators, per login per hour.
  writesPerHour?: number;
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
  const repos = trackedNames(db);
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

function trackedOnly(db: DatabaseSync, repo: string): void {
  if (!trackedNames(db).includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
}

type ItemRow = {
  repo: string; number: number; kind: string; state: string; title: string | null; body: string | null; author: string | null;
  created_at: string | null; updated_at: string | null; labels: string | null; additions: number | null; deletions: number | null;
  mergeable: string | null; ci_state: string | null;
};

function item(db: DatabaseSync, req: Req): Item {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  trackedOnly(db, repo);
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
    WHERE repo = ? AND number = ? ORDER BY created_at, rowid`).all(repo, n) as unknown as ItemComment[];
  const decisionIds = (db.prepare(`SELECT id FROM decisions WHERE (repo = :repo AND number = :n) OR (number IS NULL AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
      WHERE json_extract(j.value, '$.repo') = :repo AND json_extract(j.value, '$.number') = :n)) ORDER BY asked_at`).all({ repo, n }) as { id: string }[]).map((r) => r.id);
  return {
    repo, number: n, kind: it.kind === "pr" ? "pr" : "issue",
    title: it.title ?? "", body: it.body ?? "", state: itemState(it.state), author: it.author ?? "",
    tier: TIER[c?.tier ?? "not"] ?? "not", authorMerged: c?.merged ?? 0, authorClosedUnmerged: c?.closed ?? 0,
    additions: it.additions ?? 0, deletions: it.deletions ?? 0,
    files: [], ciChecks: [],
    ci: it.kind === "pr" ? (CI[it.ci_state ?? ""] ?? "none") : "none",
    mergeable: MERGEABLE[it.mergeable ?? ""] ?? "unknown",
    labels, createdAt: it.created_at ?? "", updatedAt: it.updated_at ?? "",
    related: relatedOf(db, repo, n), classifications: classificationsOf(db, repo, n),
    stages: stages.map((s) => ({ ...s, by: s.by ?? "" })),
    comments: comments.map((x) => ({ ...x, author: x.author ?? "", body: x.body ?? "" })),
    decisionIds,
  };
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function search(db: DatabaseSync, req: Req): SearchHit[] {
  const q = (req.query.get("q") ?? "").trim().slice(0, 200);
  if (!q) return [];
  const where: string[] = ["repo IN (SELECT name FROM main.tracked_repos)"];
  const params: Record<string, string | number> = {};
  const ref = /^([A-Za-z0-9._-]+)?#(\d{1,9})$/.exec(q) ?? /^()(\d{1,9})$/.exec(q);
  if (ref) {
    if (ref[1]) {
      where.push("repo LIKE :repo ESCAPE '\\'");
      params.repo = `${likeEscape(ref[1])}%`;
    }
    where.push("CAST(number AS TEXT) LIKE :num");
    params.num = `${ref[2]}%`;
  } else {
    q.split(/\s+/).slice(0, 8).forEach((w, i) => {
      where.push(`title LIKE :w${i} ESCAPE '\\'`);
      params[`w${i}`] = `%${likeEscape(w)}%`;
    });
  }
  const order = ref ? "length(CAST(number AS TEXT)), repo, number" : "state <> 'OPEN', updated_at DESC";
  const rows = db.prepare(`SELECT repo, number, kind, title, author, state FROM items WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 20`).all(params) as
    { repo: string; number: number; kind: string; title: string | null; author: string | null; state: string }[];
  return rows.map((r) => ({ repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author ?? "", state: itemState(r.state) }));
}

// ---- progress ----------------------------------------------------------------

const toFunnel = (r: FunnelRow | undefined): Funnel => ({
  open: r?.open ?? 0, classified: r?.classified ?? 0, reviewed: r?.reviewed ?? 0, take: r?.take ?? 0,
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

function progress(db: DatabaseSync): Progress {
  const start = runStart(db);
  const now = Date.now();
  const funnels = new Map(funnelByRepo(db).map((r) => [r.repo, r]));
  const done = new Map(doneByRepo(db, start).map((r) => [r.repo, r]));
  const openDec = new Map<string, number>();
  let decisionsOpen = 0;
  for (const r of db.prepare("SELECT repo, number, items FROM decisions WHERE answer IS NULL").all() as { repo: string | null; number: number | null; items: string | null }[]) {
    decisionsOpen++;
    let repos = r.number !== null && r.repo ? [r.repo] : [];
    if (r.number === null) {
      try {
        repos = [...new Set((JSON.parse(r.items ?? "[]") as { repo: string }[]).map((x) => x.repo))];
      } catch { /* malformed batch: counted for no repo */ }
    }
    for (const x of repos) openDec.set(x, (openDec.get(x) ?? 0) + 1);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const answeredToday = (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE answered_at >= ?").get(`${today}T00:00:00`) as { n: number }).n;
  const perHour = new Array<number>(24).fill(0);
  const since = now - 24 * 3600_000;
  for (const r of db.prepare("SELECT closed_at FROM items WHERE closed_at >= ? AND state <> 'OPEN'").all(new Date(since).toISOString()) as { closed_at: string }[]) {
    const h = Math.floor((Date.parse(r.closed_at) - since) / 3600_000);
    if (h >= 0 && h < 24) perHour[h]!++;
  }
  const { series } = trend(db, start, new Map([...funnels].map(([k, v]) => [k, v.open])));
  const names = [...new Set([...trackedNames(db), ...funnels.keys(), ...done.keys()])].sort();
  const repos: RepoProgress[] = names.map((repo) => ({
    repo, funnel: toFunnel(funnels.get(repo)), done: toDone(done.get(repo)),
    decisionsOpen: openDec.get(repo) ?? 0, openTrend: series.get(repo) ?? [],
  }));
  return {
    runStartedAt: start, now: new Date(now).toISOString(),
    funnel: sum(repos.map((r) => r.funnel), toFunnel(undefined)),
    done: sum(repos.map((r) => r.done), toDone(undefined)),
    perHour, decisionsOpen, decisionsAnsweredToday: answeredToday, repos,
  };
}

// ---- routes --------------------------------------------------------------

export function apiRoutes(opts: ApiOptions = {}): Route[] {
  const limiter = new RateLimiter(opts.writesPerHour ?? 60, 3600_000);
  const get = (pattern: string, fn: (db: DatabaseSync, req: Req) => unknown): Route => ({ method: "GET", pattern, handler: ok(fn) });
  const post = (pattern: string, fn: (db: DatabaseSync, req: Req) => unknown): Route => ({ method: "POST", pattern, handler: ok(fn) });
  return [
    get("/api/me", me),
    get("/api/repos", (db) => trackedNames(db)),
    get("/api/decisions", (db, req) => dec.listDecisions(db, req, () => writeRepos(db, req))),
    get("/api/decisions/:id", dec.getOne),
    get("/api/decisions/:id/thread", dec.thread),
    post("/api/decisions/:id/answer", dec.answer),
    post("/api/decisions/:id/undo", dec.undo),
    post("/api/decisions/:id/adopt", dec.adopt),
    post("/api/decisions/:id/opinion", (db, req) => dec.opine(db, req, limiter)),
    post("/api/decisions/:id/retract", (db, req) => dec.retract(db, req, limiter)),
    post("/api/decisions/:id/comments", (db, req) => dec.comment(db, req, limiter)),
    post("/api/decisions/:id/claim", dec.claim),
    get("/api/items/:repo/:n", item),
    get("/api/search", search),
    get("/api/progress", progress),
    get("/api/contributors", adm.listContributors),
    get("/api/contributors/rule-preview", adm.previewRule),
    post("/api/contributors/rule", adm.saveRule),
    post("/api/contributors/:login/override", adm.override),
    get("/api/repos/all", adm.allRepos),
    post("/api/repos/track", (db, req) => adm.track(db, req, true)),
    post("/api/repos/untrack", (db, req) => adm.track(db, req, false)),
    get("/api/access", adm.accessOverview),
    post("/api/access/add", adm.accessAdd),
    post("/api/access/remove", adm.accessRemove),
    post("/api/access/role", adm.accessRole),
    post("/api/access/sessions/revoke", adm.revokeSession),
    get("/api/audit", adm.auditLog),
    get("/api/classifiers", insight.classifiersReport),
    get("/api/classifiers/disagreements", insight.disagreements),
    get("/api/cost", insight.cost),
  ];
}
