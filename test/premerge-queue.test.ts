// The pre-merge review gates the merge rule: what each stored result does to a PR's queue state and Merge? question.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setPushApproval } from "../src/fixup/approval.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { savePremerge, type PremergeFinding } from "../src/premerge/store.ts";
import { fresh as freshDb, T1 } from "./batch-fixture.ts";
import { seedPremergeClean } from "./helpers/premerge.ts";

const HEAD = "sha1";
const fix = { file: "a.rs", change: "check the bound" };
const defect = (extra: Partial<PremergeFinding> = {}): PremergeFinding => ({ severity: "defect", file: "a.rs", line: 7, title: "off by one", scenario: "an empty list panics", ...extra });

function world(): DatabaseSync {
  const db = freshDb([{ n: 1 }]);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  db.prepare("DELETE FROM premerge_reviews").run();
  return db;
}
const entry = (db: DatabaseSync) => buildQueue(db, { merged: "exclude" }).find((e) => e.number === 1)!;
const store = (db: DatabaseSync, findings: PremergeFinding[]) => savePremerge(db, { repo: "app", number: 1, head: HEAD, at: T1, findings });
const fail = (db: DatabaseSync, n: number) => { for (let k = 0; k < n; k++) savePremerge(db, { repo: "app", number: 1, head: HEAD, at: T1, error: "retry: the model timed out" }); };
const askedQuestion = (db: DatabaseSync) => {
  assert.deepEqual(askMergeDecisions(db, { at: T1 }), [mergeDecisionId("app", 1, HEAD)]);
  return JSON.parse((db.prepare("SELECT * FROM decisions WHERE id = ?").get(mergeDecisionId("app", 1, HEAD)) as { facts: string; recommended?: string | null }).facts) as string[];
};

test("a rule PR waits for the pre-merge review, and a clean one is ready", () => {
  const db = world();
  assert.equal(entry(db).state, "waiting-premerge");
  assert.equal(eligible(entry(db)), false);
  fail(db, 1);
  assert.equal(entry(db).state, "waiting-premerge");
  seedPremergeClean(db, "app", 1, HEAD);
  assert.equal(entry(db).state, "ready");
  store(db, [{ severity: "minor", file: "a.rs", line: 1, title: "naming", scenario: "unclear" }]);
  assert.equal(entry(db).state, "ready");
});

test("defects that all have fixes go to fix-up when it may push; otherwise a person decides", () => {
  const db = world();
  store(db, [defect({ fix })]);
  assert.equal(entry(db).state, "needs-decision");
  setPushApproval(db, "op", "app", true);
  const e = entry(db);
  assert.equal(e.state, "needs-fix-up");
  assert.equal(e.note, "pre-merge review: 1 defect to fix");
  db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, files, attempt, created_at, source) VALUES ('app', 1, ?, 'cannot-push', 'x', '[]', 1, ?, 'premerge')").run(HEAD, T1);
  assert.equal(entry(db).state, "needs-decision");
  assert.ok(entry(db).outsideRule.includes("the pre-merge review found a defect"));
});

test("a defect without a fix is asked about with its facts and no merge recommendation; a Merge answer then merges", () => {
  const db = world();
  setPushApproval(db, "op", "app", true);
  store(db, [defect(), defect({ fix, file: "b.rs", line: 3, title: "leak" })]);
  const e = entry(db);
  assert.equal(e.state, "needs-decision");
  assert.deepEqual(e.outsideRule, ["the pre-merge review found a defect"]);
  const facts = askedQuestion(db);
  assert.ok(facts.includes("pre-merge defect: a.rs:7 off by one: an empty list panics"));
  assert.ok(facts.some((f) => f.startsWith("pre-merge defect: b.rs:3 leak")));
  assert.ok(facts.length <= 5);
  const q = db.prepare("SELECT * FROM decisions WHERE id = ?").get(mergeDecisionId("app", 1, HEAD)) as Record<string, unknown>;
  assert.equal(q.recommended, null, "no merge recommendation");
  db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = '2099-01-01T00:00:00Z' WHERE id = ?").run(mergeDecisionId("app", 1, HEAD));
  assert.equal(entry(db).state, "ready");
  assert.equal(entry(db).path, "rule");
});

test("three failed tries make the head failed and ask a person", () => {
  const db = world();
  fail(db, 2);
  assert.equal(entry(db).state, "waiting-premerge");
  fail(db, 1);
  assert.equal(entry(db).state, "needs-decision");
  assert.deepEqual(entry(db).outsideRule, ["the pre-merge review failed"]);
  assert.ok(askedQuestion(db).includes("pre-merge review failed: retry: the model timed out"));
});
