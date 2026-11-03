// One decision per item: a PR in an open duplicate group has its Merge? question set aside, and the kept PR is asked again after the group is answered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, getDecision } from "../src/decisions.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { mergeDecisionId } from "../src/merge/queue.ts";
import { fresh, T0 } from "./batch-fixture.ts";

const GROUP = "app:dupegroup:1";

test("a Merge? is set aside while its PR is in an open duplicate group and asked again for the kept PR", () => {
  const db = fresh([{ n: 1, author: "newcomer" }, { n: 2, author: "newcomer" }]);
  assert.deepEqual(askMergeDecisions(db, { at: T0 }).sort(), [mergeDecisionId("app", 1, "sha1"), mergeDecisionId("app", 2, "sha2")]);

  ask(db, [{ id: GROUP, kind: "duplicate", repo: "app", number: 1, question: "Keep #1 and close #2?", options: [{ key: "accept", label: "Yes" }, { key: "distinct", label: "No" }], asked_at: "2026-01-02T00:00:00Z" }]);
  db.prepare("INSERT INTO dupe_groups (decision_id, repo, source) VALUES (?, 'app', 'model')").run(GROUP);
  for (const [n, role, target] of [[1, "keep", null], [2, "close", 1]] as const)
    db.prepare("INSERT INTO dupe_group_items (decision_id, repo, number, kind, role, target, base_role, base_target) VALUES (?, 'app', ?, 'pr', ?, ?, ?, ?)").run(GROUP, n, role, target, role, target);

  // The group is open: both Merge? questions are set aside and not asked again.
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), []);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T01:00:00Z" }), []);
  const merge = db.prepare("SELECT id, answer, answered_by, applied_at, answer_note FROM decisions WHERE kind = 'merge'").all() as { id: string; answer: string; answered_by: string; applied_at: string | null; answer_note: string }[];
  assert.equal(merge.length, 2);
  for (const m of merge) {
    assert.deepEqual([m.answer, m.answered_by, m.applied_at !== null], ["withdrawn", "pipeline", true]);
    assert.match(m.answer_note, /duplicate group/);
  }

  // Keep #1, close #2: only #1 gets a Merge? again.
  db.prepare("UPDATE decisions SET answer = 'accept', answered_by = 'op', answered_at = ? WHERE id = ?").run("2026-01-04T00:00:00Z", GROUP);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-05T00:00:00Z" }), [mergeDecisionId("app", 1, "sha1")]);
  assert.equal(getDecision(db, mergeDecisionId("app", 1, "sha1"))!.answer, null);
});

test("until \"keep #N instead\" is applied to the roles, the group stays open; a stay member keeps its Merge?", () => {
  const db = fresh([{ n: 1, author: "newcomer" }, { n: 2, author: "newcomer" }, { n: 3, author: "newcomer" }]);
  askMergeDecisions(db, { at: T0 });
  ask(db, [{ id: GROUP, kind: "duplicate", repo: "app", number: 1, question: "Keep #1 and close #2?", options: [{ key: "accept", label: "Yes" }, { key: "distinct", label: "No" }], asked_at: "2026-01-02T00:00:00Z" }]);
  db.prepare("INSERT INTO dupe_groups (decision_id, repo, source) VALUES (?, 'app', 'model')").run(GROUP);
  for (const [n, role, target] of [[1, "keep", null], [2, "close", 1], [3, "stay", null]] as const)
    db.prepare("INSERT INTO dupe_group_items (decision_id, repo, number, kind, role, target, base_role, base_target) VALUES (?, 'app', ?, 'pr', ?, ?, ?, ?)").run(GROUP, n, role, target, role, target);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), []);
  assert.equal(getDecision(db, mergeDecisionId("app", 3, "sha3"))!.answer, null);
  // Answered keep #2, roles not rewritten yet: #1 (still keep in the roles) is not asked.
  db.prepare("UPDATE decisions SET answer = 'keep:2', answered_by = 'op', answered_at = ? WHERE id = ?").run("2026-01-04T00:00:00Z", GROUP);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-05T00:00:00Z" }), []);
  // Applied: #2 is kept, #1 closes.
  db.prepare("UPDATE dupe_group_items SET role = 'close', target = 2 WHERE decision_id = ? AND number = 1").run(GROUP);
  db.prepare("UPDATE dupe_group_items SET role = 'keep', target = NULL WHERE decision_id = ? AND number = 2").run(GROUP);
  db.prepare("UPDATE dupe_groups SET applied_answer = 'keep:2' WHERE decision_id = ?").run(GROUP);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-06T00:00:00Z" }), [mergeDecisionId("app", 2, "sha2")]);
});
