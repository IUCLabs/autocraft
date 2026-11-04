// Command-line runs of steps: which command lines become jobs, the gate, and a run through the exec path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { cliRequest, runCliJob } from "../src/runner/cli-job.ts";
import { cliGate } from "../src/runner/autopilot.ts";
import { loadSteps } from "../src/runner/steps.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "cli-job-"));
process.env.AUTOCRAFT_DB = join(dir, "t.db");
process.env.RUNNER_LOGS = join(dir, "logs");

describe("which command lines become jobs", async () => {
  const steps = await loadSteps();
  const req = (c: string, a: string[]) => cliRequest(c, a, steps);
  test("--apply makes a job; a dry run, another subcommand or an unknown option keeps the direct path", () => {
    assert.deepEqual(req("act", ["--repo", "app", "--limit", "5", "--apply"]), { step: "act", params: { repo: "app", limit: 5 } });
    assert.equal(req("act", ["--repo", "app"]), null);
    assert.equal(req("fixup", ["repost", "app#1", "--apply"]), null);
    assert.equal(req("premerge", ["--repo", "app", "--number", "3", "--apply"]), null);
  });
  test("steps without a dry-run flag always run as jobs; those with one only without it", () => {
    assert.deepEqual(req("rank", []), { step: "rank", params: {} });
    assert.equal(req("rank", ["show", "app", "1"]), null);
    assert.deepEqual(req("dupe-compare", ["--limit", "3"]), { step: "dupes-compare", params: { limit: 3 } });
    assert.equal(req("dupes", ["--dry-run"]), null);
  });
});

describe("running", () => {
  test("a run is recorded as a job of `cli`, shows in the day's count, and is refused while a job of the step is running", async () => {
    const db = connect(process.env.AUTOCRAFT_DB!);
    assert.equal(await runCliJob(db, { step: "rank", params: {} }), 0);
    const j = db.prepare("SELECT step, requested_by, state FROM jobs").all() as { step: string; requested_by: string; state: string }[];
    assert.deepEqual(j.map((x) => ({ ...x })), [{ step: "rank", requested_by: "cli", state: "done" }]);
    const steps = await loadSteps();
    const rank = steps.get("rank")!;
    const groupOf = (n: string) => steps.get(n)?.group ?? n;
    assert.equal(cliGate(db, rank, groupOf), null);
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at) VALUES ('merge-ask', '{}', 'pipeline', '2026-01-01T00:00:00Z', 'running', '2026-01-01T00:00:00Z')").run();
    assert.match(cliGate(db, rank, groupOf) ?? "", /same group \(local\)/);
    assert.match(cliGate(db, steps.get("merge-ask")!, groupOf) ?? "", /merge-ask is running/);
    db.prepare("UPDATE jobs SET state = 'done'").run();
    db.prepare("INSERT INTO stage_limits (step, per_day) VALUES ('rank', 0) ON CONFLICT (step) DO UPDATE SET per_day = 0").run();
    assert.match(cliGate(db, rank, groupOf) ?? "", /daily limit is 0/);
    assert.equal(await runCliJob(db, { step: "rank", params: {} }), 1);
  });
});
