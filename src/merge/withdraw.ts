// A review made again at the same head commit replaces the one a "Merge this PR?" decision was asked from.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { mergeDecisionId } from "./queue.ts";

/** Answer value of a question the pipeline set aside; no operator wrote it, so no later step acts on it. */
export const WITHDRAWN = "withdrawn";

/**
 * Sets the head's merge decision aside, answered or not, by renaming it (and what hangs on its id) so it no longer
 * matches the PR: the question is asked again from the new review and an earlier "merge" answer does not count.
 * The old row stays for the record and is closed: an open one is answered "withdrawn" by the pipeline, an
 * answered one that was not acted on yet is marked applied with a note.
 */
export function withdrawMergeQuestion(db: DatabaseSync, repo: string, number: number, head: string, at: string): void {
  const id = mergeDecisionId(repo, number, head);
  const row = db.prepare("SELECT answer, applied_at FROM decisions WHERE id = ?").get(id) as { answer: string | null; applied_at: string | null } | undefined;
  if (!row) return;
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
      db.prepare("UPDATE decisions SET applied_at = ?, answer_note = ? WHERE id = ?").run(at, "superseded by a new review; the answer was not applied", old);
      audit(db, "pipeline", "merge-answer-superseded", old, { repo, number, head, answer: row.answer });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
