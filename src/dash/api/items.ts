// The Items browser (`GET /api/items`) and the top-bar search (`GET /api/search`),
// both over the full-text tables items_fts and comments_fts (src/schema.sql).
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ItemList, ItemListRow, ItemSort, SearchHit, SettledStatus, Snippet, Stage,
} from "../../../web/src/api/types.ts";
import { fromRow, latestRun, settledTable, type SettledRow } from "../../classify/settled.ts";
import { LABELS } from "../../classify/rules.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./decisions.ts";
import { latestCte } from "./stats.ts";

const HAS_WORD = /[\p{L}\p{N}]/u;
const quote = (s: string) => `"${s.replace(/"/g, "")}"`;

/**
 * Turns what a person types into an FTS5 query, or null when nothing is left
 * to search for. Words must all match; "quoted text" is a phrase; a trailing *
 * matches a prefix; -word excludes; OR between terms means either. Every term
 * is quoted, so FTS5 syntax characters in the input are never operators.
 * `prefixLast` makes the last word a prefix (for search-as-you-type).
 */
export function ftsQuery(input: string, prefixLast = false): string | null {
  const pos: string[] = [];
  const neg: string[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  const raw = input.slice(0, 300);
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (m[2] !== undefined) {
      if (HAS_WORD.test(m[2])) (m[1] ? neg : pos).push(quote(m[2]));
      continue;
    }
    let w = m[3]!;
    if (w === "OR") {
      if (pos.length && pos[pos.length - 1] !== "OR") pos.push("OR");
      continue;
    }
    const isNeg = w.startsWith("-") && w.length > 1;
    if (isNeg) w = w.slice(1);
    const atEnd = m.index + m[0].length === raw.length && !/\s$/.test(raw);
    // a prefix of one or two letters would expand to most of the index
    const prefix = w.endsWith("*") || (prefixLast && atEnd && !isNeg && w.length >= 3);
    w = w.replace(/\*+$/, "");
    if (!HAS_WORD.test(w)) continue;
    (isNeg ? neg : pos).push(quote(w) + (prefix ? "*" : ""));
    if (pos.length + neg.length >= 16) break;
  }
  while (pos[pos.length - 1] === "OR") pos.pop();
  if (!pos.length) return null;
  return [`(${pos.join(" ")})`, ...neg.map((n) => `NOT ${n}`)].join(" ");
}

// Items matching the query bound as :q in their title, body or any comment.
const HIT_IDS = `hits AS (
  SELECT rowid AS rid FROM items_fts WHERE items_fts MATCH :q
  UNION
  SELECT it.rowid FROM comments_fts
    JOIN main.comments c ON c.rowid = comments_fts.rowid
    JOIN main.items it ON it.repo = c.repo AND it.number = c.number
  WHERE comments_fts MATCH :q)`;

// The same with the best bm25 score (lower is better): a title match weighs most,
// a comment match half as much as one in the body.
const HITS_SCORED = `hits AS (
  SELECT rid, MIN(score) AS score FROM (
    SELECT rowid AS rid, bm25(items_fts, 10.0, 1.0) AS score FROM items_fts WHERE items_fts MATCH :q
    UNION ALL
    SELECT it.rowid, bm25(comments_fts) * 0.5 FROM comments_fts
      JOIN main.comments c ON c.rowid = comments_fts.rowid
      JOIN main.items it ON it.repo = c.repo AND it.number = c.number
    WHERE comments_fts MATCH :q)
  GROUP BY rid)`;

const STATUSES: SettledStatus[] = ["settled", "waiting", "disagree", "unclassified"];
const STATES: Record<string, string> = { open: "OPEN", closed: "CLOSED", merged: "MERGED" };
const SORTS: ItemSort[] = ["relevance", "updated", "created", "number"];
const FLAGS = ["security", "needs decision"];

const list = (req: Req, key: string): string[] =>
  req.query.getAll(key).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

type Built = { where: string[]; statusWhere: string | null; statuses: SettledStatus[]; params: Record<string, SQLInputValue>; text: boolean };

function build(db: DatabaseSync, req: Req): Built & { sort: ItemSort; desc: boolean; run: string | null } {
  const q = req.query;
  const mode = q.get("mode") ?? "text";
  if (mode !== "text") throw new HttpError(400, "mode must be text");
  const run = q.get("run") || latestRun(db);
  settledTable(db, run);
  const params: Record<string, SQLInputValue> = {};
  const where: string[] = [];
  const fts = ftsQuery(q.get("q") ?? "");
  if (fts) params.q = fts;
  const repos = list(req, "repo");
  if (repos.length) {
    where.push(`i.repo IN (${repos.map((_, k) => `:repo${k}`).join(",")})`);
    repos.forEach((r, k) => (params[`repo${k}`] = r));
  }
  const kind = q.get("kind");
  if (kind) {
    if (kind !== "pr" && kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
    where.push("i.kind = :kind");
    params.kind = kind;
  }
  const state = q.get("state") ?? "open";
  if (state !== "all") {
    if (!STATES[state]) throw new HttpError(400, "state must be open, closed, merged or all");
    where.push("i.state = :state");
    params.state = STATES[state]!;
  }
  const label = q.get("label");
  if (label) {
    if (!(LABELS as readonly string[]).includes(label)) throw new HttpError(400, "unknown label");
    where.push("s.label = :label");
    params.label = label;
  }
  list(req, "flag").forEach((f) => {
    if (!FLAGS.includes(f)) throw new HttpError(400, "flag must be security or needs decision");
    where.push(f === "security" ? "s.security = 1" : "s.needs_decision = 1");
  });
  const author = q.get("author")?.trim();
  if (author) {
    where.push("i.author = :author COLLATE NOCASE");  // index items_author_nocase
    params.author = author;
  }
  const since = q.get("since");
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, "since must be YYYY-MM-DD");
    where.push("i.updated_at >= :since");
    params.since = since;
  }
  let statusWhere: string | null = null;
  const st = new Set(list(req, "status").flatMap((s) => (s === "unsettled" ? ["waiting", "disagree"] : [s])));
  if (st.size) {
    for (const s of st) if (!STATUSES.includes(s as SettledStatus)) throw new HttpError(400, "status must be settled, waiting, disagree, unsettled or unclassified");
    const named = [...st].filter((s) => s !== "unclassified").map((s) => `'${s}'`);
    const parts = [...(named.length ? [`s.status IN (${named.join(",")})`] : []), ...(st.has("unclassified") ? ["s.status IS NULL"] : [])];
    statusWhere = `(${parts.join(" OR ")})`;
  }
  const sortQ = q.get("sort") as ItemSort | null;
  if (sortQ && !SORTS.includes(sortQ)) throw new HttpError(400, "sort must be relevance, updated, created or number");
  let sort: ItemSort = sortQ ?? (fts ? "relevance" : "updated");
  if (sort === "relevance" && !fts) sort = "updated";
  const desc = q.get("desc") !== "0";
  return { where, statusWhere, statuses: [...st] as SettledStatus[], params, text: !!fts, sort, desc, run };
}

const ORDER: Record<ItemSort, string> = {
  relevance: "h.score", updated: "i.updated_at", created: "i.created_at", number: "i.number",
};

type Row = SettledRow & {
  rid: number; repo: string; number: number; kind: string; state: string; title: string | null; author: string | null;
  created_at: string | null; updated_at: string | null; comments_count: number | null;
};

const OPEN = "\u0002", CLOSE = "\u0003";

function snippets(db: DatabaseSync, fts: string, rows: Row[]): Map<number, Snippet> {
  const out = new Map<number, Snippet>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.rid);
  const inList = ids.map(() => "?").join(",");
  const sn = (t: string, col: number) => `snippet(${t}, ${col}, '${OPEN}', '${CLOSE}', '…', 24)`;
  const own = db.prepare(`SELECT rowid AS rid, ${sn("items_fts", 0)} AS t, ${sn("items_fts", 1)} AS b
    FROM items_fts WHERE items_fts MATCH ? AND rowid IN (${inList})`).all(fts, ...ids) as { rid: number; t: string | null; b: string | null }[];
  for (const r of own) {
    if (r.b?.includes(OPEN)) out.set(r.rid, { field: "body", author: null, text: r.b });
    else if (r.t?.includes(OPEN)) out.set(r.rid, { field: "title", author: null, text: r.t });
  }
  const rest = rows.filter((r) => !out.has(r.rid));
  if (!rest.length) return out;
  const pairs = rest.map(() => "(?, ?)").join(",");
  const cm = db.prepare(`SELECT c.repo, c.number, c.author, ${sn("comments_fts", 0)} AS t FROM comments_fts
    JOIN main.comments c ON c.rowid = comments_fts.rowid
    WHERE comments_fts MATCH ? AND (c.repo, c.number) IN (VALUES ${pairs}) ORDER BY rank`)
    .all(fts, ...rest.flatMap((r) => [r.repo, r.number])) as { repo: string; number: number; author: string | null; t: string }[];
  const byRef = new Map(rest.map((r) => [`${r.repo}#${r.number}`, r.rid]));
  for (const c of cm) {
    const rid = byRef.get(`${c.repo}#${c.number}`);
    if (rid !== undefined && !out.has(rid)) out.set(rid, { field: "comment", author: c.author, text: c.t });
  }
  return out;
}

export function listItems(db: DatabaseSync, req: Req): ItemList {
  const b = build(db, req);
  const limit = Math.min(100, Math.max(1, Number(req.query.get("limit")) || 50));
  const offset = Math.max(0, Number(req.query.get("offset")) || 0);
  const from = (scored: boolean) => (b.text
    ? `WITH ${scored ? HITS_SCORED : HIT_IDS} SELECT %COLS FROM hits h JOIN items i ON i.rowid = h.rid`
    : "SELECT %COLS FROM items i") + " LEFT JOIN temp.item_settled s ON s.repo = i.repo AND s.number = i.number";
  const whereSql = (w: string[]) => (w.length ? ` WHERE ${w.join(" AND ")}` : "");

  // Counts per status under every filter but the status one; the total follows from them.
  const counts = db.prepare(from(false).replace("%COLS", "s.status, COUNT(*) AS n") + whereSql(b.where) + " GROUP BY 1")
    .all(b.params) as { status: string | null; n: number }[];
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<SettledStatus, number>;
  for (const c of counts) byStatus[(c.status ?? "unclassified") as SettledStatus] += c.n;
  const total = (b.statuses.length ? b.statuses : STATUSES).reduce((a, s) => a + byStatus[s], 0);

  // The page as rowids first, so only its rows are read in full.
  const where = [...b.where, ...(b.statusWhere ? [b.statusWhere] : [])];
  // bm25 is lower for better matches, so "most relevant first" sorts it ascending.
  const order = b.sort === "relevance" ? `h.score ${b.desc ? "ASC" : "DESC"}` : `${ORDER[b.sort]} ${b.desc ? "DESC" : "ASC"}`;
  const ids = (db.prepare(from(b.sort === "relevance").replace("%COLS", "i.rowid AS rid") + whereSql(where) +
    ` ORDER BY ${order}, i.repo, i.number DESC LIMIT :limit OFFSET :offset`).all({ ...b.params, limit, offset }) as { rid: number }[]).map((r) => r.rid);
  const byId = new Map((ids.length ? db.prepare(`SELECT i.rowid AS rid, i.repo, i.number, i.kind, i.state, i.title, i.author,
      i.created_at, i.updated_at, i.comments_count, s.status, s.label, s.source, s.top, s.jev_label, s.haiku_label, s.flags
    FROM items i LEFT JOIN temp.item_settled s ON s.repo = i.repo AND s.number = i.number WHERE i.rowid IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[] : [])
    .map((r) => [r.rid, r]));
  const rows = ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);

  const stages = stagesOf(db, rows);
  const snips = b.text ? snippets(db, b.params.q as string, rows) : new Map<number, Snippet>();
  return {
    total, byStatus, run: b.run,
    rows: rows.map((r): ItemListRow => ({
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state),
      title: r.title ?? "", author: r.author ?? "", createdAt: r.created_at ?? "", updatedAt: r.updated_at ?? "",
      comments: r.comments_count ?? 0, settled: fromRow(r) as ItemListRow["settled"],
      stage: (stages.get(`${r.repo}#${r.number}`) ?? null) as Stage | null, snippet: snips.get(r.rid) ?? null,
    })),
  };
}

// Latest stage of each listed item.
function stagesOf(db: DatabaseSync, rows: { repo: string; number: number }[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const pairs = rows.map(() => "(?, ?)").join(",");
  const got = db.prepare(`WITH ${latestCte()} SELECT repo, number, stage FROM latest WHERE (repo, number) IN (VALUES ${pairs})`)
    .all(...rows.flatMap((r) => [r.repo, r.number])) as { repo: string; number: number; stage: string }[];
  for (const g of got) out.set(`${g.repo}#${g.number}`, g.stage);
  return out;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Top-bar search: `repo#n`, `#n` and bare numbers jump by number; a word may be an author's login; text goes through the full-text index. */
type Hit = { repo: string; number: number; kind: string; title: string | null; author: string | null; state: string };
const hitOf = (r: Hit): SearchHit => ({ repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author ?? "", state: itemState(r.state) });

export function quickSearch(db: DatabaseSync, req: Req): SearchHit[] {
  const q = (req.query.get("q") ?? "").trim().slice(0, 200);
  if (!q) return [];
  const ref = /^([A-Za-z0-9._-]+)?#(\d{1,9})$/.exec(q) ?? /^()(\d{1,9})$/.exec(q);
  let rows: Hit[];
  if (ref) {
    const where = ["CAST(number AS TEXT) LIKE :num"];
    const params: Record<string, string> = { num: `${ref[2]}%` };
    if (ref[1]) {
      where.push("repo LIKE :repo ESCAPE '\\'");
      params.repo = `${likeEscape(ref[1])}%`;
    }
    rows = db.prepare(`SELECT repo, number, kind, title, author, state FROM items WHERE ${where.join(" AND ")}
      ORDER BY length(CAST(number AS TEXT)), repo, number LIMIT 20`).all(params) as Hit[];
  } else {
    rows = [];
    // A single word may be a login: that author's latest items first.
    if (/^[A-Za-z0-9-]{2,39}$/.test(q)) {
      // main.items with the index named: through the scoping view the planner picks the repo index.
      rows = db.prepare(`SELECT repo, number, kind, title, author, state FROM main.items INDEXED BY items_author_nocase
        WHERE author LIKE :p AND repo IN (SELECT name FROM main.tracked_repos) ORDER BY state <> 'OPEN', updated_at DESC LIMIT 5`).all({ p: `${q}%` }) as Hit[];
    }
    const fts = ftsQuery(q, true);
    if (!fts) return rows.map(hitOf);
    const have = new Set(rows.map((r) => `${r.repo}#${r.number}`));
    // The newest 100 matches by title, then by body when titles give too few, open ones first.
    // Ordered by rowid, which FTS5 stops early on; ranking every match is too slow for common words.
    const look = db.prepare(`WITH hits AS (SELECT rowid AS rid FROM items_fts WHERE items_fts MATCH :q ORDER BY rowid DESC LIMIT 100)
      SELECT i.repo, i.number, i.kind, i.title, i.author, i.state
      FROM hits h JOIN items i ON i.rowid = h.rid ORDER BY i.state <> 'OPEN', i.updated_at DESC LIMIT 20`);
    let text = look.all({ q: `title : ${fts}` }) as Hit[];
    if (text.length < 20) {
      const seenT = new Set(text.map((r) => `${r.repo}#${r.number}`));
      text = [...text, ...(look.all({ q: fts }) as Hit[]).filter((r) => !seenT.has(`${r.repo}#${r.number}`))];
    }
    rows = [...rows, ...text.filter((r) => !have.has(`${r.repo}#${r.number}`))].slice(0, 20);
  }
  return rows.map(hitOf);
}
