// The autopilot planner: with the switch on it queues a job per stage that has
// work and limit left, sized to what remains of the day; off, used up, busy or
// backing off after repeated failures, it queues nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./autopilot-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { autopilotTick, backoffUntil, detectAutopilot, failureBackoff, failureDelayMs, LANES, planAutopilot, planDue, refusedAsBefore, roundRobin, setEnabled, FAIL_BACKOFF_MAX_MS, PLAN_EVERY_MS } = await import("../src/runner/autopilot.ts");
const { enqueue, JobError, RUNNER_STOPPED } = await import("../src/runner/jobs.ts");
const { Runner } = await import("../src/runner/runner.ts");
const { setMergeApproval } = await import("../src/merge/approval.ts");
type Lane = import("../src/runner/autopilot.ts").Lane;

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "autopilot-test-"));
const db = connect(join(dir, "a.db"));
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let work = true;
const lanes: Lane[] = [
  { name: "limited", detect: () => (work ? [{ step: "test-limited", params: {} }] : []) },
  { name: "plain", detect: () => [{ step: "test-plain", params: {} }] },
];
const jobs = (step: string) => db.prepare("SELECT * FROM jobs WHERE step = ? ORDER BY id").all(step) as { id: number; params: string; requested_by: string; state: string }[];
const finish = (step: string, state: "done" | "failed", items: number | null, endedAt = new Date().toISOString()) =>
  db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, ended_at, items) VALUES (?, '{}', 'pipeline', ?, ?, ?, ?, ?)")
    .run(step, endedAt, state, endedAt, endedAt, items);
/** A content change: bumps the counter of a topic the planner watches. */
const touch = (topic = "items") => db.prepare("UPDATE change_seq SET seq = seq + 1 WHERE topic = ?").run(topic);
const setLimit = (step: string, perDay: number | null) => db.prepare("INSERT OR REPLACE INTO stage_limits (step, per_day) VALUES (?, ?)").run(step, perDay);

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM stage_limits; DELETE FROM settings WHERE key LIKE 'pipeline_%' OR key = 'org_high_water'");
  touch();
  work = true;
});

// Two hours ago, but never before today's UTC midnight: usage is counted per UTC day.
const earlierToday = () => new Date(Math.max(Date.now() - 2 * 60 * 60_000, Date.parse(new Date().toISOString().slice(0, 10)) + 1000)).toISOString();

describe("autopilot", () => {
  test("a stage with work gets a job sized to the day's remaining limit", async () => {
    setLimit("test-limited", 80);
    finish("test-limited", "done", 50, earlierToday());
    const ids = await planAutopilot(db, { lanes });
    assert.equal(ids.length, 2, "one job per lane");
    const j = jobs("test-limited").at(-1)!;
    assert.equal(j.requested_by, "pipeline");
    assert.deepEqual(JSON.parse(j.params), { limit: 30 }, "min(step default 50, 80 - 50 used)");
    assert.equal(jobs("test-plain").length, 1);
  });

  test("no work, no job; a queued job of the stage blocks another", async () => {
    work = false;
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 0);
    work = true;
    await planAutopilot(db, { lanes });
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1);
  });

  test("a used-up or zero limit queues nothing for that stage while others go on", async () => {
    setLimit("test-limited", 50);
    setLimit("test-plain", 0);
    finish("test-limited", "done", 50, earlierToday());
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1, "only the finished job");
    assert.equal(jobs("test-plain").length, 0, "0 pauses the stage");
    setLimit("test-plain", null);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-plain").length, 1);
  });

  test("switched off, the tick queues nothing; switched on, it plans at once and again only when something changed", async () => {
    assert.deepEqual(await autopilotTick(db, { lanes }), []);
    setEnabled(db, true, "boss");
    assert.equal((await autopilotTick(db, { lanes })).length, 2);
    db.prepare("UPDATE jobs SET state = 'cancelled'").run();
    assert.equal((await autopilotTick(db, { lanes, nowMs: Date.now() + 60_000 })).length, 0, "nothing changed in a minute");
    touch("classify");
    assert.equal((await autopilotTick(db, { lanes, nowMs: Date.now() + 61_000 })).length, 2, "a topic change plans at once");
    db.prepare("UPDATE jobs SET state = 'cancelled'").run();
    assert.equal((await autopilotTick(db, { lanes, nowMs: Date.now() + PLAN_EVERY_MS + 120_000 })).length, 2, "the fallback timer");
    setEnabled(db, false, "boss");
    db.prepare("UPDATE jobs SET state = 'cancelled'").run();
    assert.deepEqual(await autopilotTick(db, { lanes, nowMs: Date.now() + 40 * 60_000 }), []);
  });

  test("changes the planner does not read (job logs, usage) do not wake it; a limit change does", () => {
    setEnabled(db, true, "boss");
    assert.equal(planDue(db), true);
    assert.equal(planDue(db), false);
    touch("jobs");
    touch("usage");
    touch("agents");
    assert.equal(planDue(db), false);
    setLimit("test-plain", 5);
    assert.equal(planDue(db), true, "a limit change");
    assert.equal(planDue(db), false);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pipeline_wake_at', ?)").run(new Date(Date.now() - 1000).toISOString());
    assert.equal(planDue(db), true, "a wait the last pass found has ended");
  });

  test("the review lane's repos go round robin and the cursor moves on a review", () => {
    assert.deepEqual(roundRobin(["c", "a", "b"], null), ["a", "b", "c"]);
    assert.deepEqual(roundRobin(["c", "a", "b"], "b"), ["c", "a", "b"]);
    assert.deepEqual(roundRobin(["c", "a", "b"], "c"), ["a", "b", "c"]);
    const review = LANES.find((l) => l.name === "review")!;
    review.chosen!(db, { step: "checks", params: { repo: "a" } });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'pipeline_review_cursor'").get(), undefined, "checks do not move the cursor");
    review.chosen!(db, { step: "opus-review", params: { repo: "b" } });
    const cursor = (db.prepare("SELECT value FROM settings WHERE key = 'pipeline_review_cursor'").get() as { value: string }).value;
    assert.deepEqual(roundRobin(["a", "b", "c"], cursor), ["c", "a", "b"]);
  });

  test("failed automatic jobs back off 1, 2, 4 minutes; other stages go on; a success resets", async () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(failureDelayMs), [60_000, 120_000, 240_000, 480_000, 960_000, FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MAX_MS]);
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    finish("test-limited", "failed", null, ago(30));
    let b = failureBackoff(db, "test-limited");
    assert.ok(b && b.failures === 1 && b.until > Date.now() && b.until <= Date.now() + 60_000);
    assert.equal(failureBackoff(db, "test-limited", Date.now() + 61_000), null, "a minute later it is free");
    finish("test-limited", "failed", null, ago(20));
    b = failureBackoff(db, "test-limited");
    assert.ok(b && b.failures === 2 && b.until > Date.now() + 60_000 && b.until <= Date.now() + 120_000, "the second failure waits 2 minutes");
    const logs: string[] = [];
    await planAutopilot(db, { lanes, log: (l) => logs.push(l) });
    assert.equal(jobs("test-limited").length, 2, "no new job");
    assert.equal(jobs("test-plain").length, 1);
    assert.ok(logs.some((l) => /test-limited.*failed 2 times.*retry at/.test(l)), logs.join("\n"));
    const found = await detectAutopilot(db, { lanes });
    assert.match(found.status?.["test-limited"] ?? "", /failed 2 times in a row; retry at \d\d:\d\d UTC/);
    assert.ok(found.wakeAt && found.wakeAt > Date.now(), "the planner wakes when the backoff ends");
    finish("test-limited", "failed", null, ago(10));
    assert.equal(failureBackoff(db, "test-limited")?.failures, 3);
    assert.equal(backoffUntil(db, "test-limited", Date.now() + 5 * 60_000), null, "after 4 minutes it is free");
    finish("test-limited", "done", 3, ago(5));
    assert.equal(backoffUntil(db, "test-limited"), null, "a success resets the count");
  });

  test("a changed input ends a backoff after one failure, not after two", async () => {
    setEnabled(db, true, "boss");
    const fail = (id: number) => db.prepare("UPDATE jobs SET state = 'failed', ended_at = ?, error = 'x' WHERE id = ?").run(new Date().toISOString(), id);
    await planAutopilot(db, { lanes });
    fail(jobs("test-limited")[0]!.id);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1, "same input: backing off");
    touch();
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 2, "new input: tried at once");
    fail(jobs("test-limited").at(-1)!.id);
    touch();
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 2, "second failure: new input waits out the backoff");
  });

  test("a job that handled nothing is not queued again on the same input; a changed input queues it at once", async () => {
    await planAutopilot(db, { lanes });
    const first = jobs("test-limited")[0]!;
    db.prepare("UPDATE jobs SET state = 'done', started_at = ?, ended_at = ?, items = 0 WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), first.id);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1, "same input");
    const found = await detectAutopilot(db, { lanes });
    assert.match(found.status?.["test-limited"] ?? "", /nothing to do/);
    touch("decisions");
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 2, "changed input");
  });

  test("a job that made progress without items (a batch advanced, a PR opened) counts as handled", async () => {
    await planAutopilot(db, { lanes });
    const first = jobs("test-limited")[0]!;
    db.prepare("UPDATE jobs SET state = 'done', started_at = ?, ended_at = ?, items = 0, acted = 2 WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), first.id);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 2, "queued again without a change");
  });

  test("a polling candidate runs again on an unchanged input", async () => {
    const polling: Lane[] = [{ name: "poll", detect: () => [{ step: "test-limited", params: {}, poll: true }] }];
    await planAutopilot(db, { lanes: polling });
    db.prepare("UPDATE jobs SET state = 'done', started_at = ?, ended_at = ?, items = 0").run(new Date().toISOString(), new Date().toISOString());
    await planAutopilot(db, { lanes: polling });
    assert.equal(jobs("test-limited").length, 2);
  });

  test("the rank lane runs at most once a minute while its input keeps moving", async () => {
    setEnabled(db, true, "boss");
    const rank = LANES.filter((l) => l.name === "rank");
    finish("rank", "done", 3, new Date(Date.now() - 20_000).toISOString());
    touch();
    await planAutopilot(db, { lanes: rank });
    assert.equal(jobs("rank").filter((j) => j.state === "queued").length, 0, "20 s after the last run");
    db.prepare("UPDATE jobs SET ended_at = ? WHERE step = 'rank'").run(new Date(Date.now() - 61_000).toISOString());
    touch();
    await planAutopilot(db, { lanes: rank });
    assert.equal(jobs("rank").filter((j) => j.state === "queued").length, 1, "a minute later");
  });

  test("switching off cancels the queued automatic jobs (audited) and a queued one never starts while off", async () => {
    setEnabled(db, true, "boss");
    await planAutopilot(db, { lanes });
    const manual = await enqueue(db, "test-limited", { limit: 3 }, "boss");
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(manual.id);
    const runner = new Runner({ db, dbFile: join(dir, "a.db"), logs: join(dir, "logs"), log: () => {} });
    setEnabled(db, false, "boss");
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state) VALUES ('test-plain', '{}', 'pipeline', ?, 'queued')").run(new Date().toISOString());
    await runner.tick();
    assert.equal(db.prepare("SELECT state FROM jobs WHERE requested_by = 'pipeline' AND state = 'queued'").all().length, 1, "left queued, not started");
    assert.equal(runner.running.size, 0);
    db.prepare("DELETE FROM jobs WHERE requested_by = 'pipeline' AND state = 'queued'").run();
    setEnabled(db, true, "boss");
    await planAutopilot(db, { lanes });
    setEnabled(db, false, "boss");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE requested_by = 'pipeline' AND state = 'queued'").get() as { n: number }).n, 0);
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'job-cancel' AND login = 'boss'").get() as { n: number }).n >= 1);
    assert.equal(jobs("test-limited").find((j) => j.id === manual.id)!.state, "running", "running jobs are left alone");
    await runner.stop();
  });

  test("jobs a runner stop ended do not count toward backoff", () => {
    for (let i = 0; i < 3; i++) {
      finish("test-limited", "failed", null, new Date(Date.now() - 30_000 - i * 1000).toISOString());
    }
    db.prepare("UPDATE jobs SET error = ?").run(RUNNER_STOPPED);
    assert.equal(backoffUntil(db, "test-limited"), null);
  });

  test("an operator release ends the released stage's backoff and makes the planner due", () => {
    for (let i = 0; i < 3; i++) finish("merge", "failed", null, new Date(Date.now() - 30_000 - i * 1000).toISOString());
    assert.ok(backoffUntil(db, "merge") !== null);
    setEnabled(db, true, "boss");
    assert.equal(planDue(db), true, "first plan");
    assert.equal(planDue(db), false);
    db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, 'boss', 'batch-again', 'a#1', '{}')").run(new Date(Date.now() + 1000).toISOString());
    assert.equal(backoffUntil(db, "merge"), null);
    assert.equal(planDue(db, Date.now() + 2000), true, "the release wakes the planner");
    db.exec("DELETE FROM audit WHERE action = 'batch-again'");
  });

  test("a PR refused at its head waits until its CI or mergeable state differs from the refusal", () => {
    const entry = { repo: "photocraft", number: 7, head: "abc", state: "refused", ci: "success", mergeable: "MERGEABLE" };
    db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, outcome, reason, ci, mergeable) VALUES ('photocraft', 7, 'abc', 'r', '2026-11-01T00:00:00Z', 'rule', 'refused', 'x', 'success', 'MERGEABLE')").run();
    assert.equal(refusedAsBefore(db, entry), true);
    assert.equal(refusedAsBefore(db, { ...entry, ci: "pending" }), false);
    assert.equal(refusedAsBefore(db, { ...entry, mergeable: "CONFLICTING" }), false);
    assert.equal(refusedAsBefore(db, { ...entry, head: "def" }), false, "a new head is a new PR state");
    assert.equal(refusedAsBefore(db, { ...entry, state: "ready" }), false);
  });

  test("the merge step refuses a repo an operator has not approved for merging", async () => {
    await assert.rejects(enqueue(db, "merge", { repo: "photocraft" }, "pipeline"), (e: Error) => e instanceof JobError && /not approved/.test(e.message));
    setMergeApproval(db, "boss", "photocraft", true);
    const job = await enqueue(db, "merge", { repo: "photocraft" }, "pipeline");
    assert.equal(job.state, "queued");
    setMergeApproval(db, "boss", "photocraft", false);
    db.prepare("DELETE FROM jobs").run();
    await assert.rejects(enqueue(db, "merge", { repo: "photocraft" }, "boss"), JobError);
  });

  test("checks accept only no limit or 0 as a daily limit", async () => {
    const { setLimit, LimitError } = await import("../src/runner/autopilot.ts");
    assert.throws(() => setLimit(db, "checks", { perDay: 10 }, "boss"), LimitError);
    setLimit(db, "checks", { perDay: 0 }, "boss");
    setLimit(db, "checks", { perDay: null }, "boss");
  });
});
