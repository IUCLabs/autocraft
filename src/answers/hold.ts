// One answer per question. While a conversation card settles a decision, the decision is locked ("settling"); once it is answered
// and before the pipeline applies it, another person can dispute it ("disputed") instead of answering again. Both states live in
// decisions.exec_state; the pipeline reads a disputed answer as no answer (see settlers.ts).
import type { DatabaseSync } from "node:sqlite";
import { BACKLOG, getDecision, optionsOf, type DecisionRow } from "../decisions.ts";
import { audit } from "../dash/audit.ts";

export const SETTLING = "settling";
export const DISPUTED = "disputed";

/** The login of the person whose card is settling an open decision, or null. */
export function settlingBy(d: Pick<DecisionRow, "answer" | "exec_state" | "exec_reason">): string | null {
  if (d.answer !== null || d.exec_state !== SETTLING) return null;
  const r = d.exec_reason ?? "";
  return r.slice(r.indexOf(":") + 1) || "someone";
}

export const settlingMessage = (by: string): string => `${by} is applying their answer`;

/** Claims the open decision for the card inside the transaction that starts the card's run. Throws when a card already holds it. A decision that is answered or missing is left alone: the run reports "the decision changed". */
export function claimSettling(db: DatabaseSync, decisionId: string, cardId: number, login: string): void {
  const r = db.prepare("UPDATE main.decisions SET exec_state = ?, exec_reason = ? WHERE id = ? AND answer IS NULL AND exec_state IS NULL").run(SETTLING, `${cardId}:${login}`, decisionId);
  if (r.changes === 1) return;
  const d = getDecision(db, decisionId);
  const by = d && settlingBy(d);
  if (by) throw new Error(settlingMessage(by));
}

/** Clears the lock of the card. The answer's own exec state replaces it when the card answered the decision. */
export function releaseSettling(db: DatabaseSync, decisionId: string, cardId: number): void {
  db.prepare("UPDATE main.decisions SET exec_state = NULL, exec_reason = NULL WHERE id = ? AND exec_state = ? AND exec_reason LIKE ?").run(decisionId, SETTLING, `${cardId}:%`);
}

/** Locks left by a card that no longer runs (a crashed process). */
export function sweepSettling(db: DatabaseSync): number {
  return Number(db.prepare(`UPDATE main.decisions SET exec_state = NULL, exec_reason = NULL WHERE exec_state = ? AND answer IS NULL
    AND NOT EXISTS (SELECT 1 FROM main.conversation_cards c WHERE c.state = 'running' AND decisions.exec_reason LIKE c.id || ':%')`).run(SETTLING).changes);
}

export const isDisputed = (d: Pick<DecisionRow, "exec_state" | "answer" | "applied_at">): boolean => d.exec_state === DISPUTED && d.answer !== null && !d.applied_at;

/** An answered decision the pipeline has not applied yet, on the item: someone chose, GitHub does not show it yet. Backlog only holds, so it does not count. */
export function pendingAnswerOn(db: DatabaseSync, repo: string, number: number): DecisionRow | null {
  return (db.prepare(`SELECT * FROM main.decisions WHERE repo = ? AND number = ? AND answer IS NOT NULL AND applied_at IS NULL AND answer <> ? AND id NOT LIKE '%~replaced-%'
    ORDER BY answered_at DESC LIMIT 1`).get(repo, number, BACKLOG.key) as DecisionRow | undefined) ?? null;
}

/** The reason a card that writes to the item must not run, or null. */
export function pendingAnswerRefusal(db: DatabaseSync, repo: string, number: number): string | null {
  const d = pendingAnswerOn(db, repo, number);
  if (!d) return null;
  const label = optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer;
  return isDisputed(d)
    ? `${d.answered_by}'s answer "${label}" is disputed by ${d.dispute_by}; it has to be kept or undone first`
    : `${d.answered_by} already answered "${d.question}" with "${label}"; dispute that answer to change it`;
}

/** True while any answer on the item is disputed: no pipeline write for the item goes ahead. */
export function disputeOn(db: DatabaseSync, repo: string, number: number): boolean {
  return !!db.prepare("SELECT 1 FROM main.decisions WHERE repo = ? AND number = ? AND exec_state = ? AND answer IS NOT NULL AND applied_at IS NULL LIMIT 1").get(repo, number, DISPUTED);
}

/** Records the dispute. False when the decision is no longer disputable (answered by the disputer, applied, running or already disputed). */
export function openDispute(db: DatabaseSync, id: string, by: string, reason: string, at: string): boolean {
  const r = db.prepare(`UPDATE main.decisions SET exec_state = ?, exec_reason = NULL, dispute_by = ?, dispute_reason = ?, dispute_at = ?
    WHERE id = ? AND answer IS NOT NULL AND applied_at IS NULL AND answer <> ? AND answered_by <> ? COLLATE NOCASE
      AND (exec_state IS NULL OR exec_state IN ('pending', 'waiting-token', 'waiting-permission', 'failed'))`).run(DISPUTED, by, reason, at, id, BACKLOG.key, by);
  if (r.changes !== 1) return false;
  audit(db, by, "dispute", id, { reason });
  return true;
}

export function clearDispute(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE main.decisions SET exec_state = NULL, exec_reason = NULL, dispute_by = NULL, dispute_reason = NULL, dispute_at = NULL WHERE id = ? AND exec_state = ?").run(id, DISPUTED);
}
