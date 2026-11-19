// Harness wording for the user-local inference mode. A remote call's prompt is rendered when it is queued, before
// anyone has claimed it, so the phrases that name one harness's tools are carried as marked spans and filled in when
// a helper claims the call and its harness is known (src/remote/calls.ts `bundleOf`). For `claude` the filled text is
// exactly the server's text. No Node imports: src/prompts/index.ts uses this.
import type { HarnessId } from "../remote/protocol.ts";

/** Marks a span: a control character never appears in the JSON that carries item data, so data cannot hold a marker. */
const MARK = "\u0001";

/** Codex reads with its shell: the sandbox keeps commands read-only. */
const SHELL = "read-only shell commands (rg, sed, cat)";

/** Each phrase of the Claude prompts that names a Claude tool, with what the other harnesses read instead. */
const PHRASES: { id: string; claude: string; codex: string }[] = [
  { id: "use", claude: "use Read, Grep and Glob", codex: `use ${SHELL}` },
  { id: "Use", claude: "Use Grep, Glob and Read", codex: `Use ${SHELL}` },
  { id: "list", claude: "(Grep, Glob, Read)", codex: "(rg, sed, cat)" },
  { id: "with-read", claude: "with Read and Grep", codex: `with ${SHELL}` },
  { id: "with-grep", claude: "with Grep and Glob", codex: "with rg" },
  { id: "read-it", claude: "Read it with Read", codex: "Read it with sed or cat" },
  { id: "image", claude: "open each one with Read", codex: "open each one with the view_image tool" },
  { id: "list-files", claude: "list files with Glob", codex: "list files with rg --files" },
  { id: "list-them", claude: "list them with Glob", codex: "list them with ls" },
  // The explorer subagent exists only in Claude Code; the main call searches the workspace itself.
  { id: "explorer", claude: " For a broad search across them, use the Agent tool with subagent_type workspace-search: it is cheaper than reading many files yourself and reports file paths.", codex: " For a broad search across them, run rg over the whole directory with a narrow pattern and read only the files it names." },
];

/** MCP tool names as each harness shows them to the model. */
const MCP_NAME: Record<HarnessId, (server: string, tool: string) => string> = {
  claude: (server, tool) => `mcp__${server}__${tool}`,
  codex: (server, tool) => `mcp__${server}__${tool}`,
};

const MCP_TOOL = /mcp__([a-z][a-z0-9-]*)__([a-z][a-z0-9_]*)/g;

/** Trusted prompt text with every harness phrase and MCP tool name replaced by its marker. */
export function markHarness(text: string): string {
  let out = text;
  for (const p of PHRASES) out = out.split(p.claude).join(`${MARK}${p.id}${MARK}`);
  return out.replace(MCP_TOOL, (_, server: string, tool: string) => `${MARK}mcp:${server}:${tool}${MARK}`);
}

/** The text a harness reads: every marker replaced by that harness's wording; anything else between marks is left alone. */
export function fillHarness(text: string, harness: HarnessId): string {
  if (!text.includes(MARK)) return text;
  return text.replace(/\u0001([\w:-]+)\u0001/g, (whole, id: string) => {
    const mcp = /^mcp:([a-z][a-z0-9-]*):([a-z][a-z0-9_]*)$/.exec(id);
    if (mcp) return MCP_NAME[harness](mcp[1]!, mcp[2]!);
    const p = PHRASES.find((x) => x.id === id);
    return p ? p[harness] : whole;
  });
}
