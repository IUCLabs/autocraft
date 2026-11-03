// The pilot limits every stage's candidates to the listed items and to the Fix PRs of listed issues.
// Stages that share notHeldSql (decide, referee, review, opus, verify, fix-up, fix) are covered by that
// fragment; the others are checked through their own candidate functions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";

const { connect } = await import("../src/db.ts");
const { inPilot, pilotItems, PilotError, setPilot, setRepoPipeline } = await import("../src/pilot.ts");
const { notHeldSql } = await import("../src/dupes/held.ts");
const { dueItems } = await import("../src/runner/classify.ts");
const { dueItems: priorityDue, duePriorityCount } = await import("../src/priority/index.ts");
const { planLabels } = await import("../src/labels/plan.ts");
const { scanPending } = await import("../src/dupes/scan.ts");
const { uncheckedPairs } = await import("../src/dupes/check.ts");
const { buildQueue, eligible } = await import("../src/merge/queue.ts");
const { closeCandidates, pending: actPending } = await import("../src/act/index.ts");
const { selectIssues } = await import("../src/fixissue/index.ts");
const { selectFixups } = await import("../src/fixup/candidates.ts");
const { setCommentApproval } = await import("../src/act/approval.ts");
const { setPushApproval } = await import("../src/fixup/approval.ts");
const { fixDue } = await import("../src/fixissue/index.ts");
const { setFixIssueApproval } = await import("../src/fixissue/approval.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pilot-test-"));
const db = connect(join(dir, "p.db"));
after(() => {
  db.close();
  W.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = "2026-11-01T00:00:00Z";
db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
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

test("a repo with the pipeline off has no item in scope, with or without a pilot", () => {
  assert.ok(setRepoPipeline(db, "tester", "app", false));
  assert.deepEqual(held(), []);
  assert.equal(inPilot(db, "app", 12), false);
  assert.equal(duePriorityCount(db), 0);
  setPilot(db, "tester", ["app#1"]);
  assert.deepEqual(held(), []);
  setPilot(db, "tester", []);
  assert.equal(setRepoPipeline(db, "tester", "app", false), false, "no change, no audit");
  setRepoPipeline(db, "tester", "app", true);
  assert.deepEqual(held(), [1, 2, 3, 4, 10, 11, 12, 111]);
  assert.equal(inPilot(db, "other", 1), false);
  assert.throws(() => setRepoPipeline(db, "tester", "other", true), PilotError);
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
  assert.throws(() => setPilot(db, "tester", ["app"]), /Repos page/, "a whole repo is switched with the Pipeline toggle");
  setPilot(db, "tester", []);
  assert.deepEqual(pilotItems(db), []);
  assert.deepEqual(held(), [1, 2, 3, 4, 10, 11, 12, 111]);
  const audited = db.prepare("SELECT action FROM audit WHERE action LIKE 'pilot-%' ORDER BY rowid").all() as { action: string }[];
  assert.ok(audited.some((a) => a.action === "pilot-set") && audited.some((a) => a.action === "pilot-clear"));
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'repo-pipeline' AND target = 'app'").get());
});

// ---- the stages that write to GitHub ----------------------------------------------

const W = connect(join(dir, "w.db"));
const T1 = "2026-01-02T00:00:00Z";
W.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')").run();
W.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T1);
W.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
W.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T1);
{
  const item = W.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, additions, deletions, head_oid, url, created_at, updated_at)
    VALUES ('app', ?, ?, 'OPEN', ?, 'b', 'regular', 20, 0, ?, ?, ?, ?)`);
  const jev = W.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', ?, 'bugfix', '[]', '{"top":0.97}')`);
  const review = W.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', ?, ?, 'rv', ?, 'm', ?, 'r', ?, 1, 'full')`);
  const checks = W.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', ?, ?)`);
  const pr = (n: number, verdict: string, canModify = 1) => {
    item.run(n, "pr", `PR ${n}`, `sha${n}`, `https://github.com/storytold/app/pull/${n}`, T1, T1);
    jev.run(n, T1);
    review.run(n, `sha${n}`, T1, verdict, verdict === "take-fix" ? '[{"file":"a.rs","change":"x"}]' : null);
    checks.run(n, `sha${n}`, canModify, T1);
    if (verdict === "take") W.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, note, created_at) VALUES ('app', ?, ?, 'tests', 'r', 'passed', 'also passes on base', ?)`).run(n, `sha${n}`, T1);
  };
  pr(21, "take"); pr(22, "take");
  pr(23, "take"); // the Fix PR of issue 30
  pr(24, "close"); pr(25, "close");
  pr(26, "take-fix"); pr(27, "take-fix");
  pr(28, "take-fix", 0); pr(29, "take-fix", 0); // no push permission: the "ask" side of fix-up
  for (const n of [30, 31, 32]) {
    item.run(n, "issue", `Issue ${n}`, null, `https://github.com/storytold/app/issues/${n}`, T1, T1);
    jev.run(n, T1);
  }
  W.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 30, 'm', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/23', ?, ?)").run(T1, T1);
  setCommentApproval(W, "op", "app", true);
  setPushApproval(W, "op", "app", true);
  setFixIssueApproval(W, "op", "app", true);
}
const queued = () => buildQueue(W, { repo: "app", merged: "exclude" });
const nums = (xs: { number: number }[]) => xs.map((x) => x.number).sort((a, b) => a - b);

test("the GitHub-writing stages see every item without a pilot", () => {
  assert.deepEqual(nums(queued()), [21, 22, 23, 26, 27, 28, 29]);
  assert.deepEqual(nums(queued().filter(eligible)), [21, 22, 23]);
  assert.deepEqual(nums(closeCandidates(W, "app")), [24, 25]);
  assert.deepEqual(nums(selectIssues(W, "app")), [31, 32]);
  const fx = selectFixups(W, "app");
  assert.deepEqual(nums(fx.fix), [26, 27]);
  assert.deepEqual(nums(fx.ask), [28, 29]);
  assert.deepEqual(nums(planLabels(W, "app")), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
});

test("with a pilot they see only pilot items and the Fix PR of a pilot issue", () => {
  setPilot(W, "tester", ["app#21", "app#24", "app#26", "app#29", "app#30", "app#31"]);
  assert.deepEqual(nums(queued()), [21, 23, 26, 29], "merge queue (single and batch candidates)");
  assert.deepEqual(nums(queued().filter(eligible)), [21, 23]);
  assert.deepEqual(nums(closeCandidates(W, "app")), [24]);
  assert.deepEqual(nums(selectIssues(W, "app")), [31]);
  const fx = selectFixups(W, "app");
  assert.deepEqual(nums(fx.fix), [26]);
  assert.deepEqual(nums(fx.ask), [29]);
  assert.deepEqual(nums(planLabels(W, "app")), [21, 23, 24, 26, 29, 30, 31]);
  setPilot(W, "tester", []);
});

test("act applies answered closes only to pilot items", () => {
  const at = "2026-01-03T00:00:00Z";
  W.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at) VALUES (?, 'close', 'app', ?, 'q', '[]', ?, 'close', 'op', ?)")
    .run("app#24:close@sha24", 24, at, at);
  W.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at) VALUES (?, 'close', 'app', ?, 'q', '[]', ?, 'close', 'op', ?)")
    .run("app#25:close@sha25", 25, at, at);
  assert.deepEqual(nums(actPending(W, "app")), [24, 25]);
  setPilot(W, "tester", ["app#24"]);
  assert.deepEqual(nums(actPending(W, "app")), [24]);
  setPilot(W, "tester", []);
});
