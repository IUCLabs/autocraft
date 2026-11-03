import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { attemptsOf } from "../src/fixup/candidates.ts";
import { recountHunks, validatePatch } from "../src/fixup/patch.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const wrap = (file: string, header: string, body: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${header}\n${body}`;

describe("hunk recount", () => {
  test("a miscounted header is repaired and the patch passes", () => {
    const body = " keep\n-a\n+b\n+c\n keep2\n";
    for (const header of ["@@ -1,2 +1,2 @@", "@@ -1,9 +1,9 @@", "@@ -1 +1 @@"]) {
      const r = validatePatch(wrap("src/lib.rs", header, body), ["src/lib.rs"]);
      assert.ok(r.ok, header);
      assert.match(r.patch, /^@@ -1,3 \+1,4 @@$/m);
      assert.equal(r.changed, 3);
    }
  });

  test("two hunks and a function-name suffix keep their own counts", () => {
    const p = recountHunks(wrap("a.rs", "@@ -1,1 +1,1 @@ fn x()", "-a\n+b\n@@ -10,1 +10,1 @@\n c\n-d\n+e\n"));
    assert.match(p, /@@ -1,1 \+1,1 @@ fn x\(\)/);
    assert.match(p, /@@ -10,2 \+10,2 @@/);
  });

  test("every other check still applies after the recount", () => {
    const r = validatePatch(wrap("src/other.rs", "@@ -1,5 +1,5 @@", "-a\n+b\n"), ["src/lib.rs"]);
    assert.ok(!r.ok && /not a file named/.test(r.reason));
    assert.equal(validatePatch(wrap("../x", "@@ -1,5 +1,5 @@", "-a\n+b\n"), ["../x"]).ok, false);
    const big = Array.from({ length: 160 }, (_, i) => `-o${i}\n+n${i}\n`).join("");
    assert.ok(!validatePatch(wrap("src/lib.rs", "@@ -1 +1 @@", big), ["src/lib.rs"]).ok);
  });

  test("a refusal for the header count is not one of the 2 tries", () => {
    const db = connect(join(mkdtempSync(join(SCRATCH, "db-")), "t.db"));
    const add = (state: string, reason: string) => db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, attempt, created_at) VALUES ('app', 7, 'h', ?, ?, 1, '2026-01-01T00:00:00Z')").run(state, reason);
    add("refused", "hunk longer than its header in src/lib.rs");
    add("refused", "truncated hunk in src/lib.rs");
    assert.equal(attemptsOf(db, "app", 7), 0);
    add("refused", "git apply --check: patch does not apply");
    add("failed", "the model gave no answer");
    assert.equal(attemptsOf(db, "app", 7), 2);
  });
});
