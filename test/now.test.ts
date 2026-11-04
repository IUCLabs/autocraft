import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun } from "../src/agents/runs.ts";
import { connect } from "../src/db.ts";
import { now } from "../src/dash/api/now.ts";
import type { Req } from "../src/dash/types.ts";

const req = (role: "operator" | "viewer"): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(),
  user: { login: role, role, canWrite: async () => false, canRead: async () => false }, csrf: "", nonce: "",
} as unknown as Req);

test("Now lists running work with its items, reports a failing sync, and hides a private repo from a viewer", async () => {
  const db = connect(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  db.exec("INSERT OR REPLACE INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('secretcraft', 'private')");
  db.exec("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft'), ('secretcraft')");
  for (const [repo, n] of [["photocraft", 1], ["secretcraft", 2]] as const) {
    db.prepare("INSERT INTO items (repo, number, kind, state, title, author) VALUES (?, ?, 'pr', 'OPEN', ?, 'dev')").run(repo, n, `Title ${n}`);
  }
  const job = (repo: string, n: number) => {
    const id = Number(db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, progress, repo) VALUES ('opus-review', '{}', 'pipeline', ?, 'running', ?, 'reviewing 1 of 1', ?)")
      .run(at(5), at(5), repo).lastInsertRowid);
    db.prepare("INSERT INTO job_items (job_id, repo, number, at) VALUES (?, ?, ?, ?)").run(id, repo, n, at(4));
    return id;
  };
  job("photocraft", 1);
  job("secretcraft", 2);
  const run = insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 1 }], prompt: "x" });
  insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "secretcraft", number: 2 }], prompt: "x" });
  const sync = db.prepare("INSERT INTO sync_runs (started_at, ended_at, mode, items, error) VALUES (?, ?, 'full', 0, ?)");
  sync.run(at(40), at(39), null);
  for (const m of [30, 20, 10]) sync.run(at(m), at(m - 1), "HTTP 502 from GitHub");

  const op = await now(db, req("operator"));
  assert.equal(op.running.filter((r) => r.kind === "job").length, 2);
  const j = op.running.find((r) => r.kind === "job" && r.repo === "photocraft")!;
  assert.deepEqual(j.items.map((i) => `${i.repo}#${i.number}`), ["photocraft#1"]);
  assert.match(j.event!, /^job:\d+$/);
  assert.equal(j.progress, "reviewing 1 of 1");
  const call = op.running.find((r) => r.key === `run:${run}`)!;
  assert.equal(call.event, `run:${run}`);
  assert.equal(call.detail, `/agents/${run}`);
  const sy = op.health.problems.find((p) => p.area === "sync")!;
  assert.equal(sy.tone, "bad");
  assert.match(sy.text, /HTTP 502/);

  const viewer = await now(db, req("viewer"));
  assert.ok(!JSON.stringify(viewer).includes("secretcraft"), "nothing of the private repo");
  assert.equal(viewer.running.length, 2, "the visible job and the visible call");
});
