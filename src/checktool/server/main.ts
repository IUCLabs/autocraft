// The `check` tool's MCP server, run by node inside the model's sandbox: a minimal stdio server (newline-delimited
// JSON-RPC 2.0) that forwards each call to the harness over loopback HTTP. The harness runs the command on a worker;
// nothing here builds or reads code. Imports only node built-ins, because the sandbox mounts just this directory.
import { request } from "node:http";
import { createInterface } from "node:readline";
import { TOOL } from "./tool.ts";

const URL_ = process.env.CHECK_TOOL_URL ?? "";
const TOKEN = process.env.CHECK_TOOL_TOKEN ?? "";

type Msg = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

function forward(args: unknown): Promise<{ text: string; isError?: boolean }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(args ?? {});
    const u = new globalThis.URL(URL_);
    const req = request({ host: u.hostname, port: u.port, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve({ text: "the build tool gave an unreadable answer", isError: true }); }
      });
    });
    req.on("error", (e) => resolve({ text: `the build tool is not reachable: ${e.message}`, isError: true }));
    req.end(body);
  });
}

async function handle(msg: Msg): Promise<unknown | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return { jsonrpc: "2.0", id, result: { protocolVersion: typeof want === "string" ? want : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "check-tool", version: "1.0.0" } } };
    }
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } };
      const r = await forward(msg.params.arguments);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) } };
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Msg;
  try { msg = JSON.parse(line) as Msg; } catch { return; }
  void handle(msg).then((reply) => { if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`); });
});
