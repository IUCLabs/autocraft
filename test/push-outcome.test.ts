import { test } from "node:test";
import assert from "node:assert/strict";
import { breakerTripped, classifyPush, requiredResult } from "../src/core/push-outcome.ts";
import { join } from "node:path";
import { connect } from "../src/db.ts";
import { tmpdir } from "./world-db.ts";
import { recordPush, resolvePushes } from "../src/push-outcomes.ts";

test("push outcome: green to red is broke, red to green is fixed, optional checks are ignored", () => {
  const green = [{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }];
  const red = [{ name: "gate", state: "failure" }, { name: "sonar", state: "success" }];
  const optional = ["sonar"];
  assert.equal(requiredResult(green, optional), "green");
  assert.equal(requiredResult(red, optional), "red");
  assert.equal(requiredResult([{ name: "gate", state: "pending" }], optional), "pending");
  assert.equal(classifyPush(requiredResult(green, optional), requiredResult(red, optional)), "broke");
  assert.equal(classifyPush(requiredResult(red, optional), requiredResult(green, optional)), "fixed");
  assert.equal(classifyPush("red", "red"), "still-red");
  assert.equal(classifyPush("green", "green"), "kept-green");
  assert.equal(classifyPush("unknown", "red"), "unknown");
  assert.equal(classifyPush("green", "pending"), null);
  assert.equal(classifyPush("green", "none"), null, "no required check yet is not final");
  // A red optional check alone is no break.
  assert.equal(classifyPush("green", requiredResult([{ name: "gate", state: "success" }, { name: "sonar", state: "failure" }], optional)), "kept-green");
  assert.equal(breakerTripped(["broke", "fixed", null, "broke"]), true);
  assert.equal(breakerTripped(["broke", ...Array(9).fill("fixed"), "broke"]), false);
});

test("a new branch takes the CI result of its base commit, not the latest main CI", () => {
  const db = connect(join(tmpdir("push-base"), "t.db"));
  const ci = (sha: string, state: string, at: string) => db.prepare("INSERT INTO main_ci (repo, head_sha, branch, state, failing, checks, committed_at, first_seen_at, state_changed_at, updated_at) VALUES ('o/r', ?, 'main', ?, '[]', '[]', ?, ?, ?, ?)").run(sha, state, at, at, at, at);
  ci("base", "red", "2026-11-01T00:00:00Z");
  ci("latest", "green", "2026-11-02T00:00:00Z");
  const before = () => (db.prepare("SELECT before_res FROM push_outcomes ORDER BY id DESC LIMIT 1").get() as { before_res: string }).before_res;
  recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c1", base: "base" });
  assert.equal(before(), "red");
  recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c2", base: "gone" });
  assert.equal(before(), "green", "no row for the base: the latest main CI");
  recordPush(db, "fixissue-push", { repo: "o/r", number: null, from: null, to: "c3" });
  assert.equal(before(), "green");
  const rows = [{ repo: "o/r", number: 5, head_oid: "c1", checks: [{ name: "gate", state: "failure" }] }];
  resolvePushes(db, rows);
  assert.equal((db.prepare("SELECT outcome FROM push_outcomes WHERE to_oid = 'c1'").get() as { outcome: string }).outcome, "still-red");
});
