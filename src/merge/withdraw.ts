// A review made again at the same head commit replaces the one a "Merge this PR?" decision was asked from.
import type { DatabaseSync } from "node:sqlite";
import { mergeDecisionId } from "./queue.ts";

/**
 * Sets the head's merge decision aside, answered or not, by renaming it (and what hangs on its id) so it no longer
 * matches the PR: the question is asked again from the new review and an earlier "merge" answer does not count.
 * The old row stays for the record.
 */
export function withdrawMergeQuestion(db: DatabaseSync, repo: string, number: number, head: string, at: string): void {
  const id = mergeDecisionId(repo, number, head);
  if (!db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(id)) return;
  const old = `${id}~replaced-${at}`;
  for (const t of ["decisions", "decision_opinions", "decision_comments", "decision_claims"]) {
    db.prepare(`UPDATE ${t} SET ${t === "decisions" ? "id" : "decision_id"} = ? WHERE ${t === "decisions" ? "id" : "decision_id"} = ?`).run(old, id);
  }
}
