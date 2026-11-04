// The planner's Plan cache (item_plans) and what a pass writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { detectAutopilot, setEnabled } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-cache-"));
const T0 = "2026-01-01T00:00:00Z";

describe("Plan cache", () => {
  const db = connect(join(dir, "t.db"));
  db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
  const add = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', 't', 'b', 0, '${T0}', '${T0}')`);
  add.run(1); add.run(2);
  db.exec("UPDATE items SET embed_hash = NULL");
  setEnabled(db, true, "op");
  const cache = () => db.prepare("SELECT number, kind, state, actions FROM item_plans ORDER BY number").all() as { number: number; kind: string; state: string; actions: string }[];
  const seq = () => (db.prepare("SELECT seq FROM change_seq WHERE topic = 'plans'").get() as { seq: number }).seq;

  test("a pass writes one row per item, writes nothing else, and writes only changed rows the next time", async () => {
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = db.prepare("SELECT COUNT(*) AS n FROM items WHERE embed_hash IS NULL").get() as { n: number };
    const first = await detectAutopilot(db);
    assert.equal(first.timing!.written, 2);
    assert.deepEqual(cache().map((r) => [r.number, r.kind]), [[1, "issue"], [2, "issue"]]);
    assert.ok(JSON.parse(cache()[0]!.actions).some((a: { kind: string }) => a.kind === "embed"), "the embed action is cached");
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM items WHERE embed_hash IS NULL").get(), before, "planning fills no hashes");
    const s = seq();
    const n = changes();
    const second = await detectAutopilot(db);
    assert.deepEqual([second.timing!.written, second.timing!.deleted], [0, 0]);
    assert.equal(changes(), n, "an unchanged pass writes nothing");
    assert.equal(seq(), s);
  });

  test("a changed item rewrites its row only, and an item that closed leaves the cache", async () => {
    db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 2").run();
    const r = await detectAutopilot(db);
    assert.deepEqual([r.timing!.written, r.timing!.deleted], [0, 1]);
    assert.deepEqual(cache().map((x) => x.number), [1]);
  });
});
