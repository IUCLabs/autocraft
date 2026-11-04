import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { attemptsOf, classifyFixups, selectFixups } from "../src/fixup/candidates.ts";
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

  test("an unpushable branch is never asked and never recorded as held", () => {
    const db = take("someone/app");
    const sel = selectFixups(db, "app");
    assert.equal(sel.fix.length + sel.ask.length + sel.cannotPush.length, 0);
    assert.equal(classifyFixups(db, "app")[0]!.bucket, "cannot-push");
  });
});
