import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../src/db.ts";
import { buildKind, live } from "../src/dash/api/live.ts";
import type { Req } from "../src/dash/types.ts";

const req = { query: new URLSearchParams(), user: { role: "operator", login: "o", canRead: async () => true } } as unknown as Req;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("the live board shows a running job with its call and build steps, an estimate from earlier runs, and drops idle ended jobs", async () => {
  const db = connect(":memory:");
  db.prepare("INSERT INTO items (repo, number, kind, state, title, updated_at) VALUES ('app', 7, 'pr', 'OPEN', 'Fix the thing', ?)").run(ago(1));
  const job = db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, ended_at, progress, summary) VALUES (?, '{}', 'pipeline', ?, ?, ?, ?, ?, ?)");
  // Earlier review jobs of 10, 12, 14 and 30 minutes and the 1-minute one below give the estimate.
  for (const m of [10, 12, 14, 30]) job.run("review", ago(200), "done", ago(200), ago(200 - m), null, "old");
  const running = Number(job.run("review", ago(5), "running", ago(5), null, "Reviewing app#7", null).lastInsertRowid);
  job.run("review", ago(3), "done", ago(4), ago(3), null, "nothing to do");
  db.prepare("INSERT INTO job_items (job_id, repo, number, at) VALUES (?, 'app', 7, ?)").run(running, ago(5));
  db.prepare(`INSERT INTO agent_runs (job_id, step, stage, prompt_id, prompt_version, provider, model, items, item_count, state, started_at, ended_at)
    VALUES (?, 'review', 1, 'p', '1', 'claude', 'opus', '[]', 1, 'done', ?, ?)`).run(running, ago(5), ago(4));
  const task = db.prepare(`INSERT INTO build_tasks (job_id, step, repo, number, head_sha, requires, plan, state, queued_at, started_at, ended_at, results)
    VALUES (?, 'verify', 'app', 7, 'abc', '{}', '[]', ?, ?, ?, ?, ?)`);
  task.run(running, "done", ago(4), ago(4), ago(2), JSON.stringify([{ step: "install", exitCode: 0, durationMs: 30_000, timedOut: false }, { step: "test", exitCode: 1, durationMs: 60_000, timedOut: false }]));

  const { lanes } = await live(db, req);
  const lane = lanes.find((l) => l.key === `job:${running}`)!;
  assert.equal(lane.state, "running");
  assert.equal(lane.line, "Reviewing app#7");
  assert.equal(lane.item?.title, "Fix the thing");
  assert.deepEqual(lane.estimate && { median: Math.round(lane.estimate.median / 60_000), samples: lane.estimate.samples }, { median: 12, samples: 5 });
  assert.deepEqual(lane.ops.map((o) => [o.kind, o.label, !!o.failed]), [["model", "opus", false], ["setup", "install", false], ["tests", "test", true]]);
  // The ended job touched no item: it is left out.
  assert.equal(lanes.length, 1);
});

test("build steps are sorted into kinds by name", () => {
  assert.deepEqual(["npm ci", "cargo build", "cargo test", "clippy", "tsc", "deploy"].map(buildKind), ["setup", "build", "tests", "lint", "lint", "other"]);
});
