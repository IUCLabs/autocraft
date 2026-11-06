// The model-call queue: a higher class takes a freed slot first, stale waiters
// do not block, and Jev calls stay under the global cap across pools.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { allocation, setCallContext, startClaudeRun, startJevRun } from "../src/agents/call.ts";
import { finishRun } from "../src/agents/runs.ts";
import { connect } from "../src/db.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

after(() => setCallContext(null));
allocation.pollMs = 5000; // the in-process wake must be what hands over the slot

const claude = { promptId: "review.opus", promptVersion: "1", provider: "claude" as const, model: "m", items: [], prompt: "p" };
const jev = { promptId: "classify.jev", promptVersion: "1", provider: "jev" as const, model: "jev", items: [], prompt: "p" };
const quiet = () => {};
const ctx = (cls: 0 | 1 | 2) => setCallContext({ jobId: 1, step: "s", stage: 1, class: cls, cancelled: () => false });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fresh(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(SCRATCH, `call-queue-${name}-${process.pid}.db`));
  useTestAccount(db);
  db.prepare("UPDATE claude_accounts SET max_concurrent = 1 WHERE id = 't'").run();
  return db;
}

test("a security waiter takes a freed slot before an older class 0 waiter, and a stale waiter does not block", async () => {
  const db = fresh("claude");
  ctx(0);
  const first = await startClaudeRun(db, claude, quiet);
  let order: string[] = [];
  const low = startClaudeRun(db, claude, quiet).then((r) => (order.push("low"), r));
  await tick(20);
  ctx(2);
  const high = startClaudeRun(db, claude, quiet).then((r) => (order.push("high"), r));
  // A stale eligible class 2 waiter that nobody polls.
  db.prepare("INSERT INTO model_waits (provider, class, step, since, seen_at, eligible) VALUES ('claude', 2, 'x', 1, ?, 1)").run(Date.now() - 120_000);
  await tick(20);
  finishRun(db, first.runId, { state: "done" });
  const h = await high;
  assert.deepEqual(order, ["high"]);
  finishRun(db, h.runId, { state: "done" });
  await low;
  assert.deepEqual(order, ["high", "low"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM model_waits WHERE seen_at > ?").get(Date.now() - 60_000) as { n: number }).n, 0);
});

test("Jev calls stay at the cap across two concurrent pools", async () => {
  const db = fresh("jev");
  db.prepare("INSERT INTO settings (key, value) VALUES ('jev_parallel', '3')").run();
  ctx(0);
  let now = 0, max = 0;
  const pool = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = await startJevRun(db, jev);
      max = Math.max(max, ++now);
      await tick(15);
      now--;
      finishRun(db, id, { state: "done" });
    }
  };
  await Promise.all([pool(4), pool(4), pool(4), pool(4)]);
  assert.equal(max, 3);
});
