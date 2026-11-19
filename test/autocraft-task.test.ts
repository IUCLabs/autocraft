import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a Claude login's token is used only while it outlives the call's timeout by 10 minutes", () => {
  const now = 1_000_000_000_000;
  const creds = (expiresAt: number) => ({ claudeAiOauth: { accessToken: "sk-ant-oat-x", refreshToken: "r", expiresAt } });
  assert.deepEqual(helper.claudeLoginToken(creds(now + (900 + 601) * 1000), 900, now), { token: "sk-ant-oat-x" });
  assert.deepEqual(helper.claudeLoginToken(creds(now + (900 + 600) * 1000), 900, now), { problem: helper.CLAUDE_LOGIN_EXPIRES });
  assert.ok("problem" in helper.claudeLoginToken(null, 900, now));
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

// A sandboxed review call as `codex exec --json` prints it (event shapes from codex-rs/exec/src/exec_events.rs).
const CODEX_SAMPLE = [
  { type: "thread.started", thread_id: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Reading the diff**" } },
  { type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "files", tool: "grep", arguments: { pattern: "fn parse", path: "/repo/src" }, result: null, error: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "files", tool: "grep", arguments: { pattern: "fn parse", path: "/repo/src" }, result: { content: [{ type: "text", text: "/repo/src/a.rs:3:fn parse" }], structured_content: null }, error: null, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "{\"verdict\":\"take\"}" } },
  { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 64 } },
].map((e) => JSON.stringify(e)).join("\n");

test("codex --json output gives the last message, uncached and cached input, the thread id, and a rerouted model", () => {
  const r = helper.parseCodexOutput(CODEX_SAMPLE, "gpt-6.2-astra");
  assert.deepEqual(r, { ok: true, text: "{\"verdict\":\"take\"}", model: "gpt-6.2-astra", usage: { inputTokens: 315, outputTokens: 122, cacheReadTokens: 24448, cacheWriteTokens: 0 }, sessionId: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90", turns: 2 });
  const rerouted = `${JSON.stringify({ type: "item.completed", item: { id: "item_9", type: "error", message: "model rerouted: gpt-6.2-astra -> gpt-6-sol (HighRiskCyberActivity)" } })}\n${CODEX_SAMPLE}`;
  assert.equal(helper.parseCodexOutput(rerouted, "gpt-6.2-astra").model, "gpt-6-sol");
  const failed = [{ type: "thread.started", thread_id: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90" }, { type: "turn.failed", error: { message: "usage limit reached" } }].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(helper.parseCodexOutput(failed, "m"), { ok: false, text: "", model: "m", usage: undefined, sessionId: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90", error: "model error usage limit reached" });
  assert.equal(helper.codexProgress(CODEX_SAMPLE.split("\n")[3]!), 'Searching for "fn parse" in src');
});

test("codex runs without a shell or --sandbox, reads through the file tools, and keeps tokens out of its arguments", () => {
  const args = helper.codexArgs({ model: "gpt-6.2-astra", effort: "high", system: null, server: "https://ac.example", servers: ["build", "items"], files: "http://127.0.0.1:4100/mcp", keepSession: false, toolTimeoutSec: 900 });
  const line = args.join(" ");
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("--ephemeral") && !args.includes("--sandbox") && !args.includes("-s"));
  assert.match(line, /features=\{shell_tool=false, unified_exec=false/);
  assert.match(line, /permissions=\{autocraft=\{extends=":read-only", filesystem=\{"\/codex-home"="deny"\}\}\}/);
  assert.match(line, /files=\{url="http:\/\/127\.0\.0\.1:4100\/mcp", bearer_token_env_var="AUTOCRAFT_TASK_FILES_TOKEN"/);
  assert.match(line, /items=\{url="https:\/\/ac\.example\/mcp\/task\/items", bearer_token_env_var="AUTOCRAFT_TASK_LEASE_SECRET", default_tools_approval_mode="approve"/);
  const thread = "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90";
  const resumed = helper.codexArgs({ model: "m", effort: "low", system: "Answer as JSON.", server: "https://ac.example", servers: [], files: "http://127.0.0.1:1/mcp", keepSession: true, resumeId: thread, toolTimeoutSec: 60 });
  assert.deepEqual(resumed.slice(-3), ["resume", thread, "-"]);
  assert.ok(resumed.includes('developer_instructions="Answer as JSON."'));
  assert.throws(() => helper.codexArgs({ model: "m", effort: "low", system: null, server: "s", servers: [], files: "f", keepSession: true, resumeId: "last-review", toolTimeoutSec: 60 }), /thread id/);
  const c = helper.codexSandbox({ codexBin: "/bin/codex", codexHome: "/cfg/codex-home", codexArgs: args, mounts: [{ host: "/cache/tree", path: "/repo" }, { host: "/cache/fw", path: "/repos/framework" }], env: { AUTOCRAFT_TASK_FILES_TOKEN: "files-secret", AUTOCRAFT_TASK_LEASE_SECRET: "aclease_secret" } });
  assert.ok(!c.args.join(" ").includes("secret"));
  assert.equal(c.env.CODEX_HOME, "/codex-home");
  assert.ok(c.args.join(" ").includes("--bind /cfg/codex-home /codex-home") && c.args.join(" ").includes("--dir /repos"));
  assert.throws(() => helper.codexSandbox({ codexBin: "/bin/codex", codexHome: "/h", codexArgs: [], mounts: [{ host: "/x", path: "/codex-home" }] }), /unsafe mount path/);
});

test("the file tools read only inside the mounts: no path outside them, no symlink out of them", () => {
  const root = mkdtempSync(join(tmpdir(), "act-files-"));
  try {
    const repo = join(root, "repo"), secret = join(root, "secret");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(secret);
    writeFileSync(join(repo, "src", "a.rs"), "use x;\nfn parse() {}\n");
    writeFileSync(join(secret, "auth.json"), "{\"refresh_token\":\"rt\"}");
    symlinkSync(join(secret, "auth.json"), join(repo, "src", "link.json"));
    const mounts = [{ host: repo, path: "/repo" }];
    assert.equal(helper.runFileTool(mounts, "read_file", { path: "/repo/src/a.rs", offset: 2 }), "     2\tfn parse() {}\n     3\t\n");
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/repo/src/link.json" }), /outside \/repo/);
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/codex-home/auth.json" }), /no such path/);
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/repo/../secret/auth.json" }), /\.\./);
    assert.equal(helper.runFileTool(mounts, "grep", { pattern: "parse|refresh_token", path: "/repo" }), "/repo/src/a.rs:2:fn parse() {}");
    assert.equal(helper.runFileTool(mounts, "glob", { pattern: "**/*.rs" }), "/repo/src/a.rs");
    const reply = helper.fileToolsMessage(mounts, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/repo/src/link.json" } } });
    assert.equal((reply as { result?: { isError?: boolean } } | null)?.result?.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only audited Codex versions run, and a tool outside the call's MCP servers and view_image fails the call", () => {
  assert.equal(helper.codexUnaudited("0.170.3"), null);
  assert.match(helper.codexUnaudited("0.171.0") ?? "", /not a version this helper has audited \(0\.170\.x\)/);
  assert.match(helper.codexUnaudited("1.0.0-beta") ?? "", /not a version/);
  const servers = ["build", "items"];
  const line = (item: object) => JSON.stringify({ type: "item.started", item: { id: "item_1", ...item } });
  assert.equal(helper.codexStreamProblem(CODEX_SAMPLE.split("\n")[3]!, servers), null);
  assert.equal(helper.codexStreamProblem(line({ type: "mcp_tool_call", server: "items", tool: "item" }), servers), null);
  assert.equal(helper.codexStreamProblem(line({ type: "command_execution", command: "cat /codex-home/auth.json" }), servers), "unexpected tool: command_execution");
  assert.equal(helper.codexStreamProblem(line({ type: "mcp_tool_call", server: "github", tool: "get_file" }), servers), "unexpected tool: MCP server github");
  const rollout = (calls: object[]) => calls.map((payload) => JSON.stringify({ timestamp: "2026-11-19T10:00:00.000Z", type: "response_item", payload })).join("\n");
  const fine = [
    { type: "message", role: "user", content: [] },
    { type: "function_call", name: "read_file", namespace: "mcp__files__", arguments: "{}", call_id: "c1" },
    { type: "function_call", name: "mcp__items__item", arguments: "{}", call_id: "c2" },
    { type: "function_call", name: "view_image", arguments: "{}", call_id: "c3" },
    { type: "function_call_output", call_id: "c1", output: "x" },
  ];
  assert.equal(helper.codexRolloutProblem(rollout(fine), servers), null);
  assert.equal(helper.codexRolloutProblem(rollout([...fine, { type: "function_call", name: "read_file", arguments: "{}", call_id: "c4" }]), servers), "unexpected tool: read_file");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "function_call", name: "list_dir", namespace: "mcp__reference__", arguments: "{}", call_id: "c5" }]), servers), "unexpected tool: mcp__reference__list_dir");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "custom_tool_call", name: "exec", input: "", call_id: "c6" }]), servers), "unexpected tool: custom_tool_call");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "local_shell_call", call_id: "c7", status: "completed", action: {} }]), servers), "unexpected tool: local_shell_call");
});
