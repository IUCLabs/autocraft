import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER = new URL("../worker/autocraft.mjs", import.meta.url).pathname;

const TOOLS = [
  { name: "get_item", description: "One item.\nMore text.", inputSchema: { type: "object", required: ["item"], properties: { item: { type: "string" } } } },
  {
    name: "list_inbox", description: "The inbox.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, kind: { type: "string", enum: ["issue", "pr"] }, mine: { type: "boolean" }, repos: { type: "array", items: { type: "string" } }, filter: { type: "object" } } },
  },
  { name: "status", description: "Pipeline status.", inputSchema: { type: "object", properties: {} } },
];

type Seen = { method: string; auth: string; accept: string; params: any };

/** A fake server: /mcp answers JSON-RPC (as SSE when `sse`), `mode` makes it refuse; /login/start records its body. */
async function fake(o: { sse?: boolean; status?: number } = {}) {
  const seen: Seen[] = [];
  const loginBodies: any[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/api/remote/login/start") {
        loginBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ userCode: "BCDF-GHJK", verifyUrl: "http://x/connect", interval: 2, expiresIn: 600 }));
      }
      seen.push({ method: body.method, auth: String(req.headers.authorization), accept: String(req.headers.accept), params: body.params });
      if (o.status) { res.writeHead(o.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { message: "this Task Runner credential has no agent access" } })); }
      if (body.id === undefined) { res.writeHead(202); return res.end(); }
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", instructions: "Read the inbox first." }
        : body.method === "tools/list" ? { tools: TOOLS }
        : { content: [{ type: "text", text: `called ${body.params.name} ${JSON.stringify(body.params.arguments)}` }] };
      const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      if (o.sse) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(`event: message\ndata: ${msg}\n\n`); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(msg);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, loginBodies, close: () => server.close() };
}

/** Runs the worker with a config directory that holds an approved login to `url` (or none). */
async function cli(url: string | null, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ac-tools-"));
  try {
    if (url) {
      mkdirSync(join(dir, "autocraft-runner"), { recursive: true });
      writeFileSync(join(dir, "autocraft-runner", "credentials.json"), JSON.stringify({ server: url, credential: "acrun_test", state: "approved", label: "t" }));
      writeFileSync(join(dir, "autocraft-runner", "config.json"), JSON.stringify({ server: url }));
    }
    const p = spawn(process.execPath, [WORKER, ...args], { env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    const code = await new Promise<number>((r) => p.on("close", (c) => r(c ?? -1)));
    return { code, out, err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("tools lists names with the first description line and marks runner-command names", async () => {
  const f = await fake();
  try {
    const r = await cli(f.url, ["tools"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^get_item +One item\.$/m);
    assert.doesNotMatch(r.out, /More text/);
    assert.match(r.out, /^status .*autocraft call status/m);
    assert.deepEqual(f.seen[0], { method: "initialize", auth: "Bearer acrun_test", accept: "application/json, text/event-stream", params: f.seen[0].params });
  } finally { f.close(); }
});

test("a tool call types its arguments from the schema, takes the one required string positionally, and --json prints the raw result", async () => {
  const f = await fake();
  try {
    const r = await cli(f.url, ["list-inbox", "--limit", "5", "--kind=pr", "--mine", "--repos", "a/b,c/d", "--repos", "e/f", "--filter", '{"x":1}']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `called list_inbox ${JSON.stringify({ limit: 5, kind: "pr", mine: true, repos: ["a/b", "c/d", "e/f"], filter: { x: 1 } })}`);
    const p = await cli(f.url, ["get-item", "designcraft#12", "--json"]);
    assert.equal(p.code, 0, p.err);
    assert.deepEqual(JSON.parse(p.out), { content: [{ type: "text", text: 'called get_item {"item":"designcraft#12"}' }] });
    const s = await cli(f.url, ["call", "status"]);
    assert.equal(s.out.trim(), "called status {}");
  } finally { f.close(); }
});

test("an event-stream reply is read", async () => {
  const f = await fake({ sse: true });
  try {
    const r = await cli(f.url, ["guide"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "Read the inbox first.");
  } finally { f.close(); }
});

test("a 403 says the runner has no agent access", async () => {
  const f = await fake({ status: 403 });
  try {
    const r = await cli(f.url, ["tools"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no agent access/);
  } finally { f.close(); }
});

test("wrong arguments exit 2 and name the valid options", async () => {
  const f = await fake();
  try {
    for (const args of [["list-inbox", "--nope"], ["list-inbox", "--limit", "x"], ["list-inbox", "--limit", "99"], ["list-inbox", "--kind", "bug"], ["get-item"], ["no-such-tool"]]) {
      const r = await cli(f.url, args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    }
    assert.match((await cli(f.url, ["list-inbox", "--nope"])).err, /valid: --limit, --kind, --mine, --repos, --filter/);
  } finally { f.close(); }
});

test("without a login the command says to log in", async () => {
  const r = await cli(null, ["tools"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /autocraft login/);
});

test("login asks for agent access, and for answering only with --answer", async () => {
  const f = await fake();
  try {
    await cli(f.url, ["login", f.url, "--no-wait"]);
    await cli(f.url, ["login", f.url, "--no-wait", "--answer"]);
    await cli(f.url, ["login", f.url, "--no-wait", "--no-agent"]);
    assert.deepEqual(f.loginBodies.map((b) => b.scopes), [{ agent: true, answer: false }, { agent: true, answer: true }, { agent: false, answer: false }]);
  } finally { f.close(); }
});
