// Change markers (triggers) and the GET /api/live stream.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { connect } from "../src/db.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { readSeqs, TOPICS } from "../src/live.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "live-test-"));
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, "{}");
const db = connect(join(dir, "live.db"));

const changed = (before: Record<string, number>): string[] => {
  const now = readSeqs(db);
  return Object.keys(now).filter((t) => now[t] !== before[t]).sort();
};

describe("change markers", () => {
  test("every topic has a row, starting at zero", () => {
    const seqs = readSeqs(db);
    assert.deepEqual(Object.keys(seqs).sort(), [...TOPICS].sort());
  });

  test("a write bumps the topic of its table, per row and per operation", () => {
    let b = readSeqs(db);
    db.exec("INSERT INTO items (repo, number, kind, state, title) VALUES ('r', 1, 'pr', 'open', 't'), ('r', 2, 'pr', 'open', 't')");
    assert.deepEqual(changed(b), ["items"]);
    assert.equal(readSeqs(db).items! - b.items!, 2);
    b = readSeqs(db);
    db.exec("UPDATE items SET title = 'u' WHERE number = 1");
    assert.deepEqual(changed(b), ["items"]);
    b = readSeqs(db);
    db.exec("DELETE FROM items WHERE number = 2");
    assert.deepEqual(changed(b), ["items"]);
    b = readSeqs(db);
    db.exec("INSERT INTO jobs (step, state, requested_by, requested_at, params) VALUES ('s', 'queued', 'x', 'now', '{}')");
    assert.deepEqual(changed(b), ["jobs"]);
  });

  test("the runner heartbeat and session activity do not bump anything", () => {
    addLogin(db, "cli", "boss", "operator", null);
    db.exec("INSERT INTO sessions (id_hash, login, csrf, created_at, last_seen, expires_at) VALUES ('h', 'boss', 'c', 'a', 'a', 'z')");
    const b = readSeqs(db);
    db.exec("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    db.exec("UPDATE sessions SET last_seen = 'b'");
    db.exec("INSERT INTO build_envs (id, label, kind, slots, key_hash, created_at, updated_by, updated_at) VALUES ('e', 'E', 'local', 1, 'k', 'a', 'boss', 'a')");
    const e = readSeqs(db);
    db.exec("UPDATE build_envs SET last_seen_at = 'b' WHERE id = 'e'");
    assert.deepEqual(changed(e), [], "a worker poll alone");
    db.exec("UPDATE build_envs SET paused_reason = 'disk' WHERE id = 'e'");
    assert.deepEqual(changed(e), ["envs"]);
    db.exec("DELETE FROM build_envs");
    const b2 = readSeqs(db);
    db.exec("UPDATE sessions SET last_seen = 'c'");
    assert.deepEqual(changed(b2), []);
    db.exec("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', '1')");
    assert.deepEqual(changed(b2), ["settings"]);
  });
});

describe("GET /api/live", () => {
  let base = "";
  let close: () => Promise<void>;
  let cookie = "";

  before(async () => {
    addLogin(db, "cli", "viewer1", "viewer", null);
    const config = loadConfig({ CRAFT_AUTO_DEV_AUTH: "1", CRAFT_AUTO_LISTEN: "127.0.0.1:0", CRAFT_AUTO_DB: join(dir, "live.db"), CRAFT_AUTO_DEV_PERMS: permsFile });
    const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: [], live: { pollMs: 20, heartbeatMs: 80 } });
    base = s.url;
    close = s.close;
    const start = await fetch(new URL("/auth/signin?return_to=/", base), { redirect: "manual" });
    const state = start.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const auth = await fetch(new URL(`${start.headers.get("location")}&login=viewer1`, base), { redirect: "manual" });
    const cb = await fetch(new URL(auth.headers.get("location")!, base), { redirect: "manual", headers: { cookie: state } });
    cookie = cb.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("__Host-craft_session")).join("; ");
    assert.ok(cookie);
  });
  after(async () => {
    await close();
    db.close();
  });

  test("signed-out requests get 401", async () => {
    const r = await fetch(new URL("/api/live", base), { headers: { accept: "text/event-stream" } });
    assert.equal(r.status, 401);
  });

  test("sends the seq map, then changes, then heartbeats", async () => {
    const ac = new AbortController();
    const r = await fetch(new URL("/api/live", base), { headers: { cookie }, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(r.headers.get("x-accel-buffering"), "no");
    assert.match(r.headers.get("cache-control")!, /no-cache/);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (re: RegExp): Promise<string> => {
      while (!re.test(buf)) {
        const { value, done } = await reader.read();
        assert.ok(!done, `stream ended before ${re}`);
        buf += dec.decode(value);
      }
      return buf;
    };
    await until(/event: hello\ndata: (.*)\n\n/);
    const hello = JSON.parse(/event: hello\ndata: (.*)\n/.exec(buf)![1]!) as { seqs: Record<string, number> };
    assert.deepEqual(Object.keys(hello.seqs).sort(), [...TOPICS].sort());
    db.exec("UPDATE items SET title = 'again' WHERE number = 1");
    await until(/event: change\ndata: (.*)\n\n/);
    const ev = JSON.parse(/event: change\ndata: (.*)\n/.exec(buf)![1]!) as { topics: string[]; seqs: Record<string, number> };
    assert.deepEqual(ev.topics, ["items"]);
    assert.ok(ev.seqs.items! > hello.seqs.items!);
    await until(/: hb\n\n/);
    ac.abort();
  });
});
