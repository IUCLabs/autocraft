// The runner on fake steps: it runs queued jobs in child processes, records
// success, failure and usage, honours cancels, recovers jobs an earlier runner
// left running, runs one job per group at a time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";

process.env.CRAFT_AUTO_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob, jobDetail, requestCancel } = await import("../src/runner/jobs.ts");
const { DEFAULT_MAX_JOBS, Runner } = await import("../src/runner/runner.ts");
const { STEPS } = await import("../src/runner/steps.ts");
const { FAKE_TOKEN } = await import("./runner-steps.ts");
const { dueItems, inputHash } = await import("../src/runner/classify.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-test-"));
const dbFile = join(dir, "runner.db");
const db = connect(dbFile);
const runner = new Runner({ db, dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });

after(async () => {
  await runner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = (id: number) => getJob(db, id).state;

describe("runner", () => {
  test("runs a queued job and records its summary, usage and a scrubbed log; a failing job is failed", async () => {
    const ok = await enqueue(db, "test-echo", { n: 7 }, "boss");
    const bad = await enqueue(db, "test-echo", { mode: "fail" }, "boss");
    await until(() => state(ok.id) === "done" && state(bad.id) === "failed");
    const j = jobDetail(db, ok.id);
    assert.equal(j.summary, "echo 7");
    assert.deepEqual(j.usage, { calls: 1, input: 100, output: 10, costUsd: 0.01 });
    assert.ok(j.startedAt && j.endedAt);
    assert.ok(j.log.includes("token in the log: [hidden]"), j.log);
    assert.ok(!j.log.includes(FAKE_TOKEN));
    assert.equal(getJob(db, bad.id).error, "echo failed on purpose");
  });

  test("a running job stops when its cancel is requested", async () => {
    const j = await enqueue(db, "test-sleep", { ms: 60_000 }, "boss");
    await until(() => (getJob(db, j.id).progress ?? "").startsWith("slept"));
    requestCancel(db, j.id, "boss");
    await until(() => state(j.id) !== "running", 10_000);
    assert.equal(state(j.id), "cancelled");
    assert.equal(runner.running.size, 0);
  });

  test("a queued job cancelled before it starts never runs", async () => {
    const j = await enqueue(db, "test-sleep", { ms: 1 }, "boss");
    assert.equal(requestCancel(db, j.id, "boss").state, "cancelled");
    await runner.tick();
    assert.equal(getJob(db, j.id).startedAt, null);
  });

  test("a job left running by an earlier runner is marked failed", () => {
    const id = Number(db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, pid) VALUES ('test-sleep', '{}', 'boss', ?, 'running', ?, 999999)")
      .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    assert.equal(runner.recover(), 1);
    const j = getJob(db, id);
    assert.equal(j.state, "failed");
    assert.match(j.error ?? "", /runner stopped/);
  });

  test("one job per concurrency group runs at a time", async () => {
    const a1 = await enqueue(db, "test-sleep", { ms: 600 }, "boss");
    const a2 = await enqueue(db, "test-echo", { n: 2 }, "boss");
    const b = await enqueue(db, "test-other", { ms: 600 }, "boss");
    await runner.tick();
    assert.deepEqual([state(a1.id), state(a2.id), state(b.id)], ["running", "queued", "running"]);
    await until(() => state(a2.id) === "done");
    assert.ok(getJob(db, a2.id).startedAt! >= getJob(db, a1.id).endedAt!, "the second job of group a started after the first ended");
    await runner.idle();
  });

  test("each pipeline stage has its own group, so stages run together and a step never runs twice at once", () => {
    const g = (n: string) => STEPS.find((s) => s.name === n)!.group;
    const stages = ["classify-new", "decide", "review-batch", "labels-apply", "checks", "embed"].map(g);
    assert.equal(new Set(stages).size, stages.length);
    assert.equal(g("classify-new"), g("classify-all"));
    assert.equal(g("labels-ensure"), g("labels-apply"));
    assert.equal(g("labels-apply"), g("merge"));
    assert.ok(DEFAULT_MAX_JOBS >= new Set(STEPS.map((s) => s.group)).size);
  });

  test("classify-new takes items without a verdict and items whose text changed; a pass takes only the first", () => {
    const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, updated_at) VALUES ('photocraft', ?, 'issue', ?, ?, 'body', ?)");
    const verdict = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, input_hash) VALUES ('photocraft', ?, 'jev', 'r1', '2026-10-10T00:00:00Z', 'bugfix', ?)");
    const item = (n: number, title: string) => ({ repo: "photocraft", number: n, kind: "issue" as const, title, body: "body", lines_changed: null, files_changed: null, author_association: null });
    ins.run(1, "OPEN", "no verdict", "2026-10-01T00:00:00Z");
    ins.run(2, "OPEN", "same", "2026-10-20T00:00:00Z");
    verdict.run(2, inputHash(item(2, "same")));
    ins.run(3, "OPEN", "edited title", "2026-10-20T00:00:00Z");
    verdict.run(3, inputHash(item(3, "old title")));
    ins.run(4, "OPEN", "legacy, updated since", "2026-10-20T00:00:00Z");
    verdict.run(4, null);
    ins.run(5, "OPEN", "legacy, not updated", "2026-10-01T00:00:00Z");
    verdict.run(5, null);
    ins.run(6, "CLOSED", "closed", "2026-10-01T00:00:00Z");
    const nums = (mode: "new" | "all") => dueItems(db, "r1", mode).due.map((r) => r.number);
    assert.deepEqual(nums("new"), [1, 3, 4]);
    assert.deepEqual(nums("all"), [1]);
  });
});
