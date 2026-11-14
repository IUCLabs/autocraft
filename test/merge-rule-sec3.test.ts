// What keeps a PR off the merge-without-asking rule by its content, and what the reviews are shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sensitiveReasons, CI_FILES_REASON as CI, EXTERNAL_LINK_REASON as LINK, FILE_KIND_REASON as KIND, TESTS_UNREAD_REASON, UNREADABLE_PATH_REASON,
} from "../src/core/sensitive.ts";
import { LOCK_ALONE_REASON, LOCK_CHECKSUM_REASON, LOCK_SOURCE_REASON } from "../src/core/lockfiles.ts";
import { MAX_DIFF_CHARS, codeDiff } from "../src/review/diff.ts";
import { buildScripts } from "../src/fixup/patch.ts";

/** A section that edits `path` from `before` to `after` in one hunk (whole file), and the head text the cache keeps for it. */
const edit = (path: string, before: string[], after: string[]) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((l) => `-${l}`).join("\n")}\n${after.map((l) => `+${l}`).join("\n")}\n`;
const added = (path: string, ...lines: string[]) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;

test("the content check reads whole manifests, lockfiles, file kinds, both names of a file, and links as a browser resolves them", () => {
  const manifest = (before: string[], after: string[], path = "crates/a/Cargo.toml") => sensitiveReasons(edit(path, before, after), "storytold", { [path]: `${after.join("\n")}\n` });
  const pkg = ["[package]", 'name = "a"', 'version = "0.1.0"'];
  // Entries under an unchanged header, dotted keys and literal strings are read as Cargo reads them.
  assert.deepEqual(manifest([...pkg, "[build-dependencies]", 'cc = "1"'], [...pkg, "[build-dependencies]", 'cc = "1"', 'evil = "1"']), [CI]);
  assert.deepEqual(manifest([...pkg, "[dependencies]"], [...pkg, "[dependencies]", 'foo.git = "https://example.com/foo"']), [CI]);
  assert.deepEqual(manifest([...pkg, "[dependencies]"], [...pkg, "[dependencies]", "foo = { path = '../../../outside' }"]), [CI]);
  assert.deepEqual(manifest([...pkg, "[patch.crates-io]", 'u = { path = "vendor/u" }'], [...pkg, "[patch.crates-io]", 'u = { path = "vendor/u" }', 'serde = { path = "vendor/serde" }']), [CI]);
  assert.deepEqual(manifest(pkg, ["[package]", 'name = "a"', 'version = "0.1.0"', 'build = """gen.rs"""']), [CI]);
  // A version bump of a registry dependency needs nobody; an edited manifest the cache does not hold counts as risky.
  assert.deepEqual(manifest([...pkg, "[dependencies]", 'serde = "1.0.200"'], [...pkg, "[dependencies]", 'serde = "1.0.201"']), []);
  assert.deepEqual(sensitiveReasons(edit("Cargo.toml", ['a = "1"'], ['a = "2"']), "storytold"), [CI]);

  const bump = edit("Cargo.toml", ["[dependencies]", 'serde = "1.0.200"'], ["[dependencies]", 'serde = "1.0.201"']);
  const files = { "Cargo.toml": '[dependencies]\nserde = "1.0.201"\n' };
  const lock = (lines: string[]) => `diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -10,6 +10,6 @@\n${lines.join("\n")}\n`;
  const crates = ' source = "registry+https://github.com/rust-lang/crates.io-index"';
  const routine = lock([" [[package]]", ' name = "serde"', '-version = "1.0.200"', '+version = "1.0.201"', crates, '-checksum = "aaa"', '+checksum = "bbb"']);
  assert.deepEqual(sensitiveReasons(bump + routine, "storytold", files), []);
  assert.deepEqual(sensitiveReasons(routine, "storytold"), [LOCK_ALONE_REASON]);
  const git = lock([" [[package]]", ' name = "serde"', ' version = "1.0.201"', `-${crates.slice(1)}`, '+source = "git+https://github.com/someone/serde#abc"', '-checksum = "bbb"']);
  assert.deepEqual(sensitiveReasons(bump + git, "storytold", files), [LOCK_SOURCE_REASON]);
  const repin = lock([" [[package]]", ' name = "serde"', ' version = "1.0.201"', crates, '-checksum = "bbb"', '+checksum = "ccc"']);
  assert.deepEqual(sensitiveReasons(bump + repin, "storytold", files), [LOCK_CHECKSUM_REASON]);

  // File kinds no review can read, and trust paths beyond workflows.
  const gitlink = "diff --git a/vendor/codec b/vendor/codec\nindex 1111111..2222222 160000\n--- a/vendor/codec\n+++ b/vendor/codec\n@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222\n";
  const symlink = "diff --git a/src/a.rs b/src/a.rs\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/src/a.rs\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n";
  const mode = "diff --git a/scripts/release.sh b/scripts/release.sh\nold mode 100644\nnew mode 100755\n";
  const binary = (p: string) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\nBinary files a/${p} and b/${p} differ\n`;
  for (const d of [gitlink, symlink, mode, binary("assets/filter.wasm")]) assert.deepEqual(sensitiveReasons(d, "storytold"), [KIND], d);
  assert.deepEqual(sensitiveReasons(binary("docs/shot.png"), "storytold"), []);
  for (const p of [".github/actions/setup/action.yml", "rust-toolchain.toml", "justfile", ".gitmodules", "crates/a/build.rs"]) assert.deepEqual(sensitiveReasons(added(p, "x"), "storytold"), [CI], p);
  // Both names of a renamed file, and git's quoted names.
  assert.deepEqual(sensitiveReasons("diff --git a/.github/workflows/ci.yml b/notes/ci-old.yml\nsimilarity index 100%\nrename from .github/workflows/ci.yml\nrename to notes/ci-old.yml\n", "storytold"), [CI]);
  assert.deepEqual(sensitiveReasons('diff --git "a/.github/workflows/\\303\\251.yml" "b/.github/workflows/\\303\\251.yml"\nnew file mode 100644\n--- /dev/null\n+++ "b/.github/workflows/\\303\\251.yml"\n@@ -0,0 +1 @@\n+on: push\n', "storytold"), [CI]);
  assert.deepEqual(sensitiveReasons('diff --git "a/x\\q" "b/x\\q"\nnew file mode 100644\n', "storytold"), [UNREADABLE_PATH_REASON]);

  // Links: a line whose text starts with "++", a scheme without slashes, an attribute split over lines, dot segments.
  for (const lines of [["++ ![x](https://evil.example/p.png)"], ["[x](http:evil.example/login)"], ['<a href="https:/', '/evil.example/login">x</a>'], ['<a href="https:/&Tab;/evil.example">x</a>'], ["![x](https://github.com/storytold/../other/repo/raw/main/p.png)"]]) {
    assert.deepEqual(sensitiveReasons(added("docs/guide.md", ...lines), "storytold"), [LINK], lines.join(" / "));
  }
  assert.deepEqual(sensitiveReasons(added("docs/guide.md", "[x](../guide.md)", "![a](images/a.png)", "https://github.com/storytold/app/issues/1", "see https://storytold.github.io/x"), "storytold"), []);
});

test("the reviews are shown test files while they fit, the rule counts the rest as unread, and build scripts resolve from every manifest spelling", () => {
  const big = "x".repeat(MAX_DIFF_CHARS);
  const diff = added("src/lib.rs", "mod fixtures;") + added("src/fixtures/mod.rs", "pub fn f() {}") + added("Cargo.lock", "[[package]]");
  const shown = codeDiff(diff, MAX_DIFF_CHARS);
  assert.deepEqual([shown.files, shown.testsOmitted, shown.lockfilesOmitted], [["src/lib.rs", "src/fixtures/mod.rs"], [], ["Cargo.lock"]]);
  const cut = codeDiff(added("src/lib.rs", "mod fixtures;") + added("tests/it.rs", big), MAX_DIFF_CHARS);
  assert.deepEqual([cut.files, cut.testsOmitted], [["src/lib.rs"], ["tests/it.rs"]]);
  assert.ok(sensitiveReasons(added("src/lib.rs", "mod fixtures;") + added("tests/it.rs", big), "storytold").includes(TESTS_UNREAD_REASON));

  const forms = ['package = { name = "a", build = "gen.rs" }', '[package]\n"build" = "gen.rs"', '["package"]\nbuild = "gen.rs"', '[package]\nbuild = """gen.rs"""', '[package]\nbuild = "g\\u0065n.rs"', 'package . build = "gen.rs"'];
  for (const toml of forms) assert.deepEqual([...buildScripts(["c/Cargo.toml", "c/gen.rs"], () => toml)], ["c/gen.rs"], toml);
  // A manifest that does not parse makes every Rust file of its crate outside src/ a build script.
  assert.deepEqual([...buildScripts(["c/Cargo.toml", "c/gen.rs", "c/src/lib.rs"], () => "[package\nbuild = 'gen.rs'")].sort(), ["c/gen.rs"]);
});
