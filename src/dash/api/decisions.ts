// Decisions over JSON: the queue, answers (operator only), feedback, claims
// and the thread. Feedback (picks and comments) is display-only: nothing the pipeline
// reads (src/decisions.ts `actionable`) touches their tables.
import { priorityOf } from "../../priority/read.ts";
import type { DatabaseSync } from "node:sqlite";
import type {
  Claim, Classification, Decision, DecisionComment, DecisionKind, DecisionList, ItemState, Opinion, QueueSlot, RelatedItem, Relation,
} from "../../../web/src/api/types.ts";
import { resetGroupAnswer } from "../../dupes/decide.ts";
import { BACKLOG, backlogOpen, exceptionsOf, factsOf, getDecision, isBatch, itemsOf, KINDS, optionsOf, reposOf, type DecisionRow, type Exception } from "../../decisions.ts";
import { commentPreview, writeEffect } from "../../act/index.ts";
import { optionTextsOf, textsFor, textsHash } from "../../dupes/texts.ts";
import { audit } from "../audit.ts";
import { randomToken } from "../server/crypto.ts";
import { HttpError, type RateLimiter } from "../server/util.ts";
import type { Req } from "../types.ts";
import { areaNameOf } from "../../areas/store.ts";
import { queueSlots } from "../../rank/position.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";
import { pickDecision, shortRepo } from "../../../web/src/lib/links.ts";
import { canSeeInternals } from "./staff.ts";

export const CLAIM_TTL = 10 * 60_000;
const NOTE_MAX = 500;
const COMMENT_MAX = 4000;

export const isOperator = (req: Req): boolean => req.user.role === "operator";

const STATE: Record<string, ItemState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
export const itemState = (s: string | null | undefined): ItemState => STATE[s ?? ""] ?? "open";

const json = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

// A decision that covers a repo the requester may not see does not exist for them.
async function needDecision(db: DatabaseSync, req: Req, id: string): Promise<DecisionRow> {
  const d = getDecision(db, id);
  if (!d) throw new HttpError(404, `no decision ${id}`);
  const visible = new Set(await visibleRepos(db, req));
  if (reposOf(d).some((r) => !visible.has(r))) throw new HttpError(404, `no decision ${id}`);
  return d;
}

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

function optionalText(v: unknown, max: number, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t || null;
}

// GitHub write on every repo the decision covers (always the live check on a
// POST: the server re-checks a cached value older than a minute).
async function blockedRepos(req: Req, d: DecisionRow): Promise<string[]> {
  const repos = reposOf(d);
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => !ok[i]);
}

async function requireOperator(req: Req, d: DecisionRow): Promise<void> {
  if (!isOperator(req)) throw new HttpError(403, "only the operator answers decisions");
  const blocked = await blockedRepos(req, d);
  if (blocked.length) throw new HttpError(403, `no write access to ${blocked.map((r) => `storytold/${r}`).join(", ")}`);
}

// ---- reading -----------------------------------------------------------

type OpinionRow = { id: string; login: string; option: string | null; note: string | null; at: string; permission: string };
const toOpinion = (o: OpinionRow): Opinion => ({
  id: o.id, login: o.login, option: o.option, note: o.note, at: o.at, permission: o.permission === "write" ? "write" : "none",
});

type ClassRow = {
  classifier: string; at: string; type_label: string | null; want: string | null; reference: string | null;
  reason: string | null; dup_of: number | null;
};

export function classificationsOf(db: DatabaseSync, repo: string, n: number): Classification[] {
  // latest verdict per classifier
  const rows = db.prepare(`SELECT classifier, at, type_label, want, reference, reason, dup_of FROM classifications c
    WHERE repo = ? AND number = ? AND at = (SELECT MAX(at) FROM classifications x WHERE x.repo = c.repo AND x.number = c.number AND x.classifier = c.classifier)
    ORDER BY classifier`).all(repo, n) as ClassRow[];
  return rows.map((r) => ({
    classifier: r.classifier as Classification["classifier"], at: r.at,
    typeLabel: r.type_label as Classification["typeLabel"], want: (r.want ?? "unclear") as Classification["want"],
    reference: r.reference, reason: r.reason ?? "", dupOf: r.dup_of,
  }));
}

// Duplicates from the classifiers, issues a PR closes, and PRs that close this issue.
export function relatedOf(db: DatabaseSync, repo: string, n: number): RelatedItem[] {
  const out = new Map<string, { number: number; relation: Relation }>();
  const add = (number: number, relation: Relation) => {
    if (number !== n && Number.isInteger(number) && !out.has(String(number))) out.set(String(number), { number, relation });
  };
  for (const r of db.prepare("SELECT DISTINCT dup_of FROM classifications WHERE repo = ? AND number = ? AND dup_of IS NOT NULL").all(repo, n) as { dup_of: number }[])
    add(r.dup_of, "duplicate-of");
  for (const r of db.prepare("SELECT DISTINCT number FROM classifications WHERE repo = ? AND dup_of = ? LIMIT 10").all(repo, n) as { number: number }[])
    add(r.number, "duplicated-by");
  const it = db.prepare("SELECT kind, closing_issues FROM items WHERE repo = ? AND number = ?").get(repo, n) as { kind: string; closing_issues: string | null } | undefined;
  for (const x of json<unknown[]>(it?.closing_issues, [])) if (typeof x === "number") add(x, "fixes");
  if (it?.kind === "issue") {
    const prs = db.prepare(`SELECT number, closing_issues FROM items WHERE repo = ? AND kind = 'pr' AND closing_issues LIKE ? LIMIT 50`)
      .all(repo, `%${n}%`) as { number: number; closing_issues: string }[];
    for (const p of prs) if (json<unknown[]>(p.closing_issues, []).includes(n)) add(p.number, "links");
  }
  const look = db.prepare("SELECT title, state FROM items WHERE repo = ? AND number = ?");
  const res: RelatedItem[] = [];
  for (const { number, relation } of [...out.values()].slice(0, 10)) {
    const row = look.get(repo, number) as { title: string | null; state: string } | undefined;
    if (row) res.push({ repo, number, relation, title: row.title ?? "", state: itemState(row.state) });
  }
  return res;
}

// "One sentence. Another." or a JSON array of sentences, as the pipeline wrote it.
function contextOf(c: string | null): string[] {
  if (!c) return [];
  const arr = json<unknown>(c.trim().startsWith("[") ? c : null, null);
  if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  return c.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

export type Viewer = { login: string; operator: boolean; staff: boolean; slots?: Map<string, QueueSlot> };
export const viewerOf = (req: Req): Viewer => ({ login: req.user.login, operator: isOperator(req), staff: canSeeInternals(req) });
/** The viewer with the queue places of the items they may see, computed once for the response. */
const viewerWith = async (db: DatabaseSync, req: Req): Promise<Viewer> => ({ ...viewerOf(req), slots: queueSlots(db, await visibleRepos(db, req)) });

export function toDecision(db: DatabaseSync, d: DecisionRow, viewer: Viewer): Decision {
  const batch = isBatch(d);
  const refs = itemsOf(d);
  const look = db.prepare("SELECT title, body FROM items WHERE repo = ? AND number = ?");
  const item = batch ? undefined : (look.get(d.repo, d.number) as { title: string | null; body: string | null } | undefined);
  const opinions = (db.prepare(`SELECT id, login, option, note, at, permission FROM decision_opinions
    WHERE decision_id = ? AND retracted_at IS NULL ORDER BY at DESC`).all(d.id) as OpinionRow[]).map(toOpinion);
  const adopted = d.adopted_opinion
    ? (db.prepare("SELECT id, login, option, note, at, permission FROM decision_opinions WHERE id = ?").get(d.adopted_opinion) as OpinionRow | undefined)
    : undefined;
  const claimRow = db.prepare(`SELECT login, since FROM decision_claims WHERE decision_id = ? AND at > ? AND login <> ? ORDER BY at DESC LIMIT 1`)
    .get(d.id, new Date(Date.now() - CLAIM_TTL).toISOString(), viewer.login) as Claim | undefined;
  const commentCount = (db.prepare("SELECT COUNT(*) AS n FROM decision_comments WHERE decision_id = ?").get(d.id) as { n: number }).n;
  return {
    id: d.id, kind: d.kind as DecisionKind,
    repo: d.repo ?? refs[0]?.repo ?? "",
    number: d.number,
    items: batch ? refs.map((r) => ({ ...r, title: (look.get(r.repo, r.number) as { title: string | null } | undefined)?.title ?? "" })) : [],
    title: batch ? d.question : (item?.title ?? `${d.repo}#${d.number}`),
    question: d.question,
    summary: d.summary ?? "", summaryBy: d.summary_by ?? "", summaryAt: d.summary_at ?? d.asked_at,
    body: batch ? null : (item?.body ?? null),
    context: contextOf(d.context),
    facts: factsOf(d),
    options: optionsOf(d).map((o) => ({ ...o, writes: writeEffect(d.kind, o.key) ?? undefined })),
    recommended: d.recommended ?? "",
    recommendedReason: d.recommended ? (d.recommended_reason ?? "") : "",
    publicText: commentPreview(d),
    optionTexts: d.kind === "duplicate" && d.id.includes(":dupegroup:") ? optionTextsOf(db, d.id) : [],
    askedAt: d.asked_at, askedBy: d.asked_by ?? "the pipeline",
    docket: d.docket,
    answer: d.answer,
    answerNote: viewer.staff ? d.answer_note : null,
    answeredBy: d.answered_by, answeredAt: d.answered_at, appliedAt: d.applied_at,
    adoptedOpinion: adopted ? toOpinion(adopted) : null,
    opinions,
    exceptions: exceptionsOf(d),
    claim: d.answer ? null : (claimRow ? { login: claimRow.login, since: claimRow.since } : null),
    commentCount,
    related: batch ? [] : relatedOf(db, d.repo!, d.number!),
    classifications: batch ? [] : classificationsOf(db, d.repo!, d.number!),
    area: batch ? null : areaNameOf(db, d.repo!, d.number!),
    priority: batch ? null : priorityOf(db, d.repo!, d.number!),
    queue: batch ? null : (viewer.slots?.get(`${d.repo}#${d.number}`) ?? null),
  };
}

const list = (req: Req, key: string): string[] => req.query.getAll(key).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

// Decisions touching any of the given repos: the decision's own repo, or an item of a batch.
function inRepos(prefix: string, repos: string[], params: Record<string, string>): string {
  const names = repos.map((r, k) => {
    params[`${prefix}${k}`] = r;
    return `:${prefix}${k}`;
  }).join(",") || "NULL";
  return `(COALESCE(repo IN (${names}), 0) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
    WHERE json_extract(j.value, '$.repo') IN (${names})))`;
}

/** SQL that leaves out decisions touching a hidden repo (the decision's own, or an item of a batch); null when nothing is hidden. */
export function withoutHidden(hidden: string[], params: Record<string, string>): string | null {
  return hidden.length ? `NOT ${inRepos("hd", hidden, params)}` : null;
}

// Pages are cut by keyset: `after` is the `next` of the previous page, "<sort key>|<id>".
// Open decisions run oldest asked first, answered ones newest answer first.
export async function listDecisions(db: DatabaseSync, req: Req, writeRepos: () => Promise<string[]>): Promise<DecisionList> {
  const q = req.query;
  const status = q.get("status") ?? "open";
  if (!["open", "opinions", "answered", "backlog"].includes(status)) throw new HttpError(400, "status must be open, opinions, answered or backlog");
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (status === "answered") {
    where.push(`answer IS NOT NULL AND answer <> '${BACKLOG.key}' AND (applied_at IS NULL OR applied_at >= :since)`);
    params.since = new Date(Date.now() - 7 * 86400_000).toISOString();
  } else if (status === "backlog") where.push(`answer = '${BACKLOG.key}'`);
  else where.push("answer IS NULL");
  if (status === "opinions") where.push("(EXISTS (SELECT 1 FROM decision_opinions o WHERE o.decision_id = decisions.id AND o.retracted_at IS NULL) OR EXISTS (SELECT 1 FROM decision_comments c WHERE c.decision_id = decisions.id))");
  const kinds = list(req, "kind").filter((k) => (KINDS as readonly string[]).includes(k));
  if (kinds.length) where.push(`kind IN (${kinds.map((k) => `'${k}'`).join(",")})`);
  const minAge = Math.min(Number(q.get("minAge") ?? 0), 36500);
  if (minAge > 0) {
    where.push("asked_at <= :before");
    params.before = new Date(Date.now() - minAge * 86400_000).toISOString();
  }
  const hide = withoutHidden(await hiddenRepos(db, req), params);
  if (hide) where.push(hide);
  const repos = [...new Set(list(req, "repo"))];
  if (repos.length) where.push(inRepos("rp", repos, params));
  if (q.get("mine") === "1" || q.get("mine") === "true") where.push(inRepos("mn", await writeRepos(), params));

  // Counts and the oldest ask cover every match, not just the page.
  const kindRows = db.prepare(`SELECT kind, COUNT(*) AS n, MIN(asked_at) AS oldest FROM decisions WHERE ${where.join(" AND ")} GROUP BY kind`).all(params) as
    { kind: DecisionKind; n: number; oldest: string }[];
  const byKind: Partial<Record<DecisionKind, number>> = {};
  let total = 0;
  let oldestAskedAt: string | null = null;
  for (const r of kindRows) {
    byKind[r.kind] = r.n;
    total += r.n;
    if (oldestAskedAt === null || r.oldest < oldestAskedAt) oldestAskedAt = r.oldest;
  }

  const answered = status === "answered" || status === "backlog";
  const sortKey = answered ? "answered_at" : "asked_at";
  const after = q.get("after");
  const page = [...where];
  if (after) {
    const k = after.indexOf("|");
    if (k < 0) throw new HttpError(400, "after must be a next cursor");
    params.ck = after.slice(0, k);
    params.cid = after.slice(k + 1);
    page.push(`(${sortKey} ${answered ? "<" : ">"} :ck OR (${sortKey} = :ck AND id > :cid))`);
  }
  const limit = Math.min(Math.max(Number(q.get("limit")) || 100, 1), 500);
  const offset = after ? 0 : Math.max(Number(q.get("offset")) || 0, 0);
  const rows = db.prepare(`SELECT * FROM decisions WHERE ${page.join(" AND ")} ORDER BY ${sortKey} ${answered ? "DESC" : "ASC"}, id LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit: limit + 1, offset }) as DecisionRow[];
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1] as (DecisionRow & Record<string, string>) | undefined;
  const viewer = await viewerWith(db, req);
  return {
    decisions: shown.map((d) => toDecision(db, d, viewer)), total, byKind, oldestAskedAt,
    next: more && last ? `${last[sortKey]}|${last.id}` : null,
  };
}

export async function getOne(db: DatabaseSync, req: Req): Promise<Decision> {
  return toDecision(db, await needDecision(db, req, req.params.id!), await viewerWith(db, req));
}

/** The decision a readable link `/decisions/<repo>/<n>` opens, or null when the item has none the viewer may see. */
export async function forItem(db: DatabaseSync, req: Req): Promise<Decision | null> {
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  const repo = shortRepo(req.params.repo!);
  const visible = new Set(await visibleRepos(db, req));
  const rows = db.prepare(`SELECT * FROM decisions WHERE (repo = :repo AND number = :n) OR (number IS NULL AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
      WHERE json_extract(j.value, '$.repo') = :repo AND json_extract(j.value, '$.number') = :n))`).all({ repo, n }) as unknown as DecisionRow[];
  const viewer = await viewerWith(db, req);
  // A batch that also covers the item counts only when no single-item decision exists; it is the item's decision only by membership.
  const single = rows.filter((d) => d.number === n);
  const kind = req.query.get("kind");
  const shown = (single.length ? single : rows).filter((d) => !kind || d.kind === kind).filter((d) => reposOf(d).every((r) => visible.has(r))).map((d) => toDecision(db, d, viewer));
  return pickDecision(shown) ?? null;
}

export async function thread(db: DatabaseSync, req: Req): Promise<DecisionComment[]> {
  await needDecision(db, req, req.params.id!);
  return db.prepare("SELECT id, login, at, body FROM decision_comments WHERE decision_id = ? ORDER BY at, rowid").all(req.params.id!) as unknown as DecisionComment[];
}

// ---- operator writes -----------------------------------------------------

async function settled(db: DatabaseSync, req: Req, id: string): Promise<Decision> {
  db.prepare("DELETE FROM decision_claims WHERE decision_id = ?").run(id);
  return toDecision(db, getDecision(db, id)!, await viewerWith(db, req));
}

/** Runs `fn` in one write transaction, so a check and the write it guards cannot be separated by another process. */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export async function answer(db: DatabaseSync, req: Req): Promise<Decision> {
  const d = await needDecision(db, req, req.params.id!);
  await requireOperator(req, d);
  if (d.answer) throw new HttpError(409, `already answered by ${d.answered_by}`);
  const b = body(req);
  const keys = new Set(optionsOf(d).map((o) => o.key));
  if (typeof b.answer !== "string" || !keys.has(b.answer)) throw new HttpError(400, "answer must be one of the option keys");
  const ans = b.answer;
  const note = optionalText(b.note, NOTE_MAX, "note");
  let exceptions: Exception[] | null = null;
  if (b.exceptions !== undefined && b.exceptions !== null) {
    if (!Array.isArray(b.exceptions)) throw new HttpError(400, "exceptions must be an array");
    if (b.exceptions.length && !isBatch(d)) throw new HttpError(400, "exceptions are only for a batch");
    const inBatch = new Set(itemsOf(d).map((r) => `${r.repo}#${r.number}`));
    const seen = new Set<string>();
    exceptions = [];
    for (const e of b.exceptions as Partial<Exception>[]) {
      const ref = `${e?.repo}#${e?.number}`;
      if (!e || typeof e.repo !== "string" || !Number.isInteger(e.number) || !inBatch.has(ref) || seen.has(ref) || typeof e.answer !== "string" || !keys.has(e.answer) || e.answer === BACKLOG.key)
        throw new HttpError(400, "each exception needs an item of the batch and an option key");
      seen.add(ref);
      if (e.answer !== ans) exceptions.push({ repo: e.repo, number: e.number!, answer: e.answer });
    }
  }
  if (isBatch(d) && (exceptions === null || ans === BACKLOG.key)) exceptions = [];
  // A group answer approves the texts stored for its option; a page showing other texts is stale. Checked and written in one transaction.
  inTransaction(db, () => {
    const stored = d.kind === "duplicate" && d.id.includes(":dupegroup:") ? textsFor(db, d.id, ans) : [];
    if (stored.length && b.textsHash !== textsHash(stored)) throw new HttpError(409, "the comments for this answer changed; reload the decision");
    const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = ?, exceptions = ?, answered_by = ?, answered_at = ?, adopted_opinion = NULL
      WHERE id = ? AND answer IS NULL`).run(ans, note, exceptions ? JSON.stringify(exceptions) : null, req.user.login, new Date().toISOString(), d.id);
    if (r.changes !== 1) throw new HttpError(409, "someone answered this a moment ago");
  });
  audit(db, req.user.login, "answer", d.id, { answer: ans, exceptions: exceptions?.length ? exceptions : undefined, note: note ? true : undefined });
  return await settled(db, req, d.id);
}

export async function undo(db: DatabaseSync, req: Req): Promise<Decision> {
  const d = await needDecision(db, req, req.params.id!);
  await requireOperator(req, d);
  if (!d.answer) throw new HttpError(409, "that decision has no answer to undo");
  if (d.applied_at) throw new HttpError(409, "the pipeline already acted on this answer");
  inTransaction(db, () => {
    if (db.prepare("SELECT 1 FROM dupe_group_posts WHERE decision_id = ? AND url IS NOT NULL LIMIT 1").get(d.id)) throw new HttpError(409, "the pipeline already wrote to GitHub for this answer");
    const r = db.prepare(`UPDATE main.decisions SET answer = NULL, answer_note = NULL, exceptions = NULL, answered_by = NULL, answered_at = NULL, adopted_opinion = NULL
      WHERE id = ? AND answer IS NOT NULL AND applied_at IS NULL`).run(d.id);
    if (r.changes !== 1) throw new HttpError(409, "the pipeline acted on this a moment ago");
    resetGroupAnswer(db, d.id);
  });
  audit(db, req.user.login, "undo", d.id, { answer: d.answer, adopted: d.adopted_opinion ?? undefined });
  return toDecision(db, getDecision(db, d.id)!, await viewerWith(db, req));
}

export async function reopen(db: DatabaseSync, req: Req): Promise<Decision> {
  const d = await needDecision(db, req, req.params.id!);
  await requireOperator(req, d);
  if (d.answer !== BACKLOG.key) throw new HttpError(409, "that decision is not in the Backlog");
  const r = db.prepare(`UPDATE main.decisions SET answer = NULL, answer_note = NULL, exceptions = NULL, answered_by = NULL, answered_at = NULL, adopted_opinion = NULL
    WHERE id = ? AND answer = ?`).run(d.id, BACKLOG.key);
  if (r.changes !== 1) throw new HttpError(409, "someone changed this a moment ago");
  audit(db, req.user.login, "reopen", d.id, { answer: d.answer });
  return toDecision(db, getDecision(db, d.id)!, await viewerWith(db, req));
}

/** Operator bulk: answers every open decision in scope (`outsidePilot`, `repo`) with Backlog. Dry run unless `apply` is true. */
export async function backlogBulk(db: DatabaseSync, req: Req): Promise<{ applied: boolean; count: number; decisions: { id: string; kind: string; repo: string | null; number: number | null }[] }> {
  if (!isOperator(req)) throw new HttpError(403, "only operators put decisions in the Backlog");
  const b = body(req);
  const repo = typeof b.repo === "string" && b.repo ? b.repo : undefined;
  if (b.repo !== undefined && b.repo !== null && repo === undefined) throw new HttpError(400, "repo must be a repo name");
  if (b.apply !== undefined && typeof b.apply !== "boolean") throw new HttpError(400, "apply must be true or false");
  if (b.outsidePilot !== undefined && typeof b.outsidePilot !== "boolean") throw new HttpError(400, "outsidePilot must be true or false");
  if (!b.outsidePilot && !repo) throw new HttpError(400, "give outsidePilot: true or a repo");
  const res = backlogOpen(db, { outsidePilot: b.outsidePilot === true, repo }, req.user.login, b.apply === true);
  return { applied: res.applied, count: res.decisions.length, decisions: res.decisions };
}

export async function adopt(db: DatabaseSync, req: Req): Promise<Decision> {
  const d = await needDecision(db, req, req.params.id!);
  await requireOperator(req, d);
  if (d.answer) throw new HttpError(409, `already answered by ${d.answered_by}`);
  const oid = body(req).opinionId;
  if (typeof oid !== "string") throw new HttpError(400, "opinionId is required");
  const o = db.prepare("SELECT id, login, option FROM decision_opinions WHERE id = ? AND decision_id = ? AND retracted_at IS NULL").get(oid, d.id) as
    { id: string; login: string; option: string | null } | undefined;
  if (!o) throw new HttpError(404, "no such live opinion on this decision");
  if (!o.option || !optionsOf(d).some((x) => x.key === o.option)) throw new HttpError(400, "that opinion picks no option");
  const option = o.option;
  inTransaction(db, () => {
    const stored = d.kind === "duplicate" && d.id.includes(":dupegroup:") ? textsFor(db, d.id, option) : [];
    if (stored.length && body(req).textsHash !== textsHash(stored)) throw new HttpError(409, "the comments for this answer changed; reload the decision");
    const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = NULL, exceptions = ?, answered_by = ?, answered_at = ?, adopted_opinion = ?
      WHERE id = ? AND answer IS NULL`).run(option, isBatch(d) ? "[]" : null, req.user.login, new Date().toISOString(), o.id, d.id);
    if (r.changes !== 1) throw new HttpError(409, "someone answered this a moment ago");
  });
  audit(db, req.user.login, "adopt", d.id, { answer: o.option, opinion: o.id, of: o.login });
  return await settled(db, req, d.id);
}

// ---- writes by operators and maintainers ------------------------------------------

// Viewers are read-only; this runs before any other check so a refused viewer learns nothing about the decision.
function requireWriter(req: Req): void {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers cannot write");
}

// Maintainers: a fixed number of opinion and comment writes per login per hour.
function limited(req: Req, limiter: RateLimiter): void {
  if (!isOperator(req) && !limiter.allow(req.user.login.toLowerCase())) throw new HttpError(429, "too many feedback posts this hour; try again later");
}

/**
 * One feedback box: an optional option pick and free text, at least one of them. A pick is the
 * login's live opinion (its text is the note); text alone is a comment in the thread.
 */
export async function feedback(db: DatabaseSync, req: Req, limiter: RateLimiter): Promise<Decision> {
  requireWriter(req);
  const d = await needDecision(db, req, req.params.id!);
  limited(req, limiter);
  const b = body(req);
  const option = b.option ?? null;
  if (option !== null && (typeof option !== "string" || !optionsOf(d).some((o) => o.key === option))) throw new HttpError(400, "option must be an option key or null");
  const text = optionalText(b.text, COMMENT_MAX, "text");
  if (option === null && text === null) throw new HttpError(400, "give an option, text, or both");
  const at = new Date().toISOString();
  if (option === null) {
    const id = randomToken(12);
    db.prepare("INSERT INTO decision_comments (id, decision_id, login, at, body) VALUES (?, ?, ?, ?, ?)").run(id, d.id, req.user.login, at, text);
    audit(db, req.user.login, "comment", d.id, { comment: id, length: text!.length });
    return toDecision(db, getDecision(db, d.id)!, await viewerWith(db, req));
  }
  if (d.answer) throw new HttpError(409, "the decision is answered; picks are closed");
  const permission = (await blockedRepos(req, d)).length ? "none" : "write";
  db.exec("BEGIN IMMEDIATE");
  try {
    // The permission check above can wait on GitHub; the operator may have answered meanwhile.
    if ((db.prepare("SELECT answer FROM decisions WHERE id = ?").get(d.id) as { answer: string | null }).answer !== null)
      throw new HttpError(409, "the decision is answered; picks are closed");
    db.prepare("UPDATE decision_opinions SET retracted_at = ? WHERE decision_id = ? AND login = ? AND retracted_at IS NULL").run(at, d.id, req.user.login);
    db.prepare("INSERT INTO decision_opinions (id, decision_id, login, option, note, at, permission) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomToken(12), d.id, req.user.login, option, text, at, permission);
    audit(db, req.user.login, "opinion", d.id, { option, note: text ? true : undefined });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return toDecision(db, getDecision(db, d.id)!, await viewerWith(db, req));
}

export async function retract(db: DatabaseSync, req: Req, limiter: RateLimiter): Promise<Decision> {
  requireWriter(req);
  const d = await needDecision(db, req, req.params.id!);
  limited(req, limiter);
  if (d.answer) throw new HttpError(409, "the decision is answered; picks are closed");
  const r = db.prepare("UPDATE decision_opinions SET retracted_at = ? WHERE decision_id = ? AND login = ? AND retracted_at IS NULL")
    .run(new Date().toISOString(), d.id, req.user.login);
  if (r.changes !== 1) throw new HttpError(404, "you have no opinion on this decision");
  audit(db, req.user.login, "opinion-retract", d.id);
  return toDecision(db, getDecision(db, d.id)!, await viewerWith(db, req));
}

// Presence, not content: refreshed while someone has the decision open, so
// it is neither audited nor counted against the hourly limit.
export async function claim(db: DatabaseSync, req: Req): Promise<void> {
  requireWriter(req);
  const d = await needDecision(db, req, req.params.id!);
  if (d.answer) return;
  const now = new Date().toISOString();
  const lapsed = new Date(Date.now() - CLAIM_TTL).toISOString();
  db.prepare(`INSERT INTO decision_claims (decision_id, login, since, at) VALUES (?, ?, ?, ?)
    ON CONFLICT (decision_id, login) DO UPDATE SET since = CASE WHEN at <= ? THEN excluded.since ELSE since END, at = excluded.at`)
    .run(d.id, req.user.login, now, now, lapsed);
}
