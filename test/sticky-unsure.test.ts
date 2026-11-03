// An unsure Opus review keeps its head needing a person's Merge? answer; the pipeline's own pushes carry it to the next head.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { askMergeDecisions } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { closeMergedQuestions } from "../src/merge/withdraw.ts";
import { saveOpus } from "../src/review/opus.ts";
import { fresh, T1 } from "./batch-fixture.ts";

const review = (sure: boolean, verdict: "take" | "take-fix" = "take") => ({ ref: "x", verdict, sure, reason: sure ? "sure" : "unsure", fixes: [], risks: ["r"], summary: null, why: null, public: null });
const save = (db: DatabaseSync, head: string, sure: boolean) => saveOpus(db, null, { repo: "app", number: 1, head_oid: head }, { mode: "full", base: null, model: "m", review: review(sure) });
const entry = (db: DatabaseSync) => buildQueue(db, { merged: "exclude" }).find((e) => e.number === 1)!;
const answer = (db: DatabaseSync, head: string) => db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = ? WHERE id = ?").run(T1, mergeDecisionId("app", 1, head));
const answerOf = (db: DatabaseSync, head: string) => (db.prepare("SELECT answer FROM decisions WHERE id = ?").get(mergeDecisionId("app", 1, head)) as { answer: string | null } | undefined)?.answer;

/** PR #1 moves to a new head with the same checks and verification. */
function moveTo(db: DatabaseSync, head: string): void {
  db.prepare("UPDATE items SET head_oid = ? WHERE number = 1").run(head);
  db.prepare("UPDATE pr_checks SET head_oid = ? WHERE number = 1").run(head);
  db.prepare("UPDATE verifications SET head_sha = ? WHERE number = 1").run(head);
}

function unsureAsked(): DatabaseSync {
  const db = fresh([{ n: 1 }]);
  db.prepare("DELETE FROM opus_reviews").run();
  save(db, "sha1", false);
  assert.deepEqual(askMergeDecisions(db, { at: T1 }), [mergeDecisionId("app", 1, "sha1")]);
  return db;
}

test("a sure re-review at the same head keeps the Merge? question open and the PR needs a person's answer", () => {
  const db = unsureAsked();
  save(db, "sha1", true);
  assert.equal(answerOf(db, "sha1"), null);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), []);
  assert.ok(entry(db).outsideRule.includes("Opus was unsure"));
  assert.equal(eligible(entry(db)), false);
  const hist = db.prepare("SELECT sure FROM opus_review_history WHERE head_oid = 'sha1' ORDER BY rowid").all() as { sure: number }[];
  assert.deepEqual(hist.map((h) => h.sure), [0, 1]);
  answer(db, "sha1");
  assert.equal(eligible(entry(db)), true);
});

test("a head the author pushed starts fresh", () => {
  const db = fresh([{ n: 1 }]);
  db.prepare("DELETE FROM opus_reviews").run();
  save(db, "sha1", false);
  moveTo(db, "sha1b");
  save(db, "sha1b", true);
  assert.equal(entry(db).state, "ready");
  assert.equal(eligible(entry(db)), true);
});

test("an open question at an earlier head blocks the rule until a question at the new head replaces it", () => {
  const db = unsureAsked();
  moveTo(db, "sha1b");
  save(db, "sha1b", true);
  assert.equal(eligible(entry(db)), false);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), [mergeDecisionId("app", 1, "sha1b")]);
  assert.equal(answerOf(db, "sha1"), undefined);
  const old = db.prepare("SELECT answer FROM decisions WHERE id LIKE '%~replaced-%'").get() as { answer: string };
  assert.equal(old.answer, "withdrawn");
});

const pushedMerge = (db: DatabaseSync) => {
  db.prepare("INSERT INTO conflict_merges (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'sha1', 'sha1m', 'merged', 1, ?)").run(T1);
  moveTo(db, "sha1m");
  save(db, "sha1m", true);
};

test("unsure carries over a head AutoCraft pushed itself and is asked again there", () => {
  const db = unsureAsked();
  pushedMerge(db);
  askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" });
  assert.ok(entry(db).outsideRule.includes("Opus was unsure"));
  assert.equal(eligible(entry(db)), false);
  assert.equal(entry(db).decisionId, mergeDecisionId("app", 1, "sha1m"));
});

test("a person's answer at the earlier head clears unsure for the pushed head", () => {
  const db = unsureAsked();
  answer(db, "sha1");
  pushedMerge(db);
  assert.equal(entry(db).outsideRule.includes("Opus was unsure"), false);
  assert.equal(eligible(entry(db)), true);
});

test("a skipped review is never eligible by rule", () => {
  const db = fresh([{ n: 1 }]);
  assert.equal(entry(db).state, "ready");
  db.prepare("UPDATE opus_reviews SET mode = 'skipped'").run();
  assert.equal(eligible(entry(db)), false);
});

test("a merged PR's open Merge? questions are closed", () => {
  const db = unsureAsked();
  closeMergedQuestions(db, "app", 1, T1);
  assert.equal(answerOf(db, "sha1"), "withdrawn");
});
