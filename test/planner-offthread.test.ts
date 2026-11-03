// The planner at scale: detection runs off the runner's loop (a slow pass never delays the
// heartbeat or cancels) and every pass resolves the classification run once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./autopilot-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { LANES, planCtx, setEnabled } = await import("../src/runner/autopilot.ts");
const { HEARTBEAT_KEY, Runner } = await import("../src/runner/runner.ts");
const { selectCandidates } = await import("../src/review/candidates.ts");
const { buildQueue } = await import("../src/merge/queue.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "planner-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const T0 = "2026-01-01T00:00:00.000Z";

describe("planner off the runner loop", () => {
  test("a slow detection does not delay ticks; one pass at a time; its result is queued by a later tick", async () => {
    const file = join(dir, "slow.db");
    const db = connect(file);
    db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
    setEnabled(db, true, "boss");
    let calls = 0;
    const detect = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 400));
      return { proposals: [{ lane: "plain", step: "test-plain", params: {} }], logs: [] };
    };
    const runner = new Runner({ db, dbFile: file, logs: join(dir, "logs"), maxJobs: 0, log: () => {}, detect, refreshFlow: async () => [] });
    const beat = () => (db.prepare("SELECT value FROM settings WHERE key = ?").get(HEARTBEAT_KEY) as { value: string }).value;
    const durations: number[] = [];
    const beats = new Set<string>();
    const end = Date.now() + 700;
    while (Date.now() < end) {
      const t = Date.now();
      await runner.tick();
      durations.push(Date.now() - t);
      beats.add(beat());
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(Math.max(...durations) < 150, `ticks took ${durations.join(",")} ms while detection ran`);
    assert.ok(beats.size >= 5, "the heartbeat kept moving");
    assert.equal(calls, 1, "one detection in flight");
    await new Promise((r) => setTimeout(r, 100));
    await runner.tick();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE step = 'test-plain' AND requested_by = 'pipeline'").get() as { n: number }).n, 1);
    await runner.stop();
    db.close();
  });

  test("the default detection runs on a worker thread with its own connection and finds the work", async () => {
    const file = join(dir, "worker.db");
    const db = connect(file);
    db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
    setEnabled(db, true, "boss");
    const logs: string[] = [];
    const runner = new Runner({ db, dbFile: file, logs: join(dir, "logs"), maxJobs: 0, log: (l) => logs.push(l), refreshFlow: async () => [] });
    await runner.tick();
    const pass = runner["planning"];
    assert.ok(pass, "a pass started");
    await pass;
    assert.ok(runner["detected"], "the worker answered");
    await runner.tick();
    assert.deepEqual(logs.filter((l) => /failed/.test(l)), []);
    await runner.stop();
    db.close();
  });
});

describe("classification run resolved once", () => {
  const RUN_QUERY = /FROM classifications WHERE classifier = 'jev' ORDER BY at DESC/;

  function counting(db: ReturnType<typeof connect>): { db: ReturnType<typeof connect>; runLookups: () => number } {
    let n = 0;
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { if (RUN_QUERY.test(sql)) n++; return target.prepare(sql); };
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { db: proxy, runLookups: () => n };
  }

  test("review candidates and the merge queue with a given run never look the run up; a pass looks it up once per kind", () => {
    const db = connect(join(dir, "run.db"));
    db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
    for (let n = 1; n <= 30; n++) {
      db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, additions, deletions, changed_files, head_oid, created_at, updated_at)
        VALUES ('app', ?, 'pr', 'OPEN', 't', 'b', 0, 5, 0, 1, ?, '${T0}', '${T0}')`).run(n, `sha${n}`);
      db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run(n);
    }
    const c = counting(db);
    assert.equal(selectCandidates(c.db, "app", "r1").length, 30);
    buildQueue(c.db, { run: "r1" });
    assert.equal(c.runLookups(), 0, "the run passed in is used for every PR");
    selectCandidates(c.db, "app");
    assert.equal(c.runLookups(), 1, "without one, a single lookup for the whole repo");
    const ctx = planCtx(c.db);
    assert.equal(ctx.run, "r1");
    for (const lane of LANES) lane.detect(c.db, ctx);
    assert.equal(c.runLookups(), 3, "planCtx: current run and newest Jev run, then the lanes reuse them");
    db.close();
  });
});

describe("jobs table at scale", () => {
  test("repo is filled at enqueue and backfilled on an old database; finished jobs older than 90 days are pruned with their logs", async () => {
    const { enqueue, pruneJobs, JOB_KEEP_MS } = await import("../src/runner/jobs.ts");
    const { writeFileSync, existsSync } = await import("node:fs");
    const file = join(dir, "jobs.db");
    let db = connect(file);
    db.prepare("INSERT INTO repos (name, synced_at) VALUES ('app', ?)").run(T0);
    db.prepare("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
    const job = await enqueue(db, "test-limited", { limit: 5 }, "boss");
    assert.equal(job.params.limit, 5);
    const old = new Date(Date.now() - JOB_KEEP_MS - 1000).toISOString();
    const log = join(dir, "old.log");
    writeFileSync(log, "x");
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, ended_at, log_path) VALUES ('test-plain', '{\"repo\":\"app\"}', 'pipeline', ?, 'done', ?, ?)").run(old, old, log);
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, ended_at) VALUES ('test-plain', '{}', 'pipeline', ?, 'queued', NULL)").run(old);
    assert.equal(pruneJobs(db), 1, "only the finished old job");
    assert.equal(existsSync(log), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 2);
    // an old database: the column is empty until the next migration
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state) VALUES ('merge', '{\"repo\":\"app\"}', 'cli', ?, 'queued')").run(T0);
    db.prepare("DELETE FROM settings WHERE key = 'schema_stamp'").run();
    db.close();
    db = connect(file);
    assert.equal((db.prepare("SELECT repo FROM jobs WHERE step = 'merge'").get() as { repo: string }).repo, "app");
    db.close();
  });
});
