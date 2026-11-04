// GET /api/queue/batches: newest-first paging, member rows in batch order, and the fork the branch link needs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";
import { insertBatch, updateBatch } from "../src/merge/batch-store.ts";
import { queue, queueBatches } from "../src/dash/api/queue.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const T = "2026-01-01T00:00:00Z";
const req = (query: string): Req =>
  ({ method: "GET", path: "/", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true }, csrf: "", nonce: "" });

test("batches page newest first with their member rows, fork link and base commit", async () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "qb-")), "t.db"));
  for (const r of ["app", "lib"]) db.prepare("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(r);
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES (?, ?, 'pr', 'OPEN', ?, 'a', ?, ?, ?)");
  const review = db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, verdict, reason, sure, mode) VALUES (?, ?, ?, 'r', ?, 'take', 'ok', 1, 'full')");
  for (const n of [1, 2, 3]) { item.run("app", n, `PR ${n}`, `h${n}`, T, T); review.run("app", n, `h${n}`, T); }
  const members = (...ns: number[]) => ns.map((n) => ({ number: n, head_oid: `h${n}` }));
  const make = (repo: string, branch: string, ms: number[]) => insertBatch(db, { repo, branch, baseSha: "b".repeat(40), commitSha: "c".repeat(40), parentId: null, taskId: null, members: members(...ms), at: T });
  const old = make("app", "integration-app-20260101-1", [1]);
  const pushed = make("app", "integration-app-20260101-2", [3, 2]);
  const checking = make("app", "integration-app-20260101-3", [1]);
  make("lib", "integration-lib-20260101-1", []);
  updateBatch(db, pushed, T, { state: "open", fork: "bot/app", pr_number: 9, pr_url: "https://github.com/storytold/app/pull/9" });
  // A batch pushed before the fork was stored: its audit row names it.
  updateBatch(db, old, T, { state: "merged" });
  db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, 'bot', 'batch-push', 'app:integration-app-20260101-1', ?)").run(T, JSON.stringify({ fork: "bot/app" }));

  refreshPlanCache(db);
  const first = await queueBatches(db, req("repo=app&limit=2"));
  assert.equal(first.total, 3);
  assert.deepEqual(first.batches.map((b) => b.id), [checking, pushed]);
  assert.equal(first.next, String(pushed));
  const [c, p] = first.batches;
  assert.equal(c!.fork, null);
  assert.equal(p!.fork, "bot/app");
  assert.equal(p!.baseSha, "b".repeat(40));
  assert.equal(p!.prNumber, 9);
  assert.deepEqual(p!.prs.map((r) => r.number), [3, 2]);
  assert.equal(p!.size, 2);

  const second = await queueBatches(db, req(`repo=app&limit=2&after=${first.next}`));
  assert.deepEqual(second.batches.map((b) => b.id), [old]);
  assert.equal(second.next, null);
  assert.equal(second.batches[0]!.fork, "bot/app");

  // PRs in a batch in flight are listed under it, not in the PR list, unless a state filter asks for them.
  const list = await queue(db, req("repo=app"));
  assert.deepEqual(list.rows.map((r) => r.number), []);
  assert.equal(list.total, 0);
  updateBatch(db, checking, T, { state: "merged" });
  refreshPlanCache(db);
  assert.deepEqual((await queue(db, req("repo=app"))).rows.map((r) => r.number), [1]);

  assert.equal((await queueBatches(db, req(""))).total, 4);
  await assert.rejects(async () => queueBatches(db, req("after=x")), /batch id/);
});
