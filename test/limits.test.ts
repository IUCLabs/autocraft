// Limits on expensive requests: the per-session GET token bucket (429 with
// Retry-After), the embedding gate, the semaphore, and the contributors cache.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { connect } from "../src/db.ts";
import { clearContributorCache, listContributors } from "../src/dash/api/admin.ts";
import { semanticSearch } from "../src/dash/api/similar.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { SESSION_COOKIE, startServer } from "../src/dash/server/index.ts";
import { Semaphore, TokenBucket } from "../src/dash/server/limits.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import type { Req } from "../src/dash/types.ts";
import { normalize, type Embedder } from "../src/embed/model.ts";
import { embedItems } from "../src/embed/store.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "limits-test-"));
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, "{}");
const db = connect(join(dir, "dash.db"));
let base = "";
let close: () => Promise<void>;
let cookie = "";

before(async () => {
  addLogin(db, "cli", "viewer1", "viewer", null);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: join(dir, "dash.db"), AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_IMG_CACHE: "" });
  const json = { status: 200, headers: {}, json: [] };
  const routes = (["/api/queue", "/api/contributors", "/api/search", "/api/progress"] as const).map((pattern) => ({ method: "GET" as const, pattern, handler: async () => json }));
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes });
  base = s.url;
  close = s.close;
  const jar = new Map<string, string>();
  const get = async (path: string) => {
    const r = await fetch(new URL(path, base), { redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";")[0]!;
      jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
    }
    return r;
  };
  const start = await get("/auth/signin?return_to=/");
  const auth = await get(`${start.headers.get("location")}&login=viewer1`);
  await get(auth.headers.get("location")!);
  cookie = `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)}`;
});
after(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string) => fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });

describe("GET limiter", () => {
  test("expensive endpoints get 429 with Retry-After after a burst; other reads are not limited", async () => {
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 25; i++) {
      last = await api("/api/queue");
      statuses.push(last.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 20);
    assert.equal(statuses[24], 429);
    assert.ok(Number(last!.headers.get("retry-after")) >= 1);
    // The bucket is shared by the expensive endpoints, and only semantic search counts for /api/search.
    assert.equal((await api("/api/contributors")).status, 429);
    assert.equal((await api("/api/search?q=x&mode=semantic")).status, 429);
    assert.equal((await api("/api/search?q=x")).status, 200);
    for (let i = 0; i < 30; i++) assert.equal((await api("/api/progress")).status, 200);
  });

  test("a bucket refills over time", () => {
    const b = new TokenBucket(2, 1);
    assert.equal(b.take("k", 0), 0);
    assert.equal(b.take("k", 0), 0);
    assert.equal(b.take("k", 0), 1);
    assert.equal(b.take("other", 0), 0);
    assert.equal(b.take("k", 1000), 0);
  });
});

describe("Semaphore", () => {
  test("waiters run in order as slots free up; a wait that runs out gets null", async () => {
    const s = new Semaphore(1, 20);
    const first = await s.acquire();
    const second = s.acquire();
    first!();
    const r2 = await second;
    assert.ok(r2);
    assert.equal(await s.acquire(), null);
    r2();
    assert.ok(await s.acquire());
  });
});

describe("semantic search embeds at most two at a time", () => {
  test("the rest wait, then get 429", async () => {
    const now = new Date().toISOString();
    const mdb = connect(join(dir, "embed.db"));
    mdb.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('photocraft', 1, 'issue', 'OPEN', 'crash', 'crash on export', 'a', ?, ?)").run(now, now);
    let running = 0, peak = 0;
    const embedder: Embedder = {
      id: "fake:1", dim: 4,
      async embed(texts) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 60));
        running--;
        return texts.map(() => normalize(new Float32Array([1, 0, 0, 0])));
      },
    };
    await embedItems(mdb, embedder);
    const index = new VectorIndex(embedder);
    const gate = new Semaphore(2, 20);
    const req = { query: new URLSearchParams({ q: "crash" }), user: { role: "operator" } } as unknown as Req;
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => semanticSearch(mdb, req, index, gate)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(refused.length, 2);
    assert.ok(refused.every((r) => r.reason.status === 429));
    assert.ok(peak <= 2);
    mdb.close();
  });
});

describe("contributors cache", () => {
  test("a repeated call within a minute reuses the aggregate until an override clears it", async () => {
    const cdb = connect(join(dir, "contrib.db"));
    const ins = cdb.prepare("INSERT INTO items (repo, number, kind, state, author, merged_at) VALUES ('photocraft', ?, 'pr', 'MERGED', ?, '2026-01-01T00:00:00Z')");
    ins.run(1, "alice");
    const list = async () => listContributors(cdb, { query: new URLSearchParams(), user: { role: "operator" } } as unknown as Req);
    assert.equal((await list()).total, 1);
    ins.run(2, "bob");
    assert.equal((await list()).total, 1);
    clearContributorCache(cdb);
    assert.equal((await list()).total, 2);
    cdb.close();
  });
});
