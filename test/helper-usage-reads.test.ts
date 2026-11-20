import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "usage-reads-"));
const helper = await import("../worker/autocraft.mjs");

const body = { five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400_000).toISOString() } };
const adapter = { id: "claude", token: () => "t" } as any;
const read = () => helper.readQuota({} as any, adapter, "claude", ["opus"]);

test("parallel usage reads make one fetch, and a 429 keeps the last good reading counting", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  let status = 200;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return status === 429 ? new Response("", { status, headers: { "retry-after": "120" } }) : new Response(JSON.stringify(body), { status });
  }) as any;
  try {
    const [a, b, c] = await Promise.all([read(), read(), read()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.ok(!("error" in c));
    // The provider now refuses; the cached good reading is replaced by a refusal that Retry-After holds back.
    const file = join(process.env.XDG_CACHE_HOME!, "autocraft-runner", "usage.json");
    const cache = JSON.parse(readFileSync(file, "utf8"));
    cache.reading = { ...cache.reading, at: Date.now() - 120_000 };
    cache.good = cache.reading;
    writeFileSync(file, JSON.stringify(cache));
    status = 429;
    const failed = await read();
    assert.equal(calls, 2);
    assert.ok(!("error" in failed) && failed.lastGood, "the last good reading stands in, marked");
    assert.deepEqual(helper.quotaVerdict(failed, { fiveHour: 20, weekly: 20 }), { ok: true });
    assert.equal((helper.quotaVerdict(failed, { fiveHour: 75, weekly: 20 }) as any).ok, false, "too close to the reserve holds");
    await read();
    assert.equal(calls, 2, "Retry-After keeps the next fetch away");
  } finally {
    globalThis.fetch = real;
  }
});
