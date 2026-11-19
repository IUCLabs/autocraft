import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helper from "../worker/autocraft-task.mjs";

test("on start the helper gives back the leases of dead runs and of runs never started, and keeps live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helper-orphans-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  const released: { secret: string, reason: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url === "/api/remote/release") released.push({ secret: String(req.headers.authorization).replace("Bearer ", ""), reason: JSON.parse(body).reason });
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const now = Date.now();
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(dir, "config", "autocraft-task", "leases"), { recursive: true });
    mkdirSync(join(dir, "cache", "autocraft-task", "runs"), { recursive: true });
    const lease = (id: number, claimedAt: number, status?: object) => {
      writeFileSync(join(dir, "config", "autocraft-task", "leases", `${id}.json`), JSON.stringify({ secret: `secret-${id}`, title: `call ${id}`, requiredHelper: "1.0.0", server: url, claimedAt }));
      if (status) writeFileSync(join(dir, "cache", "autocraft-task", "runs", `${id}.json`), JSON.stringify(status));
    };
    lease(1, now - 60_000, { state: "running", line: "running", pid: deadPid, at: now - 60_000 });
    lease(2, now - 60_000, { state: "running", line: "running", pid: process.pid, at: now - 60_000 });
    lease(3, now - 10 * 60_000);
    lease(4, now - 30_000);
    const ids = await helper.releaseOrphans(now);
    assert.deepEqual(ids.sort(), [1, 3]);
    assert.deepEqual(released.map((r) => r.secret).sort(), ["secret-1", "secret-3"]);
    assert.ok(released.every((r) => r.reason.length > 0));
    const has = (id: number) => existsSync(join(dir, "config", "autocraft-task", "leases", `${id}.json`));
    assert.deepEqual([1, 2, 3, 4].map(has), [false, true, false, true], "a live run and a fresh claim keep their leases");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
