// "Needs you": feedback people left that nobody has answered, and what the pipeline stopped. Decisions have their own API.
// Dashboard users' text is shown here and never read by a prompt.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { NeedsFeedbackPage, NeedsFeedbackRow, NeedsPage, NeedsStoppedRow } from "../../../web/src/api/types.ts";
import { listAccounts } from "../../agents/accounts.ts";
import { SNOOZED_SQL, getDecision, reposOf, type DecisionRow } from "../../decisions.ts";
import { stageLimits } from "../../runner/autopilot.ts";
import { decisionPath, itemPath } from "../../../web/src/lib/links.ts";
import { reviewBots } from "../../review/bots.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { fixStoppedWait } from "../../core/decide-item.ts";
import { blankIfHidden, hiddenRepos } from "./visible.ts";
import { allOwnLogins } from "../../github/identity.ts";

export const NEEDS_PAGE = 30;
/** Older feedback is not asked for any more; the window also bounds the scans. */
const WINDOW_MS = 60 * 86_400_000;

type Raw = { id: string; source: NeedsFeedbackRow["source"]; author: string; at: string; text: string; repo: string | null; number: number | null; decision: string | null; turn: number | null; comment: string | null; handled: number };

// One SELECT per source, each with a `handled` flag. They share the parameters :since, :cur (newest time wanted), :own (the box account), :owns (JSON list of every login that is ours) and :bots.
const SOURCES: string[] = [
  // Feedback on a decision from anyone but an operator; handled once the decision was answered afterwards.
  `SELECT 'decision-comment:' || c.id AS id, 'decision' AS source, c.login AS author, c.at, c.body AS text, d.repo, d.number, d.id AS decision, NULL AS turn, c.id AS comment,
     d.answered_at IS NOT NULL AND d.answered_at > c.at AS handled
   FROM decision_comments c JOIN decisions d ON d.id = c.decision_id
   WHERE c.at >= :since AND c.at <= :cur AND NOT EXISTS (SELECT 1 FROM access a WHERE a.login = c.login AND a.role = 'operator')`,
  `SELECT 'decision-opinion:' || o.id, 'decision', o.login, o.at, o.note, d.repo, d.number, d.id, NULL, NULL,
     d.answered_at IS NOT NULL AND d.answered_at > o.at
   FROM decision_opinions o JOIN decisions d ON d.id = o.decision_id
   WHERE o.at >= :since AND o.at <= :cur AND o.retracted_at IS NULL AND TRIM(COALESCE(o.note, '')) <> ''
     AND NOT EXISTS (SELECT 1 FROM access a WHERE a.login = o.login AND a.role = 'operator')`,
  // An operator's message to Opus on an item; handled once Opus answered it.
  `SELECT 'turn:' || t.id, 'operator', t.login, t.at, t.body, t.repo, t.number, NULL, t.id, NULL, t.status IS NULL OR t.status = 'answered'
   FROM conversation_turns t WHERE t.kind = 'operator' AND t.at >= :since AND t.at <= :cur`,
  // A GitHub comment or review that names the pipeline login (flagged when written, so an index finds them); handled once the
  // pipeline login posted on the item afterwards. Nothing without a pipeline login.
  `SELECT 'comment:' || c.id, 'github', c.author, c.created_at, c.body, c.repo, c.number, NULL, NULL, c.id,
     EXISTS (SELECT 1 FROM comments a WHERE a.repo = c.repo AND a.number = c.number AND a.author IN (SELECT value FROM json_each(:owns)) AND a.created_at > c.created_at)
   FROM comments c
   WHERE :own <> '' AND c.mentions_pipeline = 1 AND c.created_at >= :since AND c.created_at <= :cur AND c.author IS NOT NULL AND c.author NOT IN (SELECT value FROM json_each(:owns))`,
  // The comment right after one of AutoCraft's own (a comment the audit log recorded with its URL and text, or the review we posted (audit `review-post`); the account's older manual comments do not count), on an item it commented on; bots do not count as replies.
  `SELECT 'comment:' || c.id, 'github', c.author, c.created_at, c.body, c.repo, c.number, NULL, NULL, c.id,
     EXISTS (SELECT 1 FROM comments a WHERE a.repo = c.repo AND a.number = c.number AND a.author IN (SELECT value FROM json_each(:owns)) AND a.created_at > c.created_at)
   FROM (SELECT DISTINCT repo, number FROM comments WHERE author IN (SELECT value FROM json_each(:owns))) o JOIN comments c ON c.repo = o.repo AND c.number = o.number
   WHERE :own <> '' AND c.mentions_pipeline = 0 AND c.created_at >= :since AND c.created_at <= :cur AND c.author IS NOT NULL AND c.author NOT IN (SELECT value FROM json_each(:owns)) AND c.author NOT LIKE '%[bot]' AND lower(c.author) NOT IN (SELECT value FROM json_each(:bots)) AND TRIM(COALESCE(c.body, '')) <> ''
     AND EXISTS (SELECT 1 FROM (SELECT p.id, p.author, p.body FROM comments p WHERE p.repo = c.repo AND p.number = c.number AND p.created_at < c.created_at ORDER BY p.created_at DESC LIMIT 1) q
       WHERE q.author IN (SELECT value FROM json_each(:owns)) AND EXISTS (SELECT 1 FROM audit a WHERE a.target = c.repo || '#' || c.number
         AND ((json_extract(a.details, '$.url') IS NOT NULL AND TRIM(REPLACE(json_extract(a.details, '$.text'), char(13), ''), ' ' || char(10) || char(9)) = TRIM(REPLACE(q.body, char(13), ''), ' ' || char(10) || char(9)))
           OR (a.action = 'review-post' AND json_extract(a.details, '$.review') = q.id))))`,
];

const ownLogin = (db: DatabaseSync): string => (db.prepare("SELECT value FROM main.settings WHERE key = 'pipeline_login'").get() as { value: string } | undefined)?.value ?? "";

function hiddenSql(hidden: string[], params: Record<string, SQLInputValue>): string {
  if (!hidden.length) return "1";
  return `(repo IS NULL OR repo NOT IN (${hidden.map((h, k) => ((params[`h${k}`] = h), `:h${k}`)).join(",")}))`;
}

function feedback(db: DatabaseSync, hidden: string[], cursor: { at: string; id: string } | null, limit: number): { rows: Raw[]; more: boolean; unhandled: number } {
  const params: Record<string, SQLInputValue> = { since: new Date(Date.now() - WINDOW_MS).toISOString(), own: ownLogin(db), owns: JSON.stringify([...allOwnLogins(db)]), bots: JSON.stringify(reviewBots()) };
  const union = SOURCES.map((s) => `SELECT * FROM (${s})`).join(" UNION ALL ");
  const where = hiddenSql(hidden, params);
  const size = limit * 3 + 1;
  // Feedback on a batch decision is hidden when the batch holds an item of a hidden repo.
  const batches = new Map<string, boolean>();
  const visible = (r: Pick<Raw, "source" | "number" | "decision">): boolean => {
    if (r.source !== "decision" || r.number !== null || !r.decision) return true;
    let ok = batches.get(r.decision);
    if (ok === undefined) {
      const d = getDecision(db, r.decision);
      ok = !d || !reposOf(d).some((x) => hidden.includes(x));
      batches.set(r.decision, ok);
    }
    return ok;
  };
  // Time-ordered, so each source reads its index range; rows that are filtered out make it read on until the page is full.
  const page = db.prepare(`SELECT * FROM (${union}) WHERE ${where} AND (at < :cur OR (at = :cur AND id < :curId)) ORDER BY at DESC, id DESC LIMIT :limit`);
  const rows: Raw[] = [];
  let pos = cursor ?? { at: "9999", id: "\uffff" };
  while (rows.length <= limit) {
    const batch = page.all({ ...params, cur: pos.at, curId: pos.id, limit: size }) as Raw[];
    rows.push(...batch.filter(visible));
    const tail = batch[batch.length - 1];
    if (batch.length < size || !tail) break;
    pos = { at: tail.at, id: tail.id };
  }
  const open = db.prepare(`SELECT source, number, decision, COUNT(*) AS n FROM (${union}) WHERE ${where} AND NOT handled GROUP BY source, number IS NULL, decision`).all({ ...params, cur: "9999" }) as { source: Raw["source"]; number: number | null; decision: string | null; n: number }[];
  const unhandled = open.reduce((sum, r) => sum + (visible(r) ? r.n : 0), 0);
  return { rows: rows.slice(0, limit), more: rows.length > limit, unhandled };
}

function view(db: DatabaseSync, r: Raw): NeedsFeedbackRow {
  const it = r.repo && r.number !== null ? (db.prepare("SELECT kind, state, title FROM items WHERE repo = ? AND number = ?").get(r.repo, r.number) as { kind: string; state: string; title: string | null } | undefined) : undefined;
  const item = r.repo && r.number !== null ? { repo: r.repo, number: r.number, kind: it ? (it.kind === "pr" ? "pr" as const : "issue" as const) : null, state: it ? itemState(it.state) : null, title: it?.title ?? null } : null;
  const trace = (event: string) => (item ? `${itemPath(item.repo, item.number)}#event=${encodeURIComponent(event)}` : "/needs");
  const [href, hrefLabel] = r.source === "decision"
    ? [decisionPath({ id: r.decision!, repo: r.repo ?? "", number: null }), "Decision"]
    : r.source === "operator" ? [trace(`turn:${r.turn}`), "Conversation"] : [trace(`comment:${r.comment}`), "Comment"];
  return { id: r.id, source: r.source, item, author: r.author, at: r.at, text: r.text, href, hrefLabel, handled: !!r.handled };
}

const humanize = (id: string): string => { const t = id.replace(/[-_]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

export async function stopped(db: DatabaseSync, hidden: string[]): Promise<NeedsStoppedRow[]> {
  const out: NeedsStoppedRow[] = [];
  for (const t of db.prepare("SELECT stage, reason, tripped_at FROM stage_trips WHERE active = 1 ORDER BY tripped_at").all() as { stage: string; reason: string; tripped_at: string }[])
    out.push({ id: `breaker:${t.stage}`, kind: "breaker", title: humanize(t.stage), reason: blankIfHidden(t.reason, hidden), since: t.tripped_at, resume: { type: "trip", stage: t.stage } });
  const updated = new Map((db.prepare("SELECT step, updated_at FROM stage_limits").all() as { step: string; updated_at: string | null }[]).map((r) => [r.step, r.updated_at]));
  for (const l of await stageLimits(db))
    if (l.perDay === 0 && !l.tripped) out.push({ id: `limit:${l.step}`, kind: "limit", title: l.title, reason: "The daily limit is 0", since: updated.get(l.step) ?? null, resume: { type: "link", to: "/pipeline" } });
  for (const a of listAccounts(db))
    if (a.enabled && a.pausedReason) out.push({ id: `account:${a.id}`, kind: "account", title: a.label, reason: blankIfHidden(a.pausedReason, hidden), since: null, resume: { type: "link", to: "/accounts" } });
  // Issues whose fix attempt was skipped or failed: the plan waits on a person, and Fix again clears it.
  const fixes = db.prepare(`SELECT p.repo, p.number, i.title, a.state, a.reason, a.summary, COALESCE(a.updated_at, p.planned_at) AS since
    FROM main.item_plans p JOIN items i ON i.repo = p.repo AND i.number = p.number LEFT JOIN fix_attempts a ON a.repo = p.repo AND a.number = p.number
    WHERE p.kind = 'issue' AND p.wait IN (?, ?) ORDER BY since`).all(fixStoppedWait("skipped"), fixStoppedWait("failed")) as
    { repo: string; number: number; title: string | null; state: string | null; reason: string | null; summary: string | null; since: string | null }[];
  for (const r of fixes) {
    if (hidden.includes(r.repo)) continue;
    out.push({ id: `fix:${r.repo}#${r.number}`, kind: "fix", title: `${r.repo}#${r.number} ${r.title ?? ""}`.trim(), reason: `The fix attempt was ${r.state ?? "stopped"}${r.reason ?? r.summary ? `: ${r.reason ?? r.summary}` : ""}`, since: r.since, resume: { type: "fix", repo: r.repo, number: r.number } });
  }
  return out;
}

export async function needs(db: DatabaseSync, req: Req): Promise<NeedsPage> {
  const hidden = await hiddenRepos(db, req);
  const q = req.query;
  const limitRaw = q.get("limit");
  if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? NEEDS_PAGE), 1), 100);
  const c = q.get("cursor");
  let cursor: { at: string; id: string } | null = null;
  if (c) {
    const i = c.indexOf("|");
    if (i < 1) throw new HttpError(400, "bad cursor");
    cursor = { at: c.slice(0, i), id: c.slice(i + 1) };
  }
  const fb = feedback(db, hidden, cursor, q.get("feedback") === "1" ? limit : 1);
  // A batch decision counts only when none of its items is in a hidden repo, as in the Decisions list.
  const decisions = hidden.length
    ? (db.prepare(`SELECT * FROM decisions WHERE answer IS NULL AND NOT ${SNOOZED_SQL}`).all() as DecisionRow[]).filter((d) => !reposOf(d).some((x) => hidden.includes(x))).length
    : (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE answer IS NULL AND NOT ${SNOOZED_SQL}`).get() as { n: number }).n;
  const rows = await stopped(db, hidden);
  const last = fb.rows[fb.rows.length - 1];
  return {
    counts: { decisions, feedback: fb.unhandled, stopped: rows.length },
    feedback: q.get("feedback") === "1" ? { rows: fb.rows.map((r) => view(db, r)), nextCursor: fb.more && last ? `${last.at}|${last.id}` : null } : null,
    stopped: rows,
  };
}
