// Read paths that must stay cheap at scale: the item_stage table behind "latest
// stage per item", and keyset paging of the merge queue and the decision list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { DecisionList, QueueList } from "../web/src/api/types.ts";
import { connect } from "../src/db.ts";
import { ask } from "../src/decisions.ts";
import { listDecisions } from "../src/dash/api/decisions.ts";
import { queue } from "../src/dash/api/queue.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { toBlob } from "../src/embed/store.ts";
import type { Req } from "../src/dash/types.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "reads-test-"));
const fresh = (): DatabaseSync => connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
const req = (query: string): Req =>
  ({ method: "GET", path: "/", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), user: { login: "op", role: "operator", canWrite: async () => true }, csrf: "", nonce: "" });

describe("item_stage", () => {
  const stage = (db: DatabaseSync, n: number, s: string, at: string) =>
    db.prepare("INSERT INTO stages (repo, number, stage, at) VALUES ('app', ?, ?, ?)").run(n, s, at);
  const latest = (db: DatabaseSync, n: number) => db.prepare("SELECT stage, at, reviewed FROM item_stage WHERE repo = 'app' AND number = ?").get(n);

  test("the trigger keeps the latest stage, also for out-of-order and same-time inserts", () => {
    const db = fresh();
    stage(db, 1, "classified", "2026-01-01T00:00:00Z");
    stage(db, 1, "take", "2026-01-03T00:00:00Z");
    stage(db, 1, "reviewed", "2026-01-02T00:00:00Z"); // older than take: take stays
    assert.deepEqual({ ...latest(db, 1) }, { stage: "take", at: "2026-01-03T00:00:00Z", reviewed: 1 });
    stage(db, 2, "take", "2026-01-01T00:00:00Z");
    stage(db, 2, "merged", "2026-01-01T00:00:00Z"); // same time: the newer insert wins, as the rowid tie-break did
    assert.deepEqual({ ...latest(db, 2) }, { stage: "merged", at: "2026-01-01T00:00:00Z", reviewed: 0 });
  });

  test("the first connect fills it from existing stages", () => {
    const path = join(mkdtempSync(join(dir, "db-")), "old.db");
    const db = connect(path);
    stage(db, 1, "classified", "2026-01-01T00:00:00Z");
    stage(db, 1, "reviewed", "2026-01-02T00:00:00Z");
    stage(db, 1, "hold", "2026-01-01T12:00:00Z");
    db.exec("DELETE FROM item_stage; DELETE FROM settings WHERE key IN ('item_stage_built', 'schema_stamp')");
    db.close();
    assert.deepEqual({ ...latest(connect(path), 1) }, { stage: "reviewed", at: "2026-01-02T00:00:00Z", reviewed: 1 });
  });
});

describe("keyset paging", () => {
  test("the queue pages by repo and number, and lists merged PRs only on request", async () => {
    const db = fresh();
    db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app')").run();
    const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES ('app', ?, 'pr', ?, ?, 'a', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    const review = db.prepare("INSERT INTO reviews (repo, number, head_oid, run_id, at, size, verdict, reason) VALUES ('app', ?, ?, 'r', '2026-01-01T00:00:00Z', 'S', 'take', 'ok')");
    for (let n = 1; n <= 5; n++) { item.run(n, "OPEN", `PR ${n}`, `h${n}`); review.run(n, `h${n}`); }
    for (let n = 6; n <= 8; n++) { item.run(n, "MERGED", `PR ${n}`, `h${n}`); review.run(n, `h${n}`); }
    const get = (q: string) => queue(db, req(q));
    const seen: number[] = [];
    let page: QueueList = get("limit=2");
    assert.equal(page.total, 5);
    assert.equal(page.counts.merged, 3);
    for (;;) {
      seen.push(...page.rows.map((r) => r.number));
      if (!page.next) break;
      page = get(`limit=2&after=${encodeURIComponent(page.next)}`);
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    const merged = get("state=merged&limit=2");
    assert.deepEqual(merged.rows.map((r) => r.number), [6, 7]);
    assert.deepEqual(get(`state=merged&limit=2&after=${encodeURIComponent(merged.next!)}`).rows.map((r) => r.number), [8]);
    assert.equal(get("state=merged&limit=2&after=app%238").next, null);
  });

  test("decisions page in SQL by asked time, with filters and whole-list counts", async () => {
    const db = fresh();
    db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app'), ('other')").run();
    const opts = [{ key: "a", label: "A" }, { key: "b", label: "B" }];
    ask(db, [1, 2, 3, 4, 5].map((n) => ({
      id: `app#${n}:scope`, kind: n % 2 ? "scope" : "close", repo: n === 5 ? "other" : "app", number: n, question: "Q?", options: opts,
      asked_at: `2026-01-0${6 - n}T00:00:00Z`,
    })));
    const get = (q: string, mine: string[] = ["app"]): Promise<DecisionList> => listDecisions(db, req(q), async () => mine);
    const ids: string[] = [];
    let page = await get("limit=2");
    assert.equal(page.total, 5);
    assert.equal(page.oldestAskedAt, "2026-01-01T00:00:00Z");
    assert.deepEqual(page.byKind, { scope: 3, close: 2 });
    for (;;) {
      ids.push(...page.decisions.map((d) => d.id));
      if (!page.next) break;
      page = await get(`limit=2&after=${encodeURIComponent(page.next)}`);
    }
    assert.deepEqual(ids, ["app#5:scope", "app#4:scope", "app#3:scope", "app#2:scope", "app#1:scope"]);
    const app = await get("repo=app");
    assert.equal(app.total, 4);
    assert.equal((await get("mine=1", ["other"])).total, 1);
    assert.equal((await get("kind=close&repo=app")).total, 2);
    db.prepare("UPDATE decisions SET answer = 'a', answered_by = 'op', answered_at = ? WHERE id = ?").run("2026-02-01T00:00:00Z", "app#2:scope");
    db.prepare("UPDATE decisions SET answer = 'a', answered_by = 'op', answered_at = ? WHERE id = ?").run("2026-02-02T00:00:00Z", "app#3:scope");
    const done = await get("status=answered&limit=1");
    assert.deepEqual(done.decisions.map((d) => d.id), ["app#3:scope"]);
    assert.deepEqual((await get(`status=answered&limit=1&after=${encodeURIComponent(done.next!)}`)).decisions.map((d) => d.id), ["app#2:scope"]);
  });
});

describe("vector index", () => {
  test("loads incrementally, takes rewritten rows, and finds the nearest by cosine", async () => {
    const db = fresh();
    db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app')").run();
    const dim = 8;
    const unit = (i: number): Float32Array => { const v = new Float32Array(dim); v[i % dim] = 1; return v; };
    const put = db.prepare("INSERT OR REPLACE INTO item_embeddings (repo, number, model, hash, vec, at) VALUES ('app', ?, 'm', 'h', ?, 't')");
    for (let i = 0; i < 3; i++) put.run(i, toBlob(unit(i)));
    const idx = new VectorIndex({ id: "m", dim, embed: async () => [] } as never);
    await idx.ready(db);
    assert.equal(idx.size, 3);
    assert.equal(idx.nearest(db, unit(1), 1)[0]!.number, 1);
    put.run(10, toBlob(unit(5)));
    put.run(0, toBlob(unit(6))); // rewritten: same slot, new content
    (idx as unknown as { checked: number }).checked = 0;
    idx.refresh(db);
    await (idx as unknown as { job: Promise<void> }).job;
    assert.equal(idx.size, 4);
    assert.equal(idx.nearest(db, unit(5), 1)[0]!.number, 10);
    const hit = idx.nearest(db, unit(6), 1)[0]!;
    assert.equal(hit.number, 0);
    assert.ok(Math.abs(hit.score - 1) < 0.01);
  });
});
