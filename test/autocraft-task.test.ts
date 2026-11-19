import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helper from "../worker/autocraft-task.mjs";
import type * as H from "../worker/autocraft-task.mjs";
import * as protocol from "../src/remote/protocol.ts";

// The helper keeps its own copy of the wire format; these fail to compile when the copies drift.
const same = <A, B extends A>(_: (b: B) => A) => true;
void [
  same<protocol.Claim, H.Claim>((b) => b), same<H.Claim, protocol.Claim>((b) => b),
  same<protocol.ClaimReply, H.ClaimReply>((b) => b), same<H.ClaimReply, protocol.ClaimReply>((b) => b),
  same<protocol.TaskBundle, H.TaskBundle>((b) => b), same<H.TaskBundle, protocol.TaskBundle>((b) => b),
  same<protocol.Submit, H.Submit>((b) => b), same<H.Submit, protocol.Submit>((b) => b),
];

test("the helper speaks the server's protocol version and routes", () => {
  assert.equal(helper.PROTOCOL_VERSION, protocol.PROTOCOL_VERSION);
  assert.deepEqual(helper.ROUTES, protocol.ROUTES);
});

// A sandboxed review call with the explorer subagent, as `claude -p --output-format stream-json --verbose` prints it.
const SAMPLE = [
  { type: "system", subtype: "init", session_id: "6f1c0d2e", model: "claude-opus-4-5-20251101", tools: ["Read", "Grep", "Glob", "Agent"] },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: null, message: { id: "msg_1", usage: { input_tokens: 9, output_tokens: 120, cache_read_input_tokens: 15000, cache_creation_input_tokens: 4000 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/lib.rs" } }] } },
  { type: "user", session_id: "6f1c0d2e", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "fn main() {}" }] } },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: "t2", message: { id: "msg_2", usage: { input_tokens: 400, output_tokens: 30 }, content: [{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: "target", path: "/repos/bundle" } }] } },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: null, message: { id: "msg_3", usage: { input_tokens: 3, output_tokens: 800 }, content: [{ type: "text", text: "Looks fine." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Recommendation: merge", session_id: "6f1c0d2e", num_turns: 4, total_cost_usd: 0.41,
    usage: { input_tokens: 12, output_tokens: 920, cache_read_input_tokens: 15000, cache_creation_input_tokens: 4000 },
    modelUsage: {
      "claude-opus-4-5-20251101": { inputTokens: 12, outputTokens: 920, cacheReadInputTokens: 15000, cacheCreationInputTokens: 4000, costUSD: 0.4 },
      "claude-haiku-4-5-20251001": { inputTokens: 400, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
    } },
].map((e) => JSON.stringify(e)).join("\n");

test("stream-json output gives the reply, the called model's usage, usage per model, cost, the reported model, session and turns", () => {
  assert.deepEqual(helper.parseClaudeOutput(SAMPLE, "opus"), {
    ok: true, text: "Recommendation: merge", model: "claude-opus-4-5-20251101", sessionId: "6f1c0d2e", turns: 4,
    usage: { inputTokens: 12, outputTokens: 920, cacheReadTokens: 15000, cacheWriteTokens: 4000 }, costUsd: 0.41,
    modelUsage: {
      "claude-opus-4-5-20251101": { inputTokens: 12, outputTokens: 920, cacheReadTokens: 15000, cacheWriteTokens: 4000 },
      "claude-haiku-4-5-20251001": { inputTokens: 400, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  });
  const lines = SAMPLE.split("\n").map(helper.claudeProgress).filter(Boolean);
  assert.deepEqual(lines, ["Reading src/lib.rs", 'Explorer: Searching for "target" in bundle']);
  // Killed before the result: no reply, the tokens seen so far.
  const cut = helper.parseClaudeOutput(SAMPLE.split("\n").slice(0, 3).join("\n"), "opus");
  assert.equal(cut.ok, false);
  assert.deepEqual(cut.usage, { inputTokens: 9, outputTokens: 120, cacheReadTokens: 15000, cacheWriteTokens: 4000 });
});

test("instruction files and .claude directories are removed from a checkout at any depth", () => {
  const root = mkdtempSync(join(tmpdir(), "act-instr-"));
  try {
    for (const f of ["CLAUDE.md", "src/agents.md", "src/lib.rs", "docs/Claude.local.md", ".claude/settings.json", "a/.Claude/x/y.md", "README.md", "claude.mdx"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "x");
    }
    assert.deepEqual(helper.removeInstructionFiles(root), [".claude", "CLAUDE.md", "a/.Claude", "docs/Claude.local.md", "src/agents.md"]);
    assert.deepEqual(helper.removeInstructionFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the claim's model replaces the hinted one; the token stays out of the sandbox arguments", () => {
  const hinted = ["-p", "--model", "opus", "--effort", "high", "--output-format", "stream-json", "--add-dir", "/repo", "--add-dir", "/repos", "--mcp-config", "/mcp.json", "--resume", "old"];
  const args = helper.withoutResume(helper.withModel(hinted, "claude-opus-4-5"));
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "claude-opus-4-5"]);
  assert.ok(!args.includes("--resume") && !args.includes("old"));
  assert.deepEqual(helper.withModel(["-p", "--effort", "low"], "haiku"), ["-p", "--model", "haiku", "--effort", "low"]);
  const c = helper.claudeSandbox({ claudeBin: "/bin/claude", oauthToken: "sk-ant-oat01-secret", claudeArgs: args, mounts: [{ host: "/cache/tree", path: "/repo" }], mcpFile: "/task/mcp.json" });
  assert.ok(!c.args.join(" ").includes("secret"));
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-secret");
  // `/repos` is named by --add-dir with nothing mounted under it: it exists, empty.
  assert.ok(c.args.join(" ").includes("--dir /repos"));
  assert.throws(() => helper.claudeSandbox({ claudeBin: "/bin/claude", claudeArgs: [], mounts: [{ host: "/x", path: "/home/sandbox/.claude" }] }), /unsafe mount path/);
});
