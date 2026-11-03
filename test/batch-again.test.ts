// Operator release "Try the batch again": a PR held by a failed single-PR batch goes back to the merge queue.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { batchStates, insertBatch, updateBatch } from "../src/merge/batch-store.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { ActionError, actionsOf, batchAgain } from "../src/operator-actions.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "batch-again-"));
const T = "2026-01-01T00:00:00Z";

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  db.prepare("INSERT INTO tracked_repos (name) VALUES ('app')").run();
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T);
  for (const n of [1, 2]) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, labels, created_at, updated_at)
      VALUES ('app', ?, 'pr', 'OPEN', 'Item', 'regular', 20, 0, ?, '[]', '${T}', '${T}')`).run(n, `sha${n}`);
    db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('app', ?, ?, 'rv', '${T}', 'm', 'S', 'take', 'ok')`).run(n, `sha${n}`);
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
      VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T}')`).run(n, `sha${n}`);
    db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T}', 'bugfix', '[]', '{"top":0.95}')`).run(n);
    db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', ?, ?, 'tests', 'r', 'passed', '${T}')`).run(n, `sha${n}`);
  }
  finalizeReviews(db);
  return db;
}

function failedBatch(db: DatabaseSync, n: number, summary: string): number {
  const id = insertBatch(db, { repo: "app", branch: `integration-app-20260101-${n}`, baseSha: "m", commitSha: "c", parentId: null, taskId: null, members: [{ number: n, head_oid: `sha${n}` }], at: T });
  updateBatch(db, id, T, { state: "failed", summary });
  return id;
}

const stateOf = (db: DatabaseSync, n: number) => buildQueue(db, { run: "r1" }).find((e) => e.number === n)!.state;

test("batchAgain releases a PR held by its failed single batch and audits it", () => {
  const db = fresh();
  const id = failedBatch(db, 1, "sandbox could not write /src");
  assert.equal(batchStates(db).get("app#1@sha1"), "batch-failed");
  assert.equal(stateOf(db, 1), "batch-failed");
  assert.equal(actionsOf(db, "app", 1).batchAgain, true);
  assert.equal(actionsOf(db, "app", 2).batchAgain, false);

  batchAgain(db, "op", "app", 1);

  assert.notEqual(stateOf(db, 1), "batch-failed");
  assert.equal(actionsOf(db, "app", 1).batchAgain, false);
  const b = db.prepare("SELECT state, summary FROM main.merge_batches WHERE id = ?").get(id) as { state: string; summary: string };
  assert.deepEqual({ ...b }, { state: "superseded", summary: "sandbox could not write /src" });
  const a = db.prepare("SELECT login, target, details FROM audit WHERE action = 'batch-again'").get() as { login: string; target: string; details: string };
  assert.equal(a.login, "op");
  assert.equal(a.target, "app#1");
  assert.deepEqual({ head: JSON.parse(a.details).head, summary: JSON.parse(a.details).summary }, { head: "sha1", summary: "sandbox could not write /src" });
});

test("batchAgain on a PR that is not batch-failed is a 409", () => {
  const db = fresh();
  failedBatch(db, 1, "x");
  assert.throws(() => batchAgain(db, "op", "app", 2), (e) => e instanceof ActionError && e.status === 409);
  batchAgain(db, "op", "app", 1);
  assert.throws(() => batchAgain(db, "op", "app", 1), (e) => e instanceof ActionError && e.status === 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'batch-again'").get()!.n, 1);
});
