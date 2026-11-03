import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { connect } from "../src/db.ts";
import { selectCandidates } from "../src/review/candidates.ts";
import { checksQuery, parseChecks } from "../src/review/checks.ts";
import { codeDiff } from "../src/review/diff.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "review-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");

const T0 = "2026-01-01T00:00:00Z";

function fresh() {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
  useTestAccount(db);
  const pr = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, additions, deletions, changed_files, head_oid, created_at, updated_at)
    VALUES ('app', ?, 'pr', ?, ?, 'body', ?, ?, 0, 1, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', ?, ?, ?)`);
  const haiku = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('app', ?, 'haiku', 'r1', '${T0}', ?, '[]')`);
  const add = (n: number, label: string, o: { top?: number; flags?: string[]; draft?: boolean; state?: string; lines?: number; haiku?: string } = {}) => {
    pr.run(n, o.state ?? "OPEN", `PR ${n}`, o.draft ? 1 : 0, o.lines ?? 20, `sha${n}a`);
    jev.run(n, label, JSON.stringify(o.flags ?? []), JSON.stringify({ top: o.top ?? 0.95 }));
    if (o.haiku) haiku.run(n, o.haiku);
  };
  add(1, "bugfix");
  add(2, "plugin candidate");
  add(3, "bugfix", { draft: true });
  add(4, "bugfix", { state: "CLOSED" });
  add(5, "missing feature", { flags: ["needs decision"] });
  add(6, "missing feature", { flags: ["needs decision"] });
  add(7, "performance", { top: 0.6, haiku: "performance" });
  add(8, "performance", { top: 0.6, haiku: "bugfix" });
  add(9, "infra", { lines: 900 });
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_at)
    VALUES ('d1', 'scope', 'app', 6, 'q', '[]', '${T0}', 'take', '${T0}')`).run();
  return db;
}

const diffOf = (n: number) =>
  `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old${n}\n+new${n}\n` +
  `diff --git a/tests/t.rs b/tests/t.rs\n--- a/tests/t.rs\n+++ b/tests/t.rs\n@@ -1 +1 @@\n-a\n+b\n` +
  `diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-a\n+b\n`;

describe("review candidates", () => {
  test("open, non-draft, wanted label, no open scope question", () => {
    const db = fresh();
    const got = selectCandidates(db, "app").map((c) => [c.number, c.size]);
    // 2 plugin candidate, 3 draft, 4 closed, 5 needs decision, 8 Jev unsure and Haiku disagrees
    assert.deepEqual(got, [[1, "S"], [6, "S"], [7, "S"], [9, "L"]]);
  });

  test("a scope answer of small-extra keeps a needs-decision PR; plugin does not", () => {
    const db = fresh();
    db.prepare("UPDATE decisions SET answer = 'small-extra' WHERE id = 'd1'").run();
    assert.ok(selectCandidates(db, "app").some((c) => c.number === 6));
    db.prepare("UPDATE decisions SET answer = 'plugin' WHERE id = 'd1'").run();
    assert.ok(!selectCandidates(db, "app").some((c) => c.number === 6));
  });
});

describe("checks", () => {
  test("one query per chunk; check states roll up to an overall state", () => {
    assert.equal([...checksQuery([1, 2]).matchAll(/pullRequest\(/g)].length, 2);
    const node = (n: number, ctx: object[]) => ({ number: n, state: "OPEN", isDraft: false, headRefOid: `h${n}`, mergeable: "CONFLICTING", maintainerCanModify: false,
      commits: { nodes: [{ commit: { statusCheckRollup: ctx.length ? { contexts: { nodes: ctx } } : null } }] } });
    const ok = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" };
    const rows = parseChecks("app", {
      pr1: node(1, [ok, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }]),
      pr2: node(2, [ok, { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }]),
      pr3: node(3, [ok, { __typename: "StatusContext", context: "ext", state: "ERROR" }, { __typename: "CheckRun", name: "x", status: "QUEUED" }]),
      pr4: node(4, []),
      pr5: null,
    });
    assert.deepEqual(rows.map((r) => [r.number, r.overall]), [[1, "success"], [2, "pending"], [3, "failure"], [4, "none"]]);
    assert.deepEqual(rows[2]!.checks.map((c) => c.state), ["success", "failure", "pending"]);
    assert.equal(rows[0]!.mergeable, "CONFLICTING");
  });
});

describe("code diff", () => {
  test("leaves out tests and lockfiles", () => {
    const cd = codeDiff(diffOf(1));
    assert.deepEqual([cd.files, cd.testsOmitted, cd.lockfilesOmitted, cd.codeLines], [["src/lib.rs"], ["tests/t.rs"], ["Cargo.lock"], 2]);
  });
});
