import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { attemptsOf, classifyFixups, selectFixups } from "../src/fixup/candidates.ts";
import { holdMerge } from "../src/merge/controls.ts";
import { mergeDecisionId } from "../src/merge/queue.ts";
import { savePremerge, type PremergeFinding } from "../src/premerge/store.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "premerge-fixup-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const defect = (file: string): PremergeFinding => ({ severity: "defect", file, line: 3, title: "t", scenario: "s", fix: { file, change: `fix ${file}` } });

function take(headRepo = "storytold/app", findings: PremergeFinding[] = [defect("src/a.rs"), defect("src/b.rs")]): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, head_repo, head_ref, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Fix', 'someone', 5, 0, 'h1', ?, 'fix-typo', '${T0}', '${T0}')`).run(headRepo);
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, 'h1', 'rv', '${T0}', 'm', 'take', 'fine', NULL, 1, 'full')`).run();
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, 'h1', 'OPEN', 0, 'success', '[]', 'MERGEABLE', 0, '${T1}')`).run();
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  // What the merge queue needs to treat the PR as one the rule would merge.
  db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 7, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run();
  db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', 7, 'h1', 'tests', 'r', 'passed', '${T0}')`).run();
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('someone', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO main.settings (key, value) VALUES ('merge_approved:app', ?)").run(JSON.stringify({ by: "op", at: T0 }));
  setPushApproval(db, "op", "app", true);
  savePremerge(db, { repo: "app", number: 7, head: "h1", at: T1, model: "opus", findings });
  return db;
}
const row = (db: DatabaseSync, state: string, source: string | null) =>
  db.prepare("INSERT INTO fixups (repo, number, from_head, state, attempt, created_at, source) VALUES ('app', 7, 'h1', ?, 1, ?, ?)").run(state, T1, source);

describe("pre-merge fix-up round", () => {
  test("a take PR whose defects all have fixes is selected with those fixes and the source", () => {
    const sel = selectFixups(take(), "app").fix;
    assert.equal(sel.length, 1);
    assert.equal(sel[0]!.source, "premerge");
    assert.equal(sel[0]!.reason, "pre-merge review");
    assert.equal(sel[0]!.model, "opus");
    assert.deepEqual(sel[0]!.fixes.map((f) => f.file), ["src/a.rs", "src/b.rs"]);
  });

  test("the queue decides: a merge hold, an open Merge? question or a Hold answer leaves no pre-merge round", () => {
    assert.equal(selectFixups(take(), "app").fix.length, 1);
    const held = take();
    holdMerge(held, "op", "app", 7);
    assert.equal(selectFixups(held, "app").fix.length, 0);
    const asked = take();
    const id = mergeDecisionId("app", 7, "h1");
    const ins = `INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at) VALUES (?, 'merge', 'app', 7, 'Merge?', '[]', '${T1}', ?, ?, ?)`;
    asked.prepare(ins).run(id, null, null, null);
    assert.equal(selectFixups(asked, "app").fix.length, 0);
    const declined = take();
    declined.prepare(ins).run(id, "hold", "op", "2099-01-01T00:00:00Z");
    assert.equal(selectFixups(declined, "app").fix.length, 0);
  });

  test("a stale review sends no pre-merge round", () => {
    const db = take();
    db.prepare("INSERT INTO comments (id, repo, number, kind, author, author_association, body, created_at, counted) VALUES ('c1', 'app', 7, 'comment', 'rabbit', 'CONTRIBUTOR', 'new finding', '2026-03-01T00:00:00Z', 1)").run();
    assert.equal(selectFixups(db, "app").fix.length, 0);
  });

  test("a defect without a fix, or only minor findings, is not selected", () => {
    const noFix = { ...defect("src/b.rs"), fix: undefined };
    assert.equal(classifyFixups(take("storytold/app", [defect("src/a.rs"), noFix]), "app").length, 0);
    assert.equal(classifyFixups(take("storytold/app", [{ ...defect("src/a.rs"), severity: "minor" }]), "app").length, 0);
  });

  test("any recorded pre-merge outcome uses the round", () => {
    for (const state of ["pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "pushing"]) {
      const db = take();
      row(db, state, "premerge");
      assert.equal(classifyFixups(db, "app").length, 0, state);
    }
  });

  test("take-fix tries neither block the pre-merge round nor are used by it", () => {
    const db = take();
    row(db, "failed", null);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, attempt, created_at) VALUES ('app', 7, 'h0', 'refused', 2, ?)").run(T1);
    const [x] = classifyFixups(db, "app");
    assert.equal(x!.bucket, "fix");
    assert.equal(x!.c.source, "premerge");
    row(db, "failed", "premerge");
    assert.equal(attemptsOf(db, "app", 7), 2);
  });

  test("a take-fix review at another head still gets its two tries after a pre-merge round", () => {
    const db = take();
    row(db, "failed", "premerge");
    db.prepare("UPDATE opus_reviews SET verdict = 'take-fix', fixes = '[{\"file\":\"src/a.rs\",\"change\":\"x\"}]'").run();
    const [x] = classifyFixups(db, "app");
    assert.equal(x!.bucket, "fix");
    assert.equal(x!.c.source, undefined);
    assert.equal(x!.c.attempt, 1);
  });

  test("an unpushable branch is never asked, held or selected: the queue asks a person", () => {
    const db = take("someone/app");
    const sel = selectFixups(db, "app");
    assert.equal(sel.fix.length + sel.ask.length + sel.cannotPush.length, 0);
    assert.equal(classifyFixups(db, "app").length, 0);
  });
});
