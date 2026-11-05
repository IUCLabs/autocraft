// Runs one action card once through the existing write paths (src/github/write.ts, the decision answer,
// the per-repo approvals) with the operator's login on every audit row. Cards never run on their own.
import { guardRepo } from "../core/guard.ts";
import type { DatabaseSync } from "node:sqlite";
import { readLive } from "../act/index.ts";
import { duplicateComment } from "../act/templates.ts";
import { audit } from "../dash/audit.ts";
import { optionsOf, BACKLOG, HANDLED, getDecision, reposOf } from "../decisions.ts";
import { addLabels, closeItem, commentOn, type Note, type Writer } from "../github/write.ts";
import { repoLabels } from "../labels/github.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { closeRefusal, decisionStamp, openDecision, otherTypeLabel, stepLine, type CardParams, type Settle } from "./cards.ts";
import { ConversationError, insertTurn, staleOf, systemBlock, type StoreDeps } from "./store.ts";
import { COMMENT_MAX, NOTE_MAX, type CloseReason } from "./types.ts";

export type CardRow = {
  seen: string | null;
  id: number; turn_id: number; repo: string; number: number; kind: string; params: string; text: string | null; description: string;
  state: string; result: string | null; result_url: string | null; error: string | null; acted_by: string | null; acted_at: string | null; edited_by: string | null; edited_at: string | null;
};

/** `canWrite` is the signed-in operator's write access to a repo; the shell has none to check. */
export type ActDeps = StoreDeps & { querier?: Querier; canWrite?: (repo: string) => Promise<boolean>; /** Indexes into a resolution's steps the operator removed. */ skip?: number[]; /** The operator's note with the choice. */ note?: string };

export const cardOf = (db: DatabaseSync, id: number): CardRow | undefined =>
  db.prepare("SELECT * FROM conversation_cards WHERE id = ?").get(id) as CardRow | undefined;

function need(db: DatabaseSync, id: number): CardRow {
  const c = cardOf(db, id);
  if (!c) throw new ConversationError(404, `no card ${id}`);
  return c;
}

/** Cards come from the conversation prompt, which always runs on its first listed model. */
const CARD_NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const ref = (repo: string, n: number) => `${repo}#${n}`;

/** Replaces the text of a comment card that has not run. */
export function editCard(db: DatabaseSync, id: number, by: string, text: string, deps?: StoreDeps): CardRow {
  const c = need(db, id);
  if (c.kind !== "comment" && !((c.kind === "close" || c.kind === "resolution") && c.text !== null)) throw new ConversationError(400, "only a comment card, or a card with a comment, has text to edit");
  const t = text.trim();
  if (!t) throw new ConversationError(400, "the comment is empty");
  if (t.length > COMMENT_MAX) throw new ConversationError(400, `the comment is longer than ${COMMENT_MAX} characters`);
  const at = (deps?.now?.() ?? new Date()).toISOString();
  const r = db.prepare("UPDATE conversation_cards SET text = ?, edited_by = ?, edited_at = ? WHERE id = ? AND state = 'proposed'").run(t, by, at, id);
  if (r.changes !== 1) throw new ConversationError(409, `the card is already ${c.state}`);
  audit(db, by, "conversation-card-edit", ref(c.repo, c.number), { card: id });
  return need(db, id);
}

export function dismissCard(db: DatabaseSync, id: number, by: string, deps?: StoreDeps): CardRow {
  const c = need(db, id);
  const at = (deps?.now?.() ?? new Date()).toISOString();
  const r = db.prepare("UPDATE conversation_cards SET state = 'dismissed', acted_by = ?, acted_at = ? WHERE id = ? AND state = 'proposed'").run(by, at, id);
  if (r.changes !== 1) throw new ConversationError(409, `the card is already ${c.state}`);
  audit(db, by, "conversation-card-dismiss", ref(c.repo, c.number), { card: id });
  insertTurn(db, c.repo, c.number, { kind: "system", login: "system", body: `${by} dismissed the card: ${c.description}.`, block: systemBlock(`The operator ${by} dismissed the proposed action: ${c.description}.`) }, deps);
  return need(db, id);
}

type Outcome = { result: string; url: string | null };

/** Answers the decision the card was written for, like a dashboard answer: one transaction, the decision's claims cleared. */
async function answerDecision(db: DatabaseSync, c: CardRow, decisionId: string | undefined, stamp: string | undefined, key: string, by: string, at: string, canWrite?: ActDeps["canWrite"], note?: string): Promise<Outcome> {
  if (!decisionId) throw new Error("the card names no decision: the decision changed");
  const d0 = getDecision(db, decisionId);
  if (!d0 || d0.answer !== null || d0.repo !== c.repo || d0.number !== c.number || (stamp !== undefined && decisionStamp(db, d0) !== stamp)) throw new Error("the decision changed");
  if (canWrite) for (const r of reposOf(d0)) if (!(await canWrite(r).catch(() => false))) throw new Error(`no write access to storytold/${r}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const d = getDecision(db, decisionId);
    if (!d || d.answer !== null || (stamp !== undefined && decisionStamp(db, d) !== stamp)) throw new Error("the decision changed");
    const o = optionsOf(d).find((x) => x.key === key);
    if (!o) throw new Error(`"${key}" is not an option of the decision`);
    const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = ?, exceptions = NULL, answered_by = ?, answered_at = ?, adopted_opinion = NULL
      WHERE id = ? AND answer IS NULL`).run(key, note ?? null, by, at, d.id);
    if (r.changes !== 1) throw new Error("the decision changed");
    db.prepare("DELETE FROM main.decision_claims WHERE decision_id = ?").run(d.id);
    audit(db, by, "answer", d.id, { answer: key, source: "conversation" });
    db.exec("COMMIT");
    return { result: `Answered the decision with "${o.label}"`, url: null };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Closes the card's decision as handled in the conversation: the answer is HANDLED with the summary as its note, already applied, so no step acts on it. Writes nothing to GitHub. */
function resolveDecision(db: DatabaseSync, c: CardRow, decisionId: string | undefined, stamp: string | undefined, summary: string, by: string, at: string): Outcome {
  if (!decisionId) throw new Error("the card names no decision: the decision changed");
  db.exec("BEGIN IMMEDIATE");
  try {
    const d = getDecision(db, decisionId);
    if (!d || d.answer !== null || d.repo !== c.repo || d.number !== c.number || (stamp !== undefined && decisionStamp(db, d) !== stamp)) throw new Error("the decision changed");
    const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = ?, exceptions = NULL, answered_by = ?, answered_at = ?, applied_at = ?, adopted_opinion = NULL
      WHERE id = ? AND answer IS NULL`).run(HANDLED.key, summary, by, at, at, d.id);
    if (r.changes !== 1) throw new Error("the decision changed");
    db.prepare("DELETE FROM main.decision_claims WHERE decision_id = ?").run(d.id);
    audit(db, by, "answer", d.id, { answer: HANDLED.key, source: "conversation" });
    db.exec("COMMIT");
    return { result: "Decision closed as handled in the conversation", url: null };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

async function liveOpen(q: Querier, repo: string, n: number) {
  const live = await readLive(q, repo, n);
  if (!live) throw new Error("GitHub returned no such item");
  if (live.state !== "OPEN") throw new Error(`already ${live.state.toLowerCase()} on GitHub`);
  return live;
}

/** A resolution step failed; `posted` says the comment step had completed. */
class StepError extends Error {
  posted: boolean;
  constructor(message: string, posted: boolean) { super(message); this.posted = posted; }
}

type Ctx = {
  /** The operator's note: kept on the decision it settles, never posted to GitHub. */
  note?: string; db: DatabaseSync; c: CardRow; by: string; q: Querier; at: string; w: Writer; source: { source: string; card: number } };

async function postComment({ db, c, by, q, w, source }: Ctx, text: string): Promise<Outcome> {
  const g = guardRepo(db, c.repo, "comment", { operator: by });
  if ("refused" in g) throw new Error(g.refused);
  const live = await liveOpen(q, c.repo, c.number);
  const url = await commentOn(w, g, q, "act-comment", { repo: c.repo, number: c.number, id: live.id }, CARD_NOTE, text, source);
  return { result: "Comment posted", url: url || null };
}

async function addLabel({ db, c, by, q, at, w, source }: Ctx, label: string): Promise<Outcome> {
  const g = guardRepo(db, c.repo, "labels", { operator: by });
  if ("refused" in g) throw new Error(g.refused);
  const other = otherTypeLabel(db, c.repo, c.number, label);
  if (other) throw new Error(`the item already has the type label "${other}" and an item has one type label`);
  const live = await liveOpen(q, c.repo, c.number);
  const have = await repoLabels(q, c.repo);
  const id = have.labels.get(label.toLowerCase());
  if (!id) throw new Error(`the label "${label}" does not exist on ${c.repo}`);
  const done = await addLabels(w, q, c.repo, [{ number: c.number, id: live.id, labelIds: [id], names: [label], g }], undefined, source);
  if (!done.includes(c.number)) throw new Error("GitHub did not add the label");
  db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'labeled', ?, ?, ?)").run(c.repo, c.number, at, by, `added: ${label}`);
  return { result: `Label "${label}" added`, url: null };
}

/** Closes the item (after the optional comment) and returns how it was closed, for notes. Settling the decisions is the caller's. */
async function closeThe({ db, c, by, q, at, w, source }: Ctx, p: { reason: CloseReason }, text: string | null): Promise<{ how: string; url: string }> {
  const g = guardRepo(db, c.repo, "comment", { operator: by });
  if ("refused" in g) throw new Error(g.refused);
  const refusal = closeRefusal(db, c.repo, c.number);
  if (refusal) throw new Error(refusal);
  const live = await liveOpen(q, c.repo, c.number);
  const item = { repo: c.repo, number: c.number, id: live.id };
  const url = text ? await commentOn(w, g, q, "act-comment", item, CARD_NOTE, text, source) : "";
  await closeItem(w, g, q, { ...item, pr: live.type === "PullRequest" }, { ...source, head: live.head }, p.reason === "completed" ? "COMPLETED" : "NOT_PLANNED");
  const how = live.type === "PullRequest" ? "" : p.reason === "completed" ? " as completed" : " as not planned";
  db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'closed', ?, ?, ?)").run(c.repo, c.number, at, by, `closed${how} from a conversation`);
  return { how, url };
}

/** The item is closed: its open decisions (but `except`) are settled now, not at the next sync's withdrawal. */
function settleOthers(db: DatabaseSync, c: CardRow, how: string, by: string, at: string, except?: string): void {
  const open = db.prepare("SELECT id FROM decisions WHERE repo = ? AND number = ? AND answer IS NULL AND id NOT LIKE '%:dupegroup:%'").all(c.repo, c.number) as { id: string }[];
  for (const d of open) {
    if (d.id === except) continue;
    try { resolveDecision(db, c, d.id, undefined, `Closed${how} in the conversation`, by, at); } catch { /* answered meanwhile; the next sync withdraws what is left */ }
  }
}

/** Closes the item as a duplicate: Act's comment and close, recorded in `actions`. */
async function closeDuplicate({ db, c, by, q, at, w, source }: Ctx, of: number): Promise<{ url: string }> {
  const g = guardRepo(db, c.repo, "comment", { operator: by });
  if ("refused" in g) throw new Error(g.refused);
  const refusal = closeRefusal(db, c.repo, c.number);
  if (refusal) throw new Error(refusal);
  const live = await liveOpen(q, c.repo, c.number);
  const orig = await readLive(q, c.repo, of);
  if (!orig) throw new Error(`GitHub returned no ${ref(c.repo, of)}`);
  const url = await commentOn(w, g, q, "act-comment", { repo: c.repo, number: c.number, id: live.id }, CARD_NOTE, duplicateComment({ repo: c.repo, original: ref(c.repo, of), closed: orig.state !== "OPEN" }), source);
  // Recorded like Act's close: saved after the comment so the failed close shows what was posted.
  const action = (state: string, reason: string | null) => db.prepare(`INSERT INTO main.actions (decision_id, repo, number, kind, state, comment_url, reason, created_at) VALUES (?, ?, ?, 'comment-close', ?, ?, ?, ?)
    ON CONFLICT (decision_id, repo, number, kind) DO UPDATE SET state = excluded.state, reason = excluded.reason, created_at = excluded.created_at`).run(`conversation-card:${c.id}`, c.repo, c.number, state, url || null, reason, at);
  action("failed", "comment posted; close not done yet");
  await closeItem(w, g, q, { repo: c.repo, number: c.number, id: live.id, pr: live.type === "PullRequest" }, { ...source, head: live.head });
  action("done", null);
  db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'closed', ?, ?, ?)").run(c.repo, c.number, at, by, `closed as a duplicate of ${ref(c.repo, of)} from a conversation`);
  return { url };
}

/** Fails before any step runs when the decision a resolution settles has changed. */
async function checkSettle(db: DatabaseSync, c: CardRow, s: Settle, canWrite?: ActDeps["canWrite"]): Promise<void> {
  const d = getDecision(db, s.decision);
  if (!d || d.answer !== null || d.repo !== c.repo || d.number !== c.number || decisionStamp(db, d) !== s.stamp) throw new Error("the decision changed");
  if (s.kind === "answer" && !optionsOf(d).some((x) => x.key === s.option)) throw new Error(`"${s.option}" is not an option of the decision`);
  if (s.kind !== "handled" && canWrite) for (const r of reposOf(d)) if (!(await canWrite(r).catch(() => false))) throw new Error(`no write access to storytold/${r}`);
}

/** Runs the steps in order, then the settlement. A failure stops the run, leaves the decision open and names the steps already done. */
async function runResolution(ctx: Ctx, p: CardParams & { kind: "resolution" }, canWrite?: ActDeps["canWrite"]): Promise<Outcome> {
  const { db, c, by, at } = ctx;
  if (p.settle) await checkSettle(db, c, p.settle, canWrite);
  else if (!(p.steps.length === 1 && p.steps[0]!.kind === "comment") && openDecision(db, c.repo, c.number)) throw new Error("the decision changed");
  const done: string[] = [];
  const results: string[] = [];
  let url: string | null = null;
  let closedHow: string | null = null;
  try {
    for (const st of p.steps) {
      switch (st.kind) {
        case "comment": {
          const o = await postComment(ctx, c.text ?? "");
          url ??= o.url;
          results.push(o.result);
          break;
        }
        case "label": results.push((await addLabel(ctx, st.label)).result); break;
        case "close": {
          const r = await closeThe(ctx, st, null);
          closedHow = r.how;
          results.push(`Closed${r.how}`);
          break;
        }
        case "duplicate": {
          const r = await closeDuplicate(ctx, st.of);
          url ??= r.url || null;
          closedHow = " as a duplicate";
          results.push(`Closed as a duplicate of ${ref(c.repo, st.of)}`);
          break;
        }
      }
      done.push(stepLine(st));
    }
    const s = p.settle;
    if (s) {
      results.push((s.kind === "answer" ? await answerDecision(db, c, s.decision, s.stamp, s.option, by, at, canWrite, ctx.note)
        : s.kind === "backlog" ? await answerDecision(db, c, s.decision, s.stamp, BACKLOG.key, by, at, canWrite, ctx.note)
        : resolveDecision(db, c, s.decision, s.stamp, ctx.note ? `${s.summary}: ${ctx.note}` : s.summary, by, at)).result);
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    throw new StepError(done.length ? `Already done: ${done.join("; ")}. ${msg}. The question stays open` : msg, done.includes(stepLine({ kind: "comment" })));
  }
  if (closedHow !== null) settleOthers(db, c, closedHow, by, at, p.settle?.decision);
  return { result: results.join("; "), url };
}

async function run(db: DatabaseSync, c: CardRow, p: CardParams, by: string, q: Querier, at: string, canWrite?: ActDeps["canWrite"], note?: string): Promise<Outcome> {
  const ctx: Ctx = { note, db, c, by, q, at, w: { db, login: by }, source: { source: "conversation", card: c.id } };
  switch (p.kind) {
    case "resolution": return runResolution(ctx, p, canWrite);
    case "answer": return answerDecision(db, c, p.decision, p.stamp, p.option, by, at, canWrite, note);
    case "resolve": return resolveDecision(db, c, p.decision, p.stamp, note ? `${p.summary}: ${note}` : p.summary, by, at);
    case "backlog": return answerDecision(db, c, p.decision, p.stamp, BACKLOG.key, by, at, canWrite, note);
    case "comment": return postComment(ctx, c.text ?? p.text);
    case "label": return addLabel(ctx, p.label);
    case "close": {
      const r = await closeThe(ctx, p, c.text);
      settleOthers(db, c, r.how, by, at);
      return { result: `Closed${r.how}`, url: r.url || null };
    }
    case "duplicate": {
      const r = await closeDuplicate(ctx, p.of);
      return { result: `Closed as a duplicate of ${ref(c.repo, p.of)}`, url: r.url || null };
    }
  }
}

/**
 * Runs the card once. A card that is not `proposed` is returned unchanged, so a second press (or a double click) does nothing.
 * A failure is stored on the card; the card does not run again.
 */
export async function doCard(db: DatabaseSync, id: number, by: string, deps: ActDeps = {}): Promise<{ card: CardRow; ran: boolean }> {
  const c = need(db, id);
  if (c.state === "replaced") throw new ConversationError(409, "replaced by a later reply");
  if (c.state === "proposed" && staleOf(db, c.repo, c.number, c.seen) === "pr-changed") throw new ConversationError(409, "the PR changed since this was proposed");
  const note = deps.note?.trim() || undefined;
  if (note && note.length > NOTE_MAX) throw new ConversationError(400, `the note is longer than ${NOTE_MAX} characters`);
  let params = JSON.parse(c.params) as CardParams;
  const skipped: string[] = [];
  if (deps.skip?.length) {
    if (params.kind !== "resolution") throw new ConversationError(400, "only a resolution has steps to skip");
    const all = params.steps;
    if (new Set(deps.skip).size !== deps.skip.length || deps.skip.some((k) => !Number.isInteger(k) || k < 0 || k >= all.length)) throw new ConversationError(400, "skip must list distinct step positions of the card");
    const steps = all.filter((_, k) => !deps.skip!.includes(k));
    if (steps.length === 0 && !params.settle) throw new ConversationError(400, "a card with no steps left and no settlement does nothing");
    skipped.push(...all.filter((_, k) => deps.skip!.includes(k)).map(stepLine));
    params = { ...params, steps };
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const claim = db.prepare("UPDATE conversation_cards SET state = 'running', acted_by = ?, acted_at = ? WHERE id = ? AND state = 'proposed'").run(by, at, id);
  if (claim.changes !== 1) return { card: c, ran: false };
  let out: Outcome | null = null, error: string | null = null, posted = false;
  try {
    out = await run(db, c, params, by, deps.querier ?? new Client(1000), at, deps.canWrite, note);
  } catch (e) {
    error = oneLine(String((e as Error).message ?? e));
    posted = e instanceof StepError && e.posted;
  }
  if (out && skipped.length) out = { ...out, result: `${out.result} (skipped: ${skipped.join("; ")})` };
  const end = (deps.now?.() ?? new Date()).toISOString();
  db.prepare("UPDATE conversation_cards SET state = ?, result = ?, result_url = ?, error = ?, acted_at = ? WHERE id = ?")
    .run(out ? "done" : "failed", out?.result ?? null, out?.url ?? null, error, end, id);
  audit(db, by, "conversation-card", ref(c.repo, c.number), { card: id, kind: c.kind, state: out ? "done" : "failed", error: error ?? undefined, ...(skipped.length && { skipped }), ...(note && { note: true }) });
  const sentence = out ? `The operator ${by} ran the proposed action: ${c.description}. Result: ${out.result}.` : `The operator ${by} tried the proposed action: ${c.description}${skipped.length ? ` (without: ${skipped.join("; ")})` : ""}. It failed: ${error}.`;
  const posted_text = params.kind === "comment" ? c.text ?? params.text : (params.kind === "close" || (params.kind === "resolution" && params.steps.some((x) => x.kind === "comment") && (out || posted))) && c.text ? c.text : undefined;
  const data = posted_text !== undefined || note ? { ...(posted_text !== undefined && { posted_text }), ...(note && { operator_note: note }) } : undefined;
  insertTurn(db, c.repo, c.number, {
    kind: "system", login: "system", body: (out ? `${by} ran the card: ${c.description}. ${out.result}.` : `${by} tried the card: ${c.description}. It failed: ${error}.`) + (note ? ` Note: ${note}` : ""),
    block: systemBlock(sentence, data),
  }, deps);
  return { card: need(db, id), ran: true };
}

/** A card left 'running' by a crashed process is marked failed: what it did on GitHub is unknown. */
export const RUNNING_STALE_MS = 10 * 60_000;
export function sweepRunningCards(db: DatabaseSync, deps?: StoreDeps): number {
  const cutoff = new Date((deps?.now?.() ?? new Date()).getTime() - RUNNING_STALE_MS).toISOString();
  return db.prepare("UPDATE conversation_cards SET state = 'failed', error = 'outcome unknown; see the GitHub activity page' WHERE state = 'running' AND acted_at < ?").run(cutoff).changes as number;
}
