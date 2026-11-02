// The autopilot planner: with the switch on it queues a job per stage that has
// work and limit left, sized to what remains of the day; off, used up, busy or
// backing off after repeated failures, it queues nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.CRAFT_AUTO_EXTRA_STEPS = fileURLToPath(new URL("./autopilot-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { autopilotTick, backoffUntil, LANES, planAutopilot, roundRobin, setEnabled, BACKOFF_MS, COOLDOWN_MS } = await import("../src/runner/autopilot.ts");
type Lane = import("../src/runner/autopilot.ts").Lane;

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
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
const setLimit = (step: string, perDay: number | null) => db.prepare("INSERT OR REPLACE INTO stage_limits (step, per_day) VALUES (?, ?)").run(step, perDay);

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM stage_limits; DELETE FROM settings WHERE key LIKE 'pipeline_%' OR key = 'org_high_water'");
  work = true;
});

describe("autopilot", () => {
  test("a stage with work gets a job sized to the day's remaining limit", async () => {
    setLimit("test-limited", 80);
    finish("test-limited", "done", 50, new Date(Date.now() - 2 * COOLDOWN_MS).toISOString());
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
    finish("test-limited", "done", 50, new Date(Date.now() - 2 * COOLDOWN_MS).toISOString());
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1, "only the finished job");
    assert.equal(jobs("test-plain").length, 0, "0 pauses the stage");
    setLimit("test-plain", null);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-plain").length, 1);
  });

  test("switched off, the tick queues nothing; switched on, it plans after a sync and not again until something changes", async () => {
    assert.deepEqual(await autopilotTick(db, { lanes }), []);
    setEnabled(db, true, "boss");
    db.prepare("INSERT INTO settings (key, value) VALUES ('org_high_water', 't1')").run();
    assert.equal((await autopilotTick(db, { lanes })).length, 2);
    assert.equal((await autopilotTick(db, { lanes })).length, 0, "nothing changed");
    db.prepare("UPDATE jobs SET state = 'cancelled'").run();
    assert.equal((await autopilotTick(db, { lanes, nowMs: Date.now() + 16 * 60_000 })).length, 2, "15 minutes later");
    setEnabled(db, false, "boss");
    db.prepare("UPDATE jobs SET state = 'cancelled'").run();
    assert.deepEqual(await autopilotTick(db, { lanes, nowMs: Date.now() + 40 * 60_000 }), []);
  });

  test("the review lane's repos go round robin and the cursor moves on a review", () => {
    assert.deepEqual(roundRobin(["c", "a", "b"], null), ["a", "b", "c"]);
    assert.deepEqual(roundRobin(["c", "a", "b"], "b"), ["c", "a", "b"]);
    assert.deepEqual(roundRobin(["c", "a", "b"], "c"), ["a", "b", "c"]);
    const review = LANES.find((l) => l.name === "review")!;
    review.chosen!(db, { step: "checks", params: { repo: "a" } });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'pipeline_review_cursor'").get(), undefined, "checks do not move the cursor");
    review.chosen!(db, { step: "review-batch", params: { repo: "b" } });
    const cursor = (db.prepare("SELECT value FROM settings WHERE key = 'pipeline_review_cursor'").get() as { value: string }).value;
    assert.deepEqual(roundRobin(["a", "b", "c"], cursor), ["c", "a", "b"]);
  });

  test("three failed automatic jobs in a row make the stage wait an hour; other stages go on", async () => {
    for (let i = 0; i < 3; i++) finish("test-limited", "failed", null, new Date(Date.now() - 20 * 60_000 - i * 60_000).toISOString());
    const until = backoffUntil(db, "test-limited");
    assert.ok(until !== null && until > Date.now() && until <= Date.now() + BACKOFF_MS);
    const logs: string[] = [];
    await planAutopilot(db, { lanes, log: (l) => logs.push(l) });
    assert.equal(jobs("test-limited").length, 3, "no new job");
    assert.equal(jobs("test-plain").length, 1);
    assert.ok(logs.some((l) => /test-limited.*failed/.test(l)), logs.join("\n"));
    assert.equal(backoffUntil(db, "test-limited", Date.now() + BACKOFF_MS + 60 * 60_000), null, "an hour later it is free");
    db.prepare("UPDATE jobs SET state = 'done' WHERE id = (SELECT MAX(id) FROM jobs WHERE step = 'test-limited')").run();
    assert.equal(backoffUntil(db, "test-limited"), null, "a success in the last three ends it");
  });

  test("a stage that handled nothing is not retried within 15 minutes", async () => {
    finish("test-limited", "done", 0);
    await planAutopilot(db, { lanes });
    assert.equal(jobs("test-limited").length, 1);
  });
});
