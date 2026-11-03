// An unsure Opus review keeps its head needing a person's Merge? answer; the pipeline's own pushes carry it to the next head.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { askMergeDecisions, runMerge, type MergeDeps } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { closeMergedQuestions } from "../src/merge/withdraw.ts";
import { saveOpus } from "../src/review/opus.ts";
import { fresh as freshDb, T1 } from "./batch-fixture.ts";

function fresh(prs: { n: number }[]): DatabaseSync {
  const db = freshDb(prs);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  return db;
}

const review = (sure: boolean, verdict: "take" | "take-fix" = "take") => ({ ref: "x", verdict, sure, reason: sure ? "sure" : "unsure", fixes: [], risks: ["r"], summary: null, why: null, public: null });
const save = (db: DatabaseSync, head: string, sure: boolean) => saveOpus(db, null, { repo: "app", number: 1, head_oid: head }, { mode: "full", base: null, model: "m", review: review(sure) });
const entry = (db: DatabaseSync) => buildQueue(db, { merged: "exclude" }).find((e) => e.number === 1)!;
// Answers come after the review they answer (reviews are stamped with the current time).
const LATER = "2099-01-01T00:00:00Z";
const answer = (db: DatabaseSync, head: string, at = LATER) => db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = ? WHERE id = ?").run(at, mergeDecisionId("app", 1, head));
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

test("an answer at an earlier head does not clear unsure at the pushed head", () => {
  const db = unsureAsked();
  answer(db, "sha1");
  pushedMerge(db);
  assert.ok(entry(db).outsideRule.includes("Opus was unsure"));
  assert.equal(eligible(entry(db)), false);
});

test("carry-over pushes are part of the chain", () => {
  const db = unsureAsked();
  db.prepare("INSERT INTO dupe_carries (decision_id, repo, number, state, to_head, from_head, updated_at) VALUES ('g', 'app', 1, 'done', 'sha1c', 'sha1', ?)").run(T1);
  moveTo(db, "sha1c");
  save(db, "sha1c", true);
  askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" });
  assert.ok(entry(db).outsideRule.includes("Opus was unsure"));
  assert.equal(eligible(entry(db)), false);
  answer(db, "sha1c");
  assert.equal(eligible(entry(db)), true);
});

test("an unsure review stored before the history existed is kept by a re-review", () => {
  const db = fresh([{ n: 1 }]);
  db.prepare("DELETE FROM opus_reviews").run();
  db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, sure, mode) VALUES ('app', 1, 'sha1', 'rv', ?, 'm', 'take', 'old', 0, 'full')").run(T1);
  save(db, "sha1", true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM opus_review_history WHERE sure = 0").get() as { n: number }).n, 1);
  assert.equal(eligible(entry(db)), false);
});

test("an answer given before the latest review does not count; an open question at the current head blocks the rule", () => {
  const db = unsureAsked();
  answer(db, "sha1", "2020-01-01T00:00:00Z");
  assert.equal(eligible(entry(db)), false);
  const open = fresh([{ n: 1 }]);
  askMergeDecisions(open, { at: T1 });
  open.prepare("UPDATE decisions SET answer = NULL");
  assert.equal(eligible(entry(open)), true);
  open.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES (?, 'merge', 'app', 1, 'q', '[]', ?)").run(mergeDecisionId("app", 1, "sha1"), T1);
  assert.equal(eligible(entry(open)), false);
});

test("an answered merge is withdrawn by a re-review at the same head", () => {
  const db = unsureAsked();
  answer(db, "sha1");
  save(db, "sha1", true);
  assert.equal(answerOf(db, "sha1"), undefined);
  assert.equal(eligible(entry(db)), false);
  assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), [mergeDecisionId("app", 1, "sha1")]);
});

test("the merge run's own asking sets aside questions at other heads", async () => {
  const db = unsureAsked();
  moveTo(db, "sha1b");
  save(db, "sha1b", true);
  const deps: MergeDeps = { querier: { spent: 0, remaining: 1, query: async () => { throw new Error("no GitHub"); } }, run: async () => { throw new Error("no merge"); }, now: () => new Date(T1), mergeCommand: "none" };
  const s = await runMerge(db, { repo: "app", dryRun: false, limit: 0 }, () => {}, deps);
  assert.deepEqual(s.asked, [mergeDecisionId("app", 1, "sha1b")]);
  assert.equal(answerOf(db, "sha1"), undefined);
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
