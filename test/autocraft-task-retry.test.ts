import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as helper from "../worker/autocraft-task.mjs";

test("lease requests retry 5xx and resets with backoff, keep the same body, and stop at a 410, another 4xx or the deadline", async () => {
  const hits: Record<string, string[]> = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const seen = (hits[req.url ?? ""] ??= []);
      seen.push(body);
      if (req.url === "/api/remote/submit") {
        if (seen.length === 1) { res.writeHead(502, { "Retry-After": "0" }).end("bad gateway"); return; }
        if (seen.length === 2) { req.socket.destroy(); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accepted: true }));
      } else if (req.url === "/api/remote/heartbeat") res.writeHead(410).end();
      else if (req.url === "/api/remote/release") res.writeHead(400).end("bad body");
      else res.writeHead(503, { "Retry-After": "30" }).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opt = () => ({ deadline: Date.now() + 10_000, baseMs: 5 });
  try {
    const submit = { ok: true, text: "done" };
    assert.deepEqual(await helper.withRetry(() => helper.api(base, "/api/remote/submit", "s", submit), opt()), { accepted: true });
    assert.deepEqual(hits["/api/remote/submit"], Array(3).fill(JSON.stringify(submit)));

    await assert.rejects(helper.withRetry(() => helper.api(base, "/api/remote/heartbeat", "s", { phase: "running" }), opt()), /the lease is gone/);
    assert.equal(hits["/api/remote/heartbeat"].length, 1);
    await assert.rejects(helper.withRetry(() => helper.api(base, "/api/remote/release", "s", { reason: "x" }), opt()), /HTTP 400/);
    assert.equal(hits["/api/remote/release"].length, 1);
    // Retry-After 30 s does not fit before a deadline 1 s away: one try.
    await assert.rejects(helper.withRetry(() => helper.api(base, "/api/remote/bundle", "s"), { deadline: Date.now() + 1000, baseMs: 5 }), /HTTP 503/);
    assert.equal(hits["/api/remote/bundle"].length, 1);
  } finally {
    server.close();
  }
});
