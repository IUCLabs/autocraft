// A review made again at the same head commit replaces the one a "Merge this PR?" decision was asked from.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { mergeDecisionId, type QueueEntry } from "./queue.ts";

/** Answer value of a question the pipeline set aside; no operator wrote it, so no later step acts on it. */
export const WITHDRAWN = "withdrawn";

/**
 * Sets the head's merge decision aside, answered or not, by renaming it (and what hangs on its id) so it no longer
 * matches the PR: the question is asked again from the new review and an earlier "merge" answer does not count.
 * The old row stays for the record and is closed: an open one is answered "withdrawn" by the pipeline, an
 * answered one that was not acted on yet is marked applied with a note.
 */
export function withdrawMergeQuestion(db: DatabaseSync, repo: string, number: number, head: string, at: string): boolean {
  const id = mergeDecisionId(repo, number, head);
  const row = db.prepare("SELECT answer, applied_at FROM decisions WHERE id = ?").get(id) as { answer: string | null; applied_at: string | null } | undefined;
  // An answer other than merge (close, hold) waiting for Act still stands: the new review doesn't change it.
  if (!row || (row.answer !== null && row.answer !== "merge" && !row.applied_at)) return false;
  const old = `${id}~replaced-${at}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of ["decisions", "decision_opinions", "decision_comments", "decision_claims"]) {
      db.prepare(`UPDATE ${t} SET ${t === "decisions" ? "id" : "decision_id"} = ? WHERE ${t === "decisions" ? "id" : "decision_id"} = ?`).run(old, id);
    }
    if (row.answer === null) {
      db.prepare("UPDATE decisions SET answer = ?, answered_by = 'pipeline', answered_at = ?, applied_at = ?, answer_note = 'superseded by a new review' WHERE id = ?").run(WITHDRAWN, at, at, old);
      audit(db, "pipeline", "merge-question-withdrawn", old, { repo, number, head });
    } else if (!row.applied_at) {
      db.prepare("UPDATE decisions SET applied_at = ?, answer_note = COALESCE(answer_note || ' — ', '') || ? WHERE id = ?").run(at, "superseded by a new review; the answer was not applied", old);
      audit(db, "pipeline", "merge-answer-superseded", old, { repo, number, head, answer: row.answer });
    }
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Sets aside the Merge? decisions of PRs a maintainer's "changes requested" review blocks; they are asked again if the
 * block clears. Only an open question or an unapplied merge answer is touched: a hold or close answer stands.
 */
export function withdrawBlockedQuestions(db: DatabaseSync, queue: QueueEntry[], at: string): number {
  let n = 0;
  for (const e of queue) {
    // A block seen only in the mirror may be wrong (the association is relative to the viewer): wait for a live read.
    if (e.state !== "changes-requested" || !e.blockedLive || !e.decisionId) continue;
    const row = db.prepare("SELECT answer, applied_at FROM decisions WHERE id = ?").get(e.decisionId) as { answer: string | null; applied_at: string | null } | undefined;
    if (!row || (row.answer !== null && (row.answer !== "merge" || row.applied_at))) continue;
    if (withdrawMergeQuestion(db, e.repo, e.number, e.head, at)) n++;
  }
  return n;
}
