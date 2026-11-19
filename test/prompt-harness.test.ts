// A user-local call's prompt is rendered with marked harness phrases (src/prompts/harness.ts). Filled for `claude`
// it must be the server's text byte for byte, apart from the reference sentence, which names the reference tools
// instead of the /reference mount; filled for `codex` it must not name a Claude tool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fillHarness } from "../src/prompts/harness.ts";
import { CLAUDE_PROMPTS, EXAMPLES, REFERENCE_NOTE, REFERENCE_TOOLS_NOTE, claudeParts, joinParts, withoutRepoDir, type ClaudePromptId } from "../src/prompts/index.ts";

/** Every way a call of each prompt is rendered: without a checkout, and sandboxed with the reference and docs flags. */
function cases(): { name: string; id: ClaudePromptId; input: never; sandboxed: boolean; reference: boolean }[] {
  const out: ReturnType<typeof cases> = [];
  for (const id of Object.keys(CLAUDE_PROMPTS) as ClaudePromptId[]) {
    const p = CLAUDE_PROMPTS[id], base = EXAMPLES[id].input as unknown as object[];
    out.push({ name: `${id} without tools`, id, input: withoutRepoDir(base) as never, sandboxed: false, reference: false });
    if (!p.sandbox) continue;
    for (const reference of p.sandbox.reference ? [false, true] : [false])
      for (const docs of p.sandbox.docs ? [false, true] : [false])
        out.push({ name: `${id} sandboxed${reference ? ", reference" : ""}${docs ? ", docs" : ""}`, id, sandboxed: true, reference, input: base.map((x) => ({ ...x, ...(reference && { reference: true }), ...(docs && { repo_docs: true }) })) as never });
  }
  return out;
}

test("user-local prompts read as the server's for claude and name no Claude tool for codex", () => {
  let referenced = 0;
  for (const c of cases()) {
    const server = joinParts(claudeParts(c.id, c.input, c.sandboxed));
    const remote = claudeParts(c.id, c.input, c.sandboxed, true);
    const claude = joinParts({ system: remote.system === null ? null : fillHarness(remote.system, "claude"), stdin: fillHarness(remote.stdin, "claude") });
    if (c.reference) {
      assert.ok(server.includes(REFERENCE_NOTE), c.name);
      referenced++;
    }
    assert.equal(claude, c.reference ? server.replace(REFERENCE_NOTE, REFERENCE_TOOLS_NOTE) : server, c.name);
    const codex = fillHarness(joinParts(remote), "codex");
    assert.doesNotMatch(codex, /\bGrep\b|\bGlob\b|with Read\b|workspace-search|subagent_type|\u0001/, c.name);
  }
  assert.ok(referenced > 0);
});
