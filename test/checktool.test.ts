import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CheckTool } from "../src/checktool/index.ts";

describe("check tool", () => {
  test("a command outside fmt, clippy, check and test is refused before anything is queued", async () => {
    let applied = 0;
    const tool = new CheckTool({ db: {} as never, step: "fixup", repo: "app", number: 1, head: "a".repeat(40), base: null, applies: async () => { applied++; return null; } });
    for (const command of ["build", "rm -rf /", "clippy; ls", undefined]) {
      const r = await tool.run({ patch: "diff --git a/x.rs b/x.rs\n", command });
      assert.equal(r.isError, true);
      assert.match(r.text, /^refused: command must be one of fmt, clippy, check, test/);
    }
    assert.equal((await tool.run({ patch: "p", command: "test", crate: "app; ls" })).isError, true);
    assert.equal(applied, 0);
    assert.equal(tool.calls, 0);
  });
});

describe("clippy reminder", () => {
  test("a Rust diff from a call that never got a clippy result needs the reminder", async () => {
    const { needsClippy } = await import("../src/classify/run.ts");
    const diff = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-a\n+b\n";
    assert.equal(needsClippy({ ran: new Set() }, diff), true);
    assert.equal(needsClippy({ ran: new Set(["clippy"]) }, diff), false);
    assert.equal(needsClippy({ ran: new Set() }, diff.replaceAll("lib.rs", "README.md")), false);
  });
});
