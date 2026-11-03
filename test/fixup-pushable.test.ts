import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { classifyFixups, selectFixups } from "../src/fixup/candidates.ts";
import { pushable } from "../src/fixup/pushable.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pushable-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);

function pr(headRepo: string | null, canModify: boolean): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, head_repo, head_ref, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Fix', 'someone', 5, 0, 'h1', ?, 'fix-typo', '${T0}', '${T0}')`).run(headRepo);
  db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', 7, 'h1', 'rv', '${T0}', 'm', 'S', 'take-fix', 'nearly', ?)`).run(FIXES);
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, 'h1', 'OPEN', 0, 'success', '[]', 'MERGEABLE', ?, '${T1}')`).run(canModify ? 1 : 0);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  setPushApproval(db, "op", "app", true);
  finalizeReviews(db);
  return db;
}

describe("pushable", () => {
  test("the rule: same repository or maintainer edits", () => {
    assert.equal(pushable("storytold/app", "app", false, "fix-typo"), true);
    assert.equal(pushable("Storytold/App", "app", false, "fix-typo"), true);
    assert.equal(pushable("someone/app", "app", false, "fix-typo"), false);
    assert.equal(pushable("someone/app", "app", true, "fix-typo"), true);
    assert.equal(pushable(null, "app", false, "fix-typo"), false);
  });

  test("a same-repo PR with canModify false is a fix candidate; a fork without edits is not", () => {
    assert.equal(selectFixups(pr("storytold/app", false), "app").fix.length, 1);
    const fork = selectFixups(pr("someone/app", false), "app");
    assert.equal(fork.fix.length, 0);
    assert.equal(fork.cannotPush.length, 1);
  });

  test("an asked head becomes a fix candidate again once the PR is pushable, within the 2 tries", () => {
    const db = pr("someone/app", false);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, files, attempt, created_at) VALUES ('app', 7, 'h1', 'asked', '[]', 1, ?)").run(T1);
    assert.equal(classifyFixups(db, "app")[0]!.bucket, "asked");
    db.prepare("UPDATE items SET head_repo = 'storytold/app' WHERE number = 7").run();
    const [x] = classifyFixups(db, "app");
    assert.equal(x!.bucket, "fix");
    assert.equal(x!.c.attempt, 1);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, attempt, created_at) VALUES ('app', 7, 'h1', 'failed', 1, ?), ('app', 7, 'h1', 'refused', 2, ?)").run(T1, T1);
    assert.equal(classifyFixups(db, "app")[0]!.bucket, "hold");
  });

  test("a same-repo head is never pushable on a long-lived branch", () => {
    for (const b of ["main", "release/1.2", "release-2", "master", "develop", "stable", "hotfix-x", "integration-app-20260101-1"]) assert.equal(pushable("storytold/app", "app", false, b), false, b);
    assert.equal(pushable("storytold/app", "app", false, null), false);
    const db = pr("storytold/app", false);
    db.prepare("INSERT INTO repos (name, default_branch) VALUES ('app', 'trunk')").run();
    db.prepare("UPDATE items SET head_ref = 'trunk' WHERE number = 7").run();
    assert.equal(selectFixups(db, "app").fix.length, 0);
    db.prepare("UPDATE items SET head_ref = 'topic' WHERE number = 7").run();
    assert.equal(selectFixups(db, "app").fix.length, 1);
    db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_ref, base_ref, head_repo, created_at, updated_at) VALUES ('app', 8, 'pr', 'OPEN', 't', 'x', 'other', 'topic', 'someone/app', ?, ?)").run(T0, T0);
    assert.equal(selectFixups(db, "app").fix.length, 0);
  });

  test("asked and cannot-push rows at a head do not ask again once the PR is pushable", () => {
    const db = pr("someone/app", false);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, files, attempt, created_at) VALUES ('app', 7, 'h1', 'cannot-push', '[]', 1, ?), ('app', 7, 'h1', 'asked', '[]', 1, ?)").run(T1, T1);
    db.prepare("UPDATE items SET head_repo = 'storytold/app' WHERE number = 7").run();
    const sel = selectFixups(db, "app");
    assert.equal(sel.ask.length, 0);
    assert.equal(sel.fix.length, 1);
  });

  test("a push denied at push time records push-denied and the head is not tried again", async () => {
    const db = pr("storytold/app", false);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, files, attempt, created_at) VALUES ('app', 7, 'h1', 'push-denied', '[]', 1, ?)").run(T1);
    assert.equal(selectFixups(db, "app").fix.length, 0);
    assert.equal(classifyFixups(db, "app")[0]!.bucket, "hold");
  });
});
