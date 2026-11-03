// Sandboxed calls stream their events: progress lines in order with the right wording, the final result and usage
// unchanged, and the conversation turn showing progress while it is answered.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { askClaude, setRunner, setWorkspace } from "../src/classify/run.ts";
import { coalesce, eventLines } from "../src/classify/progress.ts";
import { answerPending } from "../src/conversations/run.ts";
import { addOperatorMessage, turnsOf } from "../src/conversations/store.ts";
import { conversationView } from "../src/dash/api/conversations.ts";
import { connect } from "../src/db.ts";
import { claudeArgs } from "../src/prompts/index.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "stream-"));
process.env.AUTOCRAFT_CLAUDE_BIN = "/bin/true";
process.env.AUTOCRAFT_CHECKOUT_DIR = join(dir, "checkouts");
process.env.AUTOCRAFT_CLAUDE_CWD = join(dir, "cwd");
setWorkspace(async () => []);

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  const box = useTestAccount(db);
  mkdirSync(`${box.configDir}t`, { recursive: true });
  writeFileSync(`${box.configDir}t/.credentials.json`, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }));
  return db;
}

const tool = (name: string, input: unknown, parent: string | null = null) =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", name, input }] } });
const result = (text: string, usage: number, models?: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", result: text, num_turns: 3, usage: { input_tokens: usage, output_tokens: 1 }, total_cost_usd: 0.5, ...(models && { modelUsage: models }) });

const EVENTS = [
  JSON.stringify({ type: "system", subtype: "init" }),
  tool("Read", { file_path: "/repos/craft-i18n/packs/hu/menu.ftl" }),
  tool("Agent", { description: "Find the Hungarian pack", subagent_type: "explorer", prompt: "secret prompt text" }),
  tool("Grep", { pattern: "spellcheck", path: "/repo/src" }, "toolu_1"),
  tool("mcp__items__item", { repo: "photocraft", number: 1562 }),
  tool("mcp__items__search_items", { query: "hungarian dictionary" }),
  tool("mcp__items__pr_diff", { repo: "photocraft", number: 1562 }),
  tool("Glob", { pattern: "**/*.ftl" }),
  result("first", 1),
  result("[]", 7, { "claude-opus-4": { inputTokens: 7, outputTokens: 1, costUSD: 0.4 }, "claude-haiku-4": { inputTokens: 100, outputTokens: 5, costUSD: 0.1 } }),
];

/** Emits the events one by one with a pause, as the CLI would. */
const streaming = (events: string[], during?: (k: number) => void | Promise<void>) =>
  setRunner(async (_cmd, args, _in, _cwd, _t, _env, onLine) => {
    assert.ok(args.includes("stream-json") && args.includes("--verbose"));
    let out = "";
    for (const [k, l] of events.entries()) {
      out += `${l}\n`;
      onLine?.(l);
      await during?.(k);
      await new Promise((r) => setTimeout(r, 5));
    }
    return { code: 0, stdout: out, stderr: "" };
  });

describe("progress lines", () => {
  test("wording, the explorer prefix, cap and plain text", () => {
    const lines = EVENTS.flatMap((e) => eventLines(JSON.parse(e)));
    assert.deepEqual(lines, [
      "Reading craft-i18n/packs/hu/menu.ftl",
      "Asking the explorer: Find the Hungarian pack",
      'Explorer: Searching for "spellcheck" in src',
      "Looking up photocraft#1562",
      'Searching items for "hungarian dictionary"',
      "Reading the diff of photocraft#1562",
      "Listing **/*.ftl",
    ]);
    const [long] = eventLines(JSON.parse(tool("Agent", { description: `x\n\u0007${"y".repeat(500)}` })));
    assert.ok(long!.length <= 120 && !/[\n\u0007]/.test(long!));
    assert.deepEqual(eventLines(JSON.parse(tool("Write", { file_path: "/x", content: "file contents" }))), []);
  });

  test("coalesce writes at most once per interval, keeping the newest value", () => {
    let t = 0;
    const out: number[] = [];
    const c = coalesce((v: number) => out.push(v), 1000, () => t);
    c.push(1); t = 100; c.push(2); t = 200; c.push(3);
    assert.deepEqual(out, [1]);
    c.flush();
    assert.deepEqual(out, [1, 3]);
    t = 5000; c.push(4);
    assert.deepEqual(out, [1, 3, 4]);
  });

  test("the sandboxed args stream and are the same on every call", () => {
    const a = claudeArgs("conversation.turn", "opus", true), b = claudeArgs("conversation.turn", "opus", true);
    assert.deepEqual(a, b);
    assert.ok(a.join(" ").includes("--output-format stream-json --verbose"));
    assert.ok(claudeArgs("classify.haiku", "haiku").join(" ").includes("--output-format json "));
  });
});

describe("askClaude with a stream", () => {
  test("onProgress gets the lines in order; the answer is the last result event; the run shows the latest line until it ends", async () => {
    const db = fresh();
    const seen: string[] = [];
    let running: string | null | undefined;
    const restore = streaming(EVENTS, (k) => {
      if (k === 1) running = (db.prepare("SELECT progress FROM agent_runs WHERE state = 'running'").get() as { progress: string } | undefined)?.progress;
    });
    try {
      const r = await askClaude("conversation.turn", "opus", [{ ref: "app#1", item: "{}", turns: "" }], db, { checkout: dir, onProgress: (l) => seen.push(l) });
      assert.equal(r?.text, "[]");
      assert.equal(r?.usage.input, 7);
      assert.equal(r?.usage.extra?.[0]?.model, "haiku");
      assert.equal(r?.usage.extra?.[0]?.usage.input, 100);
      assert.equal(r?.turns, 3);
    } finally {
      restore();
    }
    assert.equal(seen.length, 7);
    assert.equal(seen[0], "Reading craft-i18n/packs/hu/menu.ftl");
    assert.equal(seen[2], 'Explorer: Searching for "spellcheck" in src');
    assert.equal(running, "Reading craft-i18n/packs/hu/menu.ftl");
    const row = db.prepare("SELECT state, progress FROM agent_runs").get() as { state: string; progress: string | null };
    assert.equal(row.state, "done");
    assert.equal(row.progress, null);
  });

  test("an error result still fails the call", async () => {
    const db = fresh();
    const restore = streaming([tool("Read", { file_path: "/repo/a" }), JSON.stringify({ type: "result", is_error: true, result: "boom" })]);
    try {
      assert.equal(await askClaude("conversation.turn", "opus", [{ ref: "app#1", item: "{}", turns: "" }], db, { checkout: dir }), null);
    } finally {
      restore();
    }
    assert.equal((db.prepare("SELECT summary FROM agent_runs").get() as { summary: string }).summary, "model error");
  });
});

describe("conversation turn progress", () => {
  test("the answering turn shows the latest lines; the stored reply clears them", async () => {
    const db = fresh();
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', '2026-01-01T00:00:00Z', 1)").run();
    db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels) VALUES ('app', 1, 'issue', 'OPEN', 'Issue 1', 'Body', 'someone', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '[]')").run();
    await addOperatorMessage(db, "app", 1, "op", "What do you think?");
    const during: { pending: boolean; progress?: string[] }[] = [];
    const restore = streaming([...EVENTS.slice(0, 3), result("Looks fine.", 3)], (k) => {
      if (k === 1) during.push(conversationView(db, "app", 1));
    });
    try {
      const n = await answerPending(db, { checkout: async () => dir, usageRun: "u", log: () => {} });
      assert.equal(n, 1);
    } finally {
      restore();
    }
    assert.deepEqual(during[0]?.progress, ["Reading craft-i18n/packs/hu/menu.ftl"]);
    const after = conversationView(db, "app", 1);
    assert.equal(after.pending, false);
    assert.equal(after.progress, undefined);
    assert.ok(turnsOf(db, "app", 1).every((t) => t.progress === null));
  });
});
