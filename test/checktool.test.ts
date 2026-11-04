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
