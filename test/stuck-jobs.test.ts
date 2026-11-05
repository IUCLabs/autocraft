// Stuck-job handling: the runner stops a job past its step's deadline and fails it with a warning until acknowledged or beaten by a
// later success; the drain state lets the writes of jobs already running through where plain off blocks them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setCommentApproval } from "../src/act/approval.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob } = await import("../src/runner/jobs.ts");
const { Runner, deadlineError } = await import("../src/runner/runner.ts");
const { ackDeadline, deadlineStops, isDraining, isEnabled, setEnabled } = await import("../src/runner/autopilot.ts");
const { guardRepo } = await import("../src/core/guard.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "stuck-jobs-"));
const dbFile = join(dir, "runner.db");
const db = connect(dbFile);
const runner = new Runner({ db, dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {}, maxMin: () => 0.02 });
after(async () => {
  await runner.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a job past its step's deadline is stopped and failed, and warns until acknowledged or beaten", async () => {
  const slow = await enqueue(db, "test-sleep", { ms: 60_000 }, "boss");
  for (const end = Date.now() + 20_000; getJob(db, slow.id).state !== "failed" && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  const j = getJob(db, slow.id);
  assert.equal(j.state, "failed");
  assert.equal(j.error, deadlineError(0.02));
  assert.deepEqual(deadlineStops(db).map((d) => d.step), ["test-sleep"]);
  ackDeadline(db, "test-sleep", "op");
  assert.deepEqual(deadlineStops(db), []);
});

test("draining keeps a running job's writes; off blocks them", () => {
  const pipe = world().repo(["comment"]).pr(1).pipeline(false).db;
  setCommentApproval(pipe, "op", "app", true);
  const refused = () => (guardRepo(pipe, "app", "comment", "pipeline") as { refused?: string }).refused;
  setEnabled(pipe, false, "op", "drain");
  assert.ok(isDraining(pipe) && !isEnabled(pipe));
  assert.equal(refused(), undefined);
  setEnabled(pipe, false, "op");
  assert.match(refused() ?? "", /pipeline is off/);
  setEnabled(pipe, true, "op");
  assert.ok(isEnabled(pipe) && !isDraining(pipe));
  assert.equal(refused(), undefined);
});
