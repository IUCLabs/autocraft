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
  const pj = job("photocraft", 1);
  job("secretcraft", 2);
  const run = insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 1 }], prompt: "x" });
  db.prepare("UPDATE agent_runs SET job_id = ? WHERE id = ?").run(pj, run);
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
  const call = j.children.find((r) => r.key === `run:${run}`)!;
  assert.ok(!op.running.some((r) => r.key === `run:${run}`), "the call is nested under its job, not listed twice");
  assert.equal(call.event, `run:${run}`);
  assert.equal(call.detail, `/agents/${run}`);
  const sy = op.health.problems.find((p) => p.area === "sync")!;
  assert.equal(sy.tone, "bad");
  assert.match(sy.text, /HTTP 502/);

  const viewer = await now(db, req("viewer"));
  assert.ok(!JSON.stringify(viewer).includes("secretcraft"), "nothing of the private repo");
  assert.deepEqual(viewer.running.map((r) => [r.kind, r.children.length]), [["job", 1]], "the visible job with its call nested");

  // A failed job and a failed model call: staff read the error text, viewers only that it failed.
  const fj = db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, ended_at, error, repo) VALUES ('opus-review', '{}', 'pipeline', ?, 'failed', ?, 'exit 1: token ghp_xyz leaked', 'photocraft')").run(at(3), at(2));
  db.prepare("UPDATE agent_runs SET state = 'failed', ended_at = ?, error = 'stack: boom in /srv/app' WHERE id = ?").run(at(1), run);
  const texts = (n: Awaited<ReturnType<typeof now>>) => JSON.stringify(n.recent.filter((e) => e.kind === "failure").map((e) => e.summary));
  const staff = texts(await now(db, req("operator")));
  assert.ok(staff.includes("ghp_xyz") && staff.includes("boom"), staff);
  const plain = texts(await now(db, req("viewer")));
  assert.ok(!/ghp_xyz|boom/.test(plain) && /failed/.test(plain), plain);
  void fj;
});

test("Now groups same-action writes into one row, leaves out housekeeping, and shows red mains only for pipeline repos", async () => {
  const db = connect(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  db.exec("INSERT OR REPLACE INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('wordcraft', 'public')");
  db.exec("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft'), ('wordcraft')");
  db.exec("UPDATE tracked_repos SET pipeline = 1 WHERE name = 'photocraft'");
  const audit = db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, 'autocraft', ?, ?, '{}')");
  for (let n = 1; n <= 5; n++) audit.run(at(10 - n), "review-post", `photocraft#${n}`);
  for (let n = 1; n <= 20; n++) audit.run(at(3), "unassign", `photocraft#${n}`);
  audit.run(at(2), "ci-run-approve", "photocraft#1");
  audit.run(at(30), "act-close", "photocraft#9");

  const op = await now(db, req("operator"));
  assert.deepEqual(op.recent.map((e) => e.summary), ["Posted 5 reviews", "Closed"], "one grouped row, no assign, unassign or CI approval rows");
  const g = op.recent[0]!;
  assert.equal(g.items!.length, 3);
  assert.equal(g.more, 2);

  const red = db.prepare("INSERT INTO main_ci (repo, head_sha, branch, state, failing, checks, first_seen_at, state_changed_at, updated_at, committed_at) VALUES (?, 'abc', 'main', 'red', '[]', '[]', ?, ?, ?, ?)");
  for (const repo of ["photocraft", "wordcraft"]) red.run(repo, at(5), at(5), at(1), at(6));
  const mains = (await now(db, req("operator"))).health.problems.filter((p) => p.area === "main-ci").map((p) => p.id);
  assert.deepEqual(mains, ["main-ci:photocraft"], "a repo with the pipeline off is not reported");
  assert.ok(!(await now(db, req("operator"))).health.problems.some((p) => p.area === ("repos" as string)), "no pipeline-off-for-repos chip");
});

test("Now hides a just-started job with nothing to show and lists quiet jobs on one line", async () => {
  const db = connect(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const job = db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, progress) VALUES (?, '{}', 'pipeline', ?, 'running', ?, ?)");
  job.run("unassign", at(1), at(1), null);
  job.run("rank", at(1), at(1), null);
  job.run("embed", at(1), at(1), "embedding");
  job.run("embed", at(9), at(9), null);
  const r = await now(db, req("operator"));
  assert.deepEqual(r.running.map((x) => x.step), ["Embed items"], "only the quiet job that runs long keeps a row");
  assert.deepEqual(r.alsoRunning, ["Embed items", "Rank open items"]);
});
