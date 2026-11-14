// What a build worker reports is untrusted: its formatter diff is folded into a pipeline commit only when the files git writes differ from the patched files by whitespace alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, Git } from "../src/fixup/git.ts";
import { checkFormat, foldFormat } from "../src/prepush/index.ts";

const HEAD = [
  "fn add(a: i32, b: i32) -> i32 { a + b }",
  "",
  "fn delete_account(user: &User, id: u32) -> Result<(), Error> {",
  "    if !user.is_admin() {",
  "        return Err(Error::Forbidden);",
  "    }",
  "",
  "    audit(user, id);",
  "    purge(id);",
  "    Ok(())",
  "}",
  "",
].join("\n");
const HDR = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n";
const PATCH = `${HDR}@@ -1,2 +1,2 @@\n-fn add(a: i32, b: i32) -> i32 { a + b }\n+fn add(a: i32, b: i32) -> i32 {  b + a }\n \n`;

test("a formatter diff folds in only when every file it writes is the patched file reformatted", async () => {
  const root = mkdtempSync(join(tmpdir(), "fold-"));
  try {
    const git = new Git(exec, root, "app");
    await git.init();
    const tree = await git.withFiles("4b825dc642cb6eb9a060e54bf8d69288fbee4904", [{ path: "src/lib.rs", mode: "100644", content: HEAD }], join(root, "index"));
    const head = (await git.must(["commit-tree", tree, "-m", "head"], { env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } })).trim();
    const fold = (fmt: string) => foldFormat(git, head, PATCH, fmt, join(root, "scratch"));

    const honest = await fold(`${HDR}@@ -1,3 +1,3 @@\n-fn add(a: i32, b: i32) -> i32 {  b + a }\n+fn add(a: i32, b: i32) -> i32 { b + a }\n \n fn delete_account(user: &User, id: u32) -> Result<(), Error> {\n`);
    assert.ok(honest.ok, honest.ok ? "" : honest.reason);
    assert.match(honest.patch, /^\+fn add\(a: i32, b: i32\) -> i32 \{ b \+ a \}$/m);

    // The admin check leaves one hunk and enters the next: the hunk bodies hold the same tokens, the file does not.
    const moved = `${HDR}@@ -3,5 +3,2 @@\n fn delete_account(user: &User, id: u32) -> Result<(), Error> {\n-    if !user.is_admin() {\n-        return Err(Error::Forbidden);\n-    }\n \n@@ -10,1 +7,4 @@\n+    if !user.is_admin() {\n+        return Err(Error::Forbidden);\n+    }\n     Ok(())\n`;
    assert.equal(checkFormat(PATCH, moved).ok, true);
    const r = await fold(moved);
    assert.deepEqual(r, { ok: false, reason: "the formatter changed more than whitespace in src/lib.rs" });

    // Lines git acts on outside a hunk: a section before the first header, a binary literal.
    assert.deepEqual(await fold(`--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -7,3 +7,3 @@\n \n-    audit(user, id);\n+    run(user, id);\n     purge(id);\n`), { ok: false, reason: "the formatter diff has text before its first file header" });
    const binary = await fold(`diff --git a/src/lib.rs b/src/lib.rs\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 5\nMcmZ?b00001\n\nx\n`);
    assert.ok(!binary.ok && /a line outside a hunk in src\/lib\.rs: index/.test(binary.reason));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
