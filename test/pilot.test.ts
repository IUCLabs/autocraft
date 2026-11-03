// The pilot limits every stage's candidates to the listed items and to the Fix PRs of listed issues.
// Stages that share notHeldSql (decide, referee, review, opus, verify, fix-up, fix) are covered by that
// fragment; the others are checked through their own candidate functions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { connect } = await import("../src/db.ts");
const { inPilot, pilotItems, PilotError, setPilot } = await import("../src/pilot.ts");
const { notHeldSql } = await import("../src/dupes/held.ts");
const { dueItems } = await import("../src/runner/classify.ts");
const { dueItems: priorityDue, duePriorityCount } = await import("../src/priority/index.ts");
const { planLabels } = await import("../src/labels/plan.ts");
const { scanPending } = await import("../src/dupes/scan.ts");
const { uncheckedPairs } = await import("../src/dupes/check.ts");
const { fixDue } = await import("../src/fixissue/index.ts");
const { setFixIssueApproval } = await import("../src/fixissue/approval.ts");

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pilot-test-"));
const db = connect(join(dir, "p.db"));
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = "2026-11-01T00:00:00Z";
db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name) VALUES ('app')");
const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, url, embed_hash, created_at, updated_at) VALUES ('app', ?, ?, 'OPEN', 't', 'b', 'someone', ?, 'h', ?, ?)");
for (const n of [1, 2, 3, 4]) ins.run(n, "issue", `https://github.com/storytold/app/issues/${n}`, T, T);
for (const n of [10, 11, 12]) ins.run(n, "pr", `https://github.com/storytold/app/pull/${n}`, T, T);
// PR 11 is the Fix PR of issue 1; PR 111 only shares its digits.
ins.run(111, "pr", "https://github.com/storytold/app/pull/111", T, T);
db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 1, 'm', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/11', ?, ?)").run(T, T);
db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, created_at, updated_at) VALUES ('app', 2, 'm', 'h', 'testing', ?, ?)").run(T, T);
for (const n of [1, 2, 3, 4]) db.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES ('app', ?, 'm', 'h', x'00', ?)").run(n, T);
const pair = db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at) VALUES ('app', ?, ?, 'h', 'h', 0.9, ?)");
pair.run(1, 2, T);
pair.run(3, 4, T);

const numbers = (rows: { number: number }[]) => rows.map((r) => r.number).sort((a, b) => a - b);
const held = () => numbers(db.prepare(`SELECT number FROM items i WHERE ${notHeldSql("i")}`).all() as { number: number }[]);

test("without a pilot every lane sees every item", () => {
  assert.deepEqual(held(), [1, 2, 3, 4, 10, 11, 12, 111]);
  assert.equal(uncheckedPairs(db, 10).length, 2);
  assert.equal(inPilot(db, "app", 3), true);
});

test("with a pilot, candidates are the listed items and the Fix PRs of listed issues", () => {
  setPilot(db, "tester", ["app#1", "app#10"]);
  assert.deepEqual(pilotItems(db), ["app#1", "app#10"]);
  const want = [1, 10, 11];
  assert.deepEqual(held(), want, "decide, referee, review, opus, verify, fix-up, fix (notHeldSql)");
  assert.deepEqual(numbers(dueItems(db, "run", "new").due), want, "classify");
  assert.deepEqual(numbers(priorityDue(db, 100)), want, "prioritize");
  assert.equal(duePriorityCount(db), want.length, "prioritize count");
  assert.deepEqual(numbers(planLabels(db, "app")), want, "labels");
  assert.deepEqual(numbers(scanPending(db, "m")), [1], "dupes subjects");
  assert.deepEqual(uncheckedPairs(db, 10).map((p) => p.a), [1], "dupes pairs with a pilot subject");
  assert.equal(inPilot(db, "app", 11), true);
  assert.equal(inPilot(db, "app", 111), false);
  assert.equal(inPilot(db, "app", 12), false);
});

test("a fix retry is due only for a pilot issue", () => {
  setFixIssueApproval(db, "tester", "app", true);
  db.prepare("UPDATE fix_attempts SET state = 'retry' WHERE number = 2").run();
  setPilot(db, "tester", ["app#1"]);
  assert.equal(fixDue(db, "app"), false);
  setPilot(db, "tester", ["app#2"]);
  assert.equal(fixDue(db, "app"), true);
  setPilot(db, "tester", []);
});

test("a pilot is validated and clearing it lifts the limit", () => {
  assert.throws(() => setPilot(db, "tester", ["app-1"]), PilotError);
  assert.throws(() => setPilot(db, "tester", ["other#1"]), PilotError);
  setPilot(db, "tester", []);
  assert.deepEqual(pilotItems(db), []);
  assert.deepEqual(held(), [1, 2, 3, 4, 10, 11, 12, 111]);
  const audited = db.prepare("SELECT action FROM audit WHERE action LIKE 'pilot-%' ORDER BY rowid").all() as { action: string }[];
  assert.deepEqual(audited.map((a) => a.action), ["pilot-set", "pilot-set", "pilot-set", "pilot-clear", "pilot-clear"]);
});
