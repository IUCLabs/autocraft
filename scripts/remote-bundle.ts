// Prints the task bundle of one prompt as the server hands it to a helper, for `autocraft-task try`, which runs it in the
// sandbox without a server: node scripts/remote-bundle.ts <prompt id> [--root <slot root>] [--harness claude|codex] [--repo <dir>]
// The prompt's example input is the item; the checkout at /repo is the given directory (default: a two-file sample) as
// an inline files mount. `--root` is the slot root `autocraft-task doctor` prints on macOS.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CLAUDE_PROMPTS, EXAMPLES, claudeArgs, claudeParts, type ClaudePromptId } from "../src/prompts/index.ts";
import { promptTier } from "../src/remote/bundle.ts";
import { forHarness } from "../src/remote/calls.ts";
import type { HarnessId, Mount, TaskBundle } from "../src/remote/protocol.ts";
import { agentsDefinition } from "../src/sandbox/agents.ts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const id = argv[0] as ClaudePromptId;
const p = CLAUDE_PROMPTS[id];
if (!p) {
  console.error(`usage: node scripts/remote-bundle.ts <prompt id> [--root <dir>] [--harness claude|codex] [--repo <dir>]\nprompts with a sandbox: ${Object.keys(CLAUDE_PROMPTS).filter((k) => CLAUDE_PROMPTS[k as ClaudePromptId].sandbox).join(", ")}`);
  process.exit(64);
}
const harness = (opt("--harness") ?? "claude") as HarnessId;

/** Every file below `dir` (no .git), inline. */
function filesOf(dir: string): { name: string; base64: string }[] {
  const out: { name: string; base64: string }[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && statSync(f).size < 1_000_000) out.push({ name: relative(dir, f), base64: readFileSync(f).toString("base64") });
    }
  };
  walk(dir);
  return out;
}
const sample = { "README.md": "# sample\n\nAdds numbers.\n", "src/lib.rs": "/// Adds two numbers.\npub fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n" };
const repo = opt("--repo");
const files = repo ? filesOf(repo) : Object.entries(sample).map(([name, text]) => ({ name, base64: Buffer.from(text).toString("base64") }));

const input = EXAMPLES[id].input as unknown as Record<string, unknown>[];
const sandboxed = p.sandbox !== undefined && input.some((x) => x.repo_dir !== undefined);
const parts = claudeParts(id, input as never, sandboxed, true);
const model = p.models[0]!;
const mounts: Mount[] = sandboxed ? [{ kind: "files", path: "/repo", files }] : [];
const bundle: Omit<TaskBundle, "callId"> = {
  promptId: id, promptVersion: "try", tier: promptTier(id), effort: p.effort, timeoutSeconds: p.limits.timeoutSeconds, maxTurns: sandboxed ? p.sandbox!.maxTurns : null,
  stdin: parts.stdin, system: parts.system, mounts, mcpServers: [], keepSession: false,
  hints: { claude: { args: claudeArgs(id, model, sandboxed, undefined, parts.system), ...(sandboxed && p.sandbox?.workspace && { agents: JSON.stringify(agentsDefinition([])) }) } },
};
console.log(JSON.stringify({ ...forHarness(bundle, harness, opt("--root") ?? ""), callId: 0 }, null, 1));
