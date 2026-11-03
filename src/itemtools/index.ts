// What a sandboxed model call needs to use the item tools: the read-only
// mounts and the MCP server definition. Inside the sandbox:
//   /app/item-tools      the server code (src/itemtools/server), run by /usr/bin/node
//   /data/items.db       the item snapshot (src/itemtools/snapshot.ts)
//   /data/diffs          the cache of PR diffs, when it exists
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diffCacheDir } from "../review/diff.ts";
import { snapshotFile, writeSnapshot } from "./snapshot.ts";
import { openDb, TOOLS } from "./server/tools.ts";
import { handle } from "./server/mcp.ts";

export const ITEM_SERVER = "items";
export const APP_PATH = "/app/item-tools";
export const DATA_PATH = "/data";

export type Mount = { host: string; path: string };
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

/** Names claude knows the tools by, for --allowedTools. */
export const itemToolNames = (): string[] => TOOLS.map((t) => `mcp__${ITEM_SERVER}__${t.name}`);

/** Read-only mounts and the stdio server definition; null when no snapshot has been built yet. */
export function itemTools(): { mounts: Mount[]; mcpServers: Record<string, McpServer> } | null {
  const snapshot = snapshotFile();
  if (!existsSync(snapshot)) return null;
  const diffs = diffCacheDir();
  const mounts: Mount[] = [
    { host: fileURLToPath(new URL("./server", import.meta.url)), path: APP_PATH },
    { host: snapshot, path: `${DATA_PATH}/items.db` },
  ];
  const env: Record<string, string> = { ITEM_TOOLS_DB: `${DATA_PATH}/items.db` };
  if (existsSync(diffs)) {
    mounts.push({ host: diffs, path: `${DATA_PATH}/diffs` });
    env.ITEM_TOOLS_DIFFS = `${DATA_PATH}/diffs`;
  }
  return { mounts, mcpServers: { [ITEM_SERVER]: { command: "/usr/bin/node", args: ["--no-warnings", `${APP_PATH}/main.ts`], env } } };
}

function snapshot(): void {
  const r = writeSnapshot();
  console.log(`${snapshotFile()}: ${r.items} items, ${r.comments} comments, ${r.bytes} bytes`);
}

function call(args: string[]): void {
  const [tool, json] = args;
  if (!tool) throw new Error(`usage: item-tools call <tool> [<json arguments>]\ntools: ${TOOLS.map((t) => t.name).join(", ")}`);
  const db = openDb(snapshotFile());
  const cfg = { db: snapshotFile(), diffs: diffCacheDir() };
  const reply = handle({ id: 1, method: "tools/call", params: { name: tool, arguments: json ? JSON.parse(json) : {} } }, () => db, cfg);
  const r = (reply!.result as { content: { text: string }[]; isError?: boolean });
  console.log(r.content[0]!.text);
  if (r.isError) process.exitCode = 1;
}

async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "snapshot") return snapshot();
  if (sub === "call") return call(rest);
  throw new Error("usage: item-tools snapshot | item-tools call <tool> [<json>]");
}

export const commands = {
  "item-tools": { summary: "item tools for sandboxed calls: `snapshot` builds the read-only snapshot, `call <tool> <json>` runs a tool without a model", run },
};
