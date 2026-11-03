// Calls of one prompt share their prefix, so the model's prompt cache covers it: same system prompt, same working directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { askClaude, claudeCwd, setRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { CLAUDE_PROMPTS, claudeParts, promptsReport, type ClaudePromptId } from "../src/prompts/index.ts";
import { SAMPLE_ITEMS, SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = connect(join(mkdtempSync(join(SCRATCH, "claude-cache-")), "t.db"));
useTestAccount(db);
process.env.AUTOCRAFT_CLAUDE_CWD = join(SCRATCH, "claude-cwd");

type Call = { args: string[]; input: string; cwd?: string };
const arg = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe("stable prompt prefix", () => {
  test("tool-free calls with different items share system prompt and working directory; stdin holds the items", async () => {
    const calls: Call[] = [];
    const restore = setRunner(async (_cmd, args, input, cwd) => {
      calls.push({ args, input, cwd });
      return { code: 0, stdout: JSON.stringify({ type: "result", result: "[]" }), stderr: "" };
    });
    try {
      await askClaude("classify.haiku", "haiku", [SAMPLE_ITEMS[0]!], db);
      await askClaude("classify.haiku", "haiku", [SAMPLE_ITEMS[1]!, SAMPLE_ITEMS[0]!], db);
    } finally {
      restore();
    }
    const [a, b] = calls as [Call, Call];
    const sys = arg(a.args, "--system-prompt")!;
    assert.ok(sys.length > 200);
    assert.equal(sys, arg(b.args, "--system-prompt"));
    assert.deepEqual(a.args.filter((x) => x !== sys).sort(), b.args.filter((x) => x !== sys).sort());
    assert.equal(a.cwd, b.cwd);
    assert.equal(a.cwd, claudeCwd());
    assert.ok(a.cwd!.startsWith(SCRATCH) && readdirSync(a.cwd!).length === 0);
    assert.notEqual(a.input, b.input);
    assert.ok(a.input.includes(SAMPLE_ITEMS[0]!.title) && !sys.includes(SAMPLE_ITEMS[0]!.title));
    assert.ok(!a.input.includes(sys.slice(0, 80)), "fixed text is not repeated on stdin");
    // The stdin parts start alike: the fixed frame around the items.
    assert.ok(a.input.startsWith("<items>") && b.input.startsWith("<items>"));
  });

  test("the fixed part of every tool-free prompt holds no item data", () => {
    for (const id of Object.keys(CLAUDE_PROMPTS) as ClaudePromptId[]) {
      const ex = promptsReport(null).prompts.find((p) => p.id === id)!;
      if (CLAUDE_PROMPTS[id].sandbox) continue;
      assert.ok(ex.system && !ex.system.includes("{{"), id);
      assert.ok(ex.example.length > 0 && !ex.example.includes(ex.system.slice(0, 60)), id);
    }
  });

  test("a prompt with item data after its fixed text and one with a repository note split the same way", () => {
    const one = claudeParts("referee.sonnet", [SAMPLE_ITEMS[0]!], false), two = claudeParts("referee.sonnet", SAMPLE_ITEMS, false);
    assert.equal(one.system, two.system);
    const sand = claudeParts("review.opus", SAMPLE_OPUS_PRS, true);
    assert.equal(sand.system, null);
  });

  test("askClaude has no per-call temporary directory", () => {
    const src = readFileSync(new URL("../src/classify/run.ts", import.meta.url), "utf8");
    assert.ok(!/mkdtemp|tmpdir/.test(src));
    assert.ok(statSync(claudeCwd()).isDirectory());
  });
});
