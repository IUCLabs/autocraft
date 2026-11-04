// "Do it": runs one action card once through the existing write paths (src/github/write.ts, the decision answer,
// the per-repo approvals) with the operator's login on every audit row. Cards never run on their own.
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { readLive } from "../act/index.ts";
import { duplicateComment } from "../act/templates.ts";
import { audit } from "../dash/audit.ts";
import { optionsOf, BACKLOG, getDecision, reposOf } from "../decisions.ts";
import { addLabels, closeItem, commentOn, type Note, type Writer } from "../github/write.ts";
import { approvalOf as labelsApprovalOf } from "../labels/approval.ts";
import { repoLabels } from "../labels/github.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { closeRefusal, decisionStamp, otherTypeLabel, type CardParams } from "./cards.ts";
import { ConversationError, insertTurn, systemBlock, type StoreDeps } from "./store.ts";
import { COMMENT_MAX } from "./types.ts";

export type CardRow = {
  id: number; turn_id: number; repo: string; number: number; kind: string; params: string; text: string | null; description: string;
  state: string; result: string | null; result_url: string | null; error: string | null; acted_by: string | null; acted_at: string | null; edited_by: string | null; edited_at: string | null;
};

/** `canWrite` is the signed-in operator's write access to a repo; the shell has none to check. */
export type ActDeps = StoreDeps & { querier?: Querier; canWrite?: (repo: string) => Promise<boolean> };

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
  if (c.kind !== "comment") throw new ConversationError(400, "only a comment card has text to edit");
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
async function answerDecision(db: DatabaseSync, c: CardRow, decisionId: string | undefined, stamp: string | undefined, key: string, by: string, at: string, canWrite?: ActDeps["canWrite"]): Promise<Outcome> {
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
    const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = NULL, exceptions = NULL, answered_by = ?, answered_at = ?, adopted_opinion = NULL
      WHERE id = ? AND answer IS NULL`).run(key, by, at, d.id);
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

async function liveOpen(q: Querier, repo: string, n: number) {
  const live = await readLive(q, repo, n);
  if (!live) throw new Error("GitHub returned no such item");
  if (live.state !== "OPEN") throw new Error(`already ${live.state.toLowerCase()} on GitHub`);
  return live;
}

async function run(db: DatabaseSync, c: CardRow, p: CardParams, by: string, q: Querier, at: string, canWrite?: ActDeps["canWrite"]): Promise<Outcome> {
  const w: Writer = { db, login: by };
  const source = { source: "conversation", card: c.id };
  switch (p.kind) {
    case "answer": return answerDecision(db, c, p.decision, p.stamp, p.option, by, at, canWrite);
    case "backlog": return answerDecision(db, c, p.decision, p.stamp, BACKLOG.key, by, at, canWrite);
    case "comment": {
      if (!commentApprovalOf(db, c.repo)) throw new Error(`commenting in ${c.repo} is not approved`);
      const live = await liveOpen(q, c.repo, c.number);
      const url = await commentOn(w, q, "act-comment", { repo: c.repo, number: c.number, id: live.id }, CARD_NOTE, c.text ?? p.text, source);
      return { result: "Comment posted", url: url || null };
    }
    case "label": {
      if (!labelsApprovalOf(db, c.repo)) throw new Error(`labelling ${c.repo} is not approved`);
      const other = otherTypeLabel(db, c.repo, c.number, p.label);
      if (other) throw new Error(`the item already has the type label "${other}" and an item has one type label`);
      const live = await liveOpen(q, c.repo, c.number);
      const have = await repoLabels(q, c.repo);
      const id = have.labels.get(p.label.toLowerCase());
      if (!id) throw new Error(`the label "${p.label}" does not exist on ${c.repo}`);
      const done = await addLabels(w, q, c.repo, [{ number: c.number, id: live.id, labelIds: [id], names: [p.label] }], undefined, source);
      if (!done.includes(c.number)) throw new Error("GitHub did not add the label");
      db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'labeled', ?, ?, ?)").run(c.repo, c.number, at, by, `added: ${p.label}`);
      return { result: `Label "${p.label}" added`, url: null };
    }
    case "duplicate": {
      if (!commentApprovalOf(db, c.repo)) throw new Error(`commenting in ${c.repo} is not approved`);
      const refusal = closeRefusal(db, c.repo, c.number);
      if (refusal) throw new Error(refusal);
      const live = await liveOpen(q, c.repo, c.number);
      const orig = await readLive(q, c.repo, p.of);
      if (!orig) throw new Error(`GitHub returned no ${ref(c.repo, p.of)}`);
      const url = await commentOn(w, q, "act-comment", { repo: c.repo, number: c.number, id: live.id }, CARD_NOTE, duplicateComment({ repo: c.repo, original: ref(c.repo, p.of), closed: orig.state !== "OPEN" }), source);
      // Recorded like Act's close: saved after the comment so the failed close shows what was posted.
      const action = (state: string, reason: string | null) => db.prepare(`INSERT INTO main.actions (decision_id, repo, number, kind, state, comment_url, reason, created_at) VALUES (?, ?, ?, 'comment-close', ?, ?, ?, ?)
        ON CONFLICT (decision_id, repo, number, kind) DO UPDATE SET state = excluded.state, reason = excluded.reason, created_at = excluded.created_at`).run(`conversation-card:${c.id}`, c.repo, c.number, state, url || null, reason, at);
      action("failed", "comment posted; close not done yet");
      await closeItem(w, q, { repo: c.repo, number: c.number, id: live.id, pr: live.type === "PullRequest" }, { ...source, head: live.head });
      action("done", null);
      db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'closed', ?, ?, ?)").run(c.repo, c.number, at, by, `closed as a duplicate of ${ref(c.repo, p.of)} from a conversation`);
      return { result: `Closed as a duplicate of ${ref(c.repo, p.of)}`, url: url || null };
    }
  }
}

/**
 * Runs the card once. A card that is not `proposed` is returned unchanged, so a second press (or a double click) does nothing.
 * A failure is stored on the card; the card does not run again.
 */
export async function doCard(db: DatabaseSync, id: number, by: string, deps: ActDeps = {}): Promise<{ card: CardRow; ran: boolean }> {
  const c = need(db, id);
  const at = (deps.now?.() ?? new Date()).toISOString();
  const claim = db.prepare("UPDATE conversation_cards SET state = 'running', acted_by = ?, acted_at = ? WHERE id = ? AND state = 'proposed'").run(by, at, id);
  if (claim.changes !== 1) return { card: c, ran: false };
  const params = JSON.parse(c.params) as CardParams;
  let out: Outcome | null = null, error: string | null = null;
  try {
    out = await run(db, c, params, by, deps.querier ?? new Client(1000), at, deps.canWrite);
  } catch (e) {
    error = oneLine(String((e as Error).message ?? e));
  }
  const end = (deps.now?.() ?? new Date()).toISOString();
  db.prepare("UPDATE conversation_cards SET state = ?, result = ?, result_url = ?, error = ?, acted_at = ? WHERE id = ?")
    .run(out ? "done" : "failed", out?.result ?? null, out?.url ?? null, error, end, id);
  audit(db, by, "conversation-card", ref(c.repo, c.number), { card: id, kind: c.kind, state: out ? "done" : "failed", error: error ?? undefined });
  const sentence = out ? `The operator ${by} ran the proposed action: ${c.description}. Result: ${out.result}.` : `The operator ${by} tried the proposed action: ${c.description}. It failed: ${error}.`;
  insertTurn(db, c.repo, c.number, {
    kind: "system", login: "system", body: out ? `${by} ran the card: ${c.description}. ${out.result}.` : `${by} tried the card: ${c.description}. It failed: ${error}.`,
    block: systemBlock(sentence, params.kind === "comment" ? { posted_text: c.text ?? params.text } : undefined),
  }, deps);
  return { card: need(db, id), ran: true };
}

/** A card left 'running' by a crashed process is marked failed: what it did on GitHub is unknown. */
export const RUNNING_STALE_MS = 10 * 60_000;
export function sweepRunningCards(db: DatabaseSync, deps?: StoreDeps): number {
  const cutoff = new Date((deps?.now?.() ?? new Date()).getTime() - RUNNING_STALE_MS).toISOString();
  return db.prepare("UPDATE conversation_cards SET state = 'failed', error = 'outcome unknown; see the GitHub activity page' WHERE state = 'running' AND acted_at < ?").run(cutoff).changes as number;
}
