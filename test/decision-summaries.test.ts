// Summaries on Duplicate?, Merge? and Close? decisions. Fake model calls, no GitHub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { askCloseDecisions, closeDecisionId } from "../src/act/index.ts";
import { connect } from "../src/db.ts";
import { ask, factsOf, getDecision } from "../src/decisions.ts";
import { HEAD_FACT, MERGE_OPTIONS } from "../src/merge/queue.ts";
import { fillReviewSummaries } from "../src/review/summary.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "decision-summaries-test-"));
const T0 = "2026-01-01T00:00:00Z";

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, head_oid, embed_hash, created_at, updated_at)
    VALUES ('app', ?, ?, 'OPEN', ?, 'body', 'someone', ?, ?, '${T0}', '${T0}')`);
  item.run(1, "issue", "Crash on TIFF", null, "h1");
  item.run(2, "issue", "TIFF files quit the app", null, "h2");
  item.run(3, "pr", "PR 3", "sha3", "h3");
  item.run(4, "pr", "PR 4", "sha4", "h4");
  db.prepare(`INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at)
    VALUES ('app', 1, 2, 'h1', 'h2', 0.93, 0.95, 'duplicate', 1, ?, ?)`).run(T0, T0);
  return db;
}

describe("merge and close summaries", () => {
  const SUMMARY = "This PR drops the legacy export path. The review says close. The main risk is that saved files stop opening.";
  const review = (db: DatabaseSync) => db.prepare(`INSERT OR REPLACE INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, risks, sure, mode, summary, why) VALUES ('app', ?, ?, 'rv', '${T0}', ?, ?, ?, ?, 1, 'full', ?, ?)`);

  test("Close? text is the review's summary, whole, and the recommendation carries the review's one-sentence reason", () => {
    const db = fresh();
    review(db).run(3, "sha3", "opus", "close", "Not wanted in core", '["breaks saves"]', SUMMARY, "It removes a path users rely on.");
    askCloseDecisions(db, "app", T0);
    const c = getDecision(db, closeDecisionId("app", 3, "sha3"))!;
    assert.deepEqual([c.summary, c.summary_by, c.recommended, c.recommended_reason], [SUMMARY, "opus", "close", "It removes a path users rely on."]);
    assert.ok(!c.summary!.includes("Risks:"));
  });

  test("a review stored without a summary gives its reason whole and no model name; a long reason gives no recommendation", () => {
    const db = fresh();
    const long = `${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}. And a second sentence.`;
    review(db).run(3, "sha3", "opus", "close", long, null, null, null);
    review(db).run(4, "sha4", "opus", "close", "Not wanted in core.", null, null, null);
    askCloseDecisions(db, "app", T0);
    const a = getDecision(db, closeDecisionId("app", 3, "sha3"))!, b = getDecision(db, closeDecisionId("app", 4, "sha4"))!;
    assert.deepEqual([a.summary, a.summary_by, a.recommended, a.recommended_reason], [long, null, null, null]);
    assert.deepEqual([b.summary, b.summary_by, b.recommended, b.recommended_reason], ["Not wanted in core.", null, "close", "Not wanted in core."]);
  });

  test("an open Merge? is refreshed from the review at its head: stale text is replaced, a recommendation needs a reason, a second run changes nothing", () => {
    const db = fresh();
    const q = { id: "app#4:merge@sha4", kind: "merge", repo: "app", number: 4, question: "Merge this PR?", facts: ["review: take: stale", `${HEAD_FACT}sha4`],
      options: Object.values(MERGE_OPTIONS).map((o) => ({ ...o })), recommended: "merge", summary: "Sonnet's review says take: stale.", summary_by: "sonnet", asked_at: T0 };
    ask(db, [q]);
    review(db).run(4, "old", "opus", "take", "stale", null, "Other head.", "Other head.");
    assert.equal(fillReviewSummaries(db, T0), 0, "a review at another head is not used");
    review(db).run(4, "sha4", "opus", "take", "Small and tested", null, "A small, tested fix. The review says take.", "It is small and tested.");
    assert.equal(fillReviewSummaries(db, T0), 1);
    const m = getDecision(db, q.id)!;
    assert.deepEqual([m.summary, m.summary_by, m.recommended, m.recommended_reason], ["A small, tested fix. The review says take.", "opus", "merge", "It is small and tested."]);
    assert.ok(factsOf(m).includes("review: take: Small and tested") && factsOf(m).includes(`${HEAD_FACT}sha4`));
    assert.equal(fillReviewSummaries(db, T0), 0);
    // A reason that appears later at the same head adds the recommendation to a Close? that had none.
    review(db).run(3, "sha3", "opus", "close", `${Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")}.`, null, null, null);
    askCloseDecisions(db, "app", T0);
    const cid = closeDecisionId("app", 3, "sha3");
    assert.equal(getDecision(db, cid)!.recommended, null);
    review(db).run(3, "sha3", "opus", "close", "Not wanted.", null, "Sum.", "Not wanted in core.");
    assert.equal(fillReviewSummaries(db, T0), 1);
    assert.deepEqual([getDecision(db, cid)!.recommended, getDecision(db, cid)!.recommended_reason], ["close", "Not wanted in core."]);
    assert.equal(fillReviewSummaries(db, T0), 0);
    // A new review at the same head with no usable reason leaves the Merge? without a recommendation.
    review(db).run(4, "sha4", "opus", "take", `${Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")}.`, null, null, null);
    assert.equal(fillReviewSummaries(db, T0), 1);
    const n = getDecision(db, q.id)!;
    assert.deepEqual([n.summary_by, n.recommended, n.recommended_reason], [null, null, null]);
    assert.equal(fillReviewSummaries(db, T0), 0);
  });
});
