import { test } from "node:test";
import assert from "node:assert/strict";
import { githubUrlToRef } from "../web/src/lib/links.ts";

test("a pasted GitHub PR or issue link becomes repo#n", () => {
  assert.equal(githubUrlToRef("https://github.com/storytold/photocraft/pull/15343"), "photocraft#15343");
  assert.equal(githubUrlToRef("https://github.com/storytold/designcraft/issues/42"), "designcraft#42");
  assert.equal(githubUrlToRef("  github.com/storytold/photocraft/pull/15343/files#diff-1 "), "photocraft#15343");
  assert.equal(githubUrlToRef("https://www.github.com/other/foo.js/pull/7?w=1"), "foo.js#7");
});

test("other text is left alone", () => {
  for (const s of ["photocraft#15343", "crash on export", "https://github.com/storytold/photocraft", "see https://github.com/storytold/photocraft/pull/1", "https://github.com/storytold/photocraft/pull/"])
    assert.equal(githubUrlToRef(s), s);
});
