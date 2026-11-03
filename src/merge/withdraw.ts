// A review made again at the same head commit replaces the one a "Merge this PR?" decision was asked from.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { mergeDecisionId, OPEN_GROUP_SQL, type QueueEntry } from "./queue.ts";

/** Answer value of a question the pipeline set aside; no operator wrote it, so no later step acts on it. */
export const WITHDRAWN = "withdrawn";

/**
 * Sets the head's merge decision aside, answered or not, by renaming it (and what hangs on its id) so it no longer
 * matches the PR: the question is asked again from the new review and an earlier "merge" answer does not count.
 * The old row stays for the record and is closed: an open one is answered "withdrawn" by the pipeline, an
 * answered one that was not acted on yet is marked applied with a note.
 */
export function withdrawMergeQuestion(db: DatabaseSync, repo: string, number: number, head: string, at: string, why = "superseded by a new review"): boolean {
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
      db.prepare("UPDATE decisions SET answer = ?, answered_by = 'pipeline', answered_at = ?, applied_at = ?, answer_note = ? WHERE id = ?").run(WITHDRAWN, at, at, why, old);
      audit(db, "pipeline", "merge-question-withdrawn", old, { repo, number, head });
    } else if (!row.applied_at) {
      db.prepare("UPDATE decisions SET applied_at = ?, answer_note = COALESCE(answer_note || ' — ', '') || ? WHERE id = ?").run(at, `${why}; the answer was not applied`, old);
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

/** Why a Merge? question is set aside while its PR is in an open duplicate group. */
export const IN_GROUP_NOTE = "set aside while the PR is in a duplicate group";

/**
 * Sets aside the open Merge? decision (or unapplied merge answer) of every PR that is a member of an open duplicate
 * group decision, so an item has one current decision. The PR that stays open is asked again after the group is answered.
 */
export function withdrawGroupedQuestions(db: DatabaseSync, at: string, repo?: string): number {
  const rows = db.prepare(`SELECT DISTINCT m.repo, m.number, m.id FROM decisions m
    JOIN dupe_group_items gi ON gi.repo = m.repo AND gi.number = m.number
    JOIN decisions g ON g.id = gi.decision_id AND gi.role <> 'stay'
    WHERE ${OPEN_GROUP_SQL} AND m.kind = 'merge' AND m.id NOT LIKE '%~replaced-%' AND (m.answer IS NULL OR (m.answer = 'merge' AND m.applied_at IS NULL))
    ${repo ? "AND m.repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { repo: string; number: number; id: string }[];
  let n = 0;
  for (const r of rows) {
    const head = r.id.slice(r.id.indexOf(":merge@") + ":merge@".length);
    if (mergeDecisionId(r.repo, r.number, head) === r.id && withdrawMergeQuestion(db, r.repo, r.number, head, at, IN_GROUP_NOTE)) n++;
  }
  return n;
}

/** Closes the PR's open Merge? questions at every head once it merged, whatever path merged it. */
export function closeMergedQuestions(db: DatabaseSync, repo: string, number: number, at: string): void {
  db.prepare("UPDATE decisions SET answer = ?, answered_by = 'pipeline', answered_at = ?, applied_at = ?, answer_note = 'the PR merged' WHERE kind = 'merge' AND repo = ? AND number = ? AND answer IS NULL")
    .run(WITHDRAWN, at, at, repo, number);
}

/** Sets aside the PR's unanswered Merge? questions at heads other than the one just asked about. */
export function withdrawOtherHeadQuestions(db: DatabaseSync, repo: string, number: number, keepHead: string, at: string): void {
  const prefix = `${repo}#${number}:merge@`;
  const rows = db.prepare("SELECT id FROM decisions WHERE repo = ? AND number = ? AND kind = 'merge' AND answer IS NULL AND substr(id, 1, ?) = ? AND id NOT LIKE '%~replaced-%'").all(repo, number, prefix.length, prefix) as { id: string }[];
  for (const r of rows) {
    const head = r.id.slice(prefix.length);
    if (head !== keepHead) withdrawMergeQuestion(db, repo, number, head, at, "superseded by a question at a newer head");
  }
}
