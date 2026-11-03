// Summaries on Duplicate?, Merge? and Close? decisions. Fake model calls, no GitHub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { askCloseDecisions, closeDecisionId } from "../src/act/index.ts";
import { connect } from "../src/db.ts";
import { ask, getDecision } from "../src/decisions.ts";
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
  test("Close? takes the Opus review text at its head; Merge? is filled from the stored reviews on a later run", () => {
    const db = fresh();
    const review = db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, risks, sure, mode) VALUES ('app', ?, ?, 'rv', '${T0}', ?, ?, ?, ?, 1, 'full')`);
    review.run(3, "sha3", "opus", "close", "Not wanted in core", '["breaks saves"]');
    askCloseDecisions(db, "app", T0);
    const c = getDecision(db, closeDecisionId("app", 3, "sha3"))!;
    assert.deepEqual(c.summary_by, "opus");
    assert.equal(c.summary, "Opus's review says close: Not wanted in core. Risks: breaks saves.");

    // A Merge? decision asked before summaries existed, at head sha4; a review at another head is not used.
    review.run(4, "old", "opus", "take", "stale", null);
    ask(db, [{ id: "app#4:merge@sha4", kind: "merge", repo: "app", number: 4, question: "Merge this PR?", facts: [`${HEAD_FACT}sha4`], options: Object.values(MERGE_OPTIONS).map((o) => ({ ...o })), asked_at: T0 }]);
    assert.equal(fillReviewSummaries(db, T0), 0);
    review.run(4, "sha4", "opus", "take", "Small and tested", null);
    assert.equal(fillReviewSummaries(db, T0), 1);
    const m = getDecision(db, "app#4:merge@sha4")!;
    assert.deepEqual([m.summary, m.summary_by], ["Opus's review says take: Small and tested.", "opus"]);
    db.prepare("UPDATE opus_reviews SET sure = 0 WHERE head_oid = 'sha4'").run();
    db.prepare("UPDATE decisions SET summary = NULL WHERE id = 'app#4:merge@sha4'").run();
    assert.equal(fillReviewSummaries(db, T0), 1);
    assert.match(getDecision(db, "app#4:merge@sha4")!.summary!, /not sure.*unsure, so a person decides/);
    assert.equal(fillReviewSummaries(db, T0), 0);
  });
});
