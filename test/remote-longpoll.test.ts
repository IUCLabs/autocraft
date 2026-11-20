// Long-polling claims (protocol 4): a claim with nothing to take waits for a call queued by another process, answers empty at
// its deadline (still counting its helper idle), never holds for protocol 3, stops at a cool-off or the user's max calls at
// once, stops when its client leaves or its credential is removed, and is answered cleanly when the dashboard shuts down.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SCRATCH } from "./scratch.ts";

// Every user-local window, the hold included, at a fifth: a 25 s hold is 5 s, the full retry every second. Read on import.
process.env.AUTOCRAFT_REMOTE_TIME_SCALE = "0.2";
const { addLogin } = await import("../src/access.ts");
const { apiRoutes } = await import("../src/dash/api/index.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { loadConfig } = await import("../src/dash/server/config.ts");
const { startServer } = await import("../src/dash/server/index.ts");
const { FakeProvider } = await import("../src/dash/server/provider.ts");
const { RateLimiter } = await import("../src/dash/server/util.ts");
const { connect } = await import("../src/db.ts");
const { CLAIM_RETRY_S, enqueueCall } = await import("../src/remote/calls.ts");
const { setUserMaxCalls } = await import("../src/remote/max-calls.ts");
const { setInferenceMode } = await import("../src/remote/mode.ts");
const { ROUTES } = await import("../src/remote/protocol.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-longpoll-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("long-polling claims", async () => {
  const file = join(dir, "t.db"), perms = join(dir, "perms.json");
  writeFileSync(perms, "{}");
  const db = connect(file), remoteDb = connect(file, { busyTimeoutMs: 100 }), other = connect(file);
  setInferenceMode(db, "user-local", "test");
  const tokens: Record<string, { token: string; id: number }> = {};
  for (const login of ["bob", "carol", "dave", "erin", "frank"]) {
    addLogin(db, "cli", login, "maintainer", null);
    const t = createToken(db, login, "runner", { kind: "runner" });
    tokens[login] = { token: t.token, id: t.row.id };
    db.prepare("INSERT OR REPLACE INTO repo_permissions (login, repo, permission, checked_at) VALUES (?, 'photocraft', 'write', ?)").run(login, new Date().toISOString());
  }
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: file, AUTOCRAFT_DEV_PERMS: perms });
  const limiter = new RateLimiter(60, 3600_000);
  const s = await startServer({ config, db, remoteDb, provider: new FakeProvider(perms), feedbackLimiter: limiter, routes: apiRoutes({ limiter }) });
  let closed = false;
  after(async () => { if (!closed) await s.close(); for (const c of [other, remoteDb, db]) c.close(); });

  let n = 0;
  const claim = async (login: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const body = { requestId: `longpoll-${String(++n).padStart(4, "0")}`, protocol: 4, wait: 25, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" }, ...extra };
    const t = Date.now();
    const r = await fetch(`${s.url}${ROUTES.claim}`, { method: "POST", headers: { authorization: `Bearer ${tokens[login]!.token}`, "content-type": "application/json" }, body: JSON.stringify(body), ...(signal && { signal }) });
    assert.equal(r.status, 200);
    return { reply: await r.json() as { lease: { id: number; secret: string } | null; retryAfter?: number; reason?: string }, ms: Date.now() - t, held: Number(r.headers.get("x-held-ms")) };
  };
  /** Queues a call through another connection, as a job process does. */
  const enqueue = (): number => enqueueCall(other, {
    promptId: "review.opus", promptVersion: "t", tier: "top", effort: "high", askedModel: "opus", items: [{ repo: "photocraft", number: 1 }], level: 2, maxAttempts: 2,
    bundle: { promptId: "review.opus", promptVersion: "t", tier: "top", effort: "high", timeoutSeconds: 600, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} },
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const state = (id: number) => (db.prepare("SELECT state FROM remote_calls WHERE id = ?").get(id) as { state: string }).state;

  test("a held claim takes a call queued by another process within a second; a repeat of its request id gets the same lease", async () => {
    const first = claim("bob", { requestId: "longpoll-same-0001" });
    await sleep(100);
    const again = claim("bob", { requestId: "longpoll-same-0001" });
    await sleep(200);
    const at = Date.now();
    const id = enqueue();
    const [a, b] = await Promise.all([first, again]);
    assert.equal(a.reply.lease?.id, id);
    assert.equal(b.reply.lease?.secret, a.reply.lease?.secret);
    assert.ok(Date.now() - at < 1000, `answered ${Date.now() - at} ms after the call was queued`);
    assert.ok(a.held >= 250, "the reply says how long it waited");
  });

  test("a held claim with nothing to take answers empty at its deadline and records its helper as idle", async () => {
    const r = claim("bob", { wait: 2 });
    await sleep(100);
    db.prepare("UPDATE mcp_tokens SET idle_claim_at = NULL WHERE id = ?").run(tokens.bob!.id);
    const { reply, held } = await r;
    assert.equal(reply.lease, null);
    assert.equal(reply.retryAfter, 0.2);
    assert.ok(held >= 350 && held < 1500, `held ${held} ms of a 400 ms hold`);
    assert.ok((db.prepare("SELECT idle_claim_at FROM mcp_tokens WHERE id = ?").get(tokens.bob!.id) as { idle_claim_at: number | null }).idle_claim_at !== null);
  });

  test("a protocol 3 claim is answered at once, whatever it sends as wait", async () => {
    const { reply, ms, held } = await claim("bob", { protocol: 3 });
    assert.equal(reply.lease, null);
    assert.equal(reply.retryAfter, CLAIM_RETRY_S);
    assert.equal(held, 0);
    assert.ok(ms < 500, `answered in ${ms} ms`);
  });

  test("a held claim whose client left takes nothing; the next claim with the same request id gets the call", async () => {
    const ac = new AbortController();
    const gone = claim("bob", { requestId: "longpoll-gone-0001" }, ac.signal).catch(() => null);
    await sleep(200);
    ac.abort();
    await gone;
    await sleep(100);
    const id = enqueue();
    await sleep(400);
    assert.equal(state(id), "queued");
    const { reply } = await claim("bob", { requestId: "longpoll-gone-0001" });
    assert.equal(reply.lease?.id, id);
  });

  test("the user's max calls at once and a cool-off end a held claim with their reason", async () => {
    setUserMaxCalls(db, "carol", 1);
    const full = claim("carol");
    await sleep(200);
    // Another of carol's helpers leases a call meanwhile: queued and leased in one transaction, so the held claim never sees it queued.
    other.exec("BEGIN IMMEDIATE");
    const id = enqueue();
    other.prepare("UPDATE remote_calls SET state = 'leased', user_login = 'carol', leased_at = ?, heartbeat_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
    other.exec("COMMIT");
    const a = await full;
    assert.equal(a.reply.lease, null);
    assert.match(a.reply.reason ?? "", /limit of calls at once/);
    assert.ok(a.ms < 2500, `answered after ${a.ms} ms of a 5 s hold`);

    const cooled = claim("dave");
    await sleep(200);
    other.prepare("INSERT INTO remote_cooloffs (login, until, reason) VALUES ('dave', ?, 'testing cool-off')").run(Date.now() + 60_000);
    const b = await cooled;
    assert.equal(b.reply.reason, "testing cool-off");
    assert.ok(b.ms < 2500, `answered after ${b.ms} ms of a 5 s hold`);
  });

  test("a held claim whose credential is removed meanwhile leases nothing", async () => {
    const r = claim("frank");
    await sleep(200);
    other.prepare("DELETE FROM mcp_tokens WHERE id = ?").run(tokens.frank!.id);
    const id = enqueue();
    const { reply } = await r;
    assert.equal(reply.lease, null);
    assert.match(reply.reason ?? "", /credential was removed/);
    assert.equal(state(id), "queued");
    other.prepare("DELETE FROM remote_calls WHERE id = ?").run(id);
  });

  test("shutting down answers held claims with a short retry, not a reset", async () => {
    const r = claim("erin");
    await sleep(200);
    const t = Date.now();
    closed = true;
    await s.close();
    const { reply } = await r;
    assert.equal(reply.lease, null);
    assert.ok(reply.retryAfter! >= 0.2 && reply.retryAfter! <= 1, `retryAfter ${reply.retryAfter}`);
    assert.ok(Date.now() - t < 1000);
  });
});
