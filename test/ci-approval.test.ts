import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Exec } from "../src/fixup/git.ts";
import { approveRuns, detectRuns, setCiApproval } from "../src/merge/ci-approval.ts";
import { buildQueue, eligible } from "../src/merge/queue.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "ci-approval-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

// #1 take; #2 take, head moved on GitHub; #3 no review; #4 draft; #5 take-fix.
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
  for (const n of [1, 2, 3, 4, 5]) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
      VALUES ('app', ?, 'pr', 'OPEN', ?, 'outsider', 10, 0, ?, '${T0}', '${T0}')`).run(n, `PR ${n}`, `sha${n}`);
    if (n !== 3) db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'S', ?, 'ok')`)
      .run(n, `sha${n}`, n === 5 ? "take-fix" : "take");
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
      VALUES ('app', ?, ?, 'OPEN', ?, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(n, `sha${n}`, n === 4 ? 1 : 0);
  }
  finalizeReviews(db);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  return db;
}

/** GitHub stand-in: every head has one waiting run (id = 100 + PR number) except where `none` says otherwise; reads and writes are logged. */
function fakes(log: string[], o: { moved?: number[]; none?: number[] } = {}) {
  const gh = async (args: string[]): Promise<string> => {
    const path = args[1]!;
    log.push(`read ${path}`);
    const run = path.match(/head_sha=sha(\d+)/);
    if (run) {
      const n = Number(run[1]);
      return JSON.stringify({ workflow_runs: o.none?.includes(n) ? [] : [{ id: 100 + n, name: "CI", head_sha: `sha${n}` }] });
    }
    const n = Number(path.match(/pulls\/(\d+)/)![1]);
    return JSON.stringify({ state: "open", draft: false, head: { sha: o.moved?.includes(n) ? "newer" : `sha${n}` } });
  };
  const exec: Exec = async (_cmd, args) => {
    log.push(`write ${args.slice(-3).join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { gh, exec };
}

describe("runs waiting for approval", () => {
  test("a reviewed head with a waiting run shows ci-approval and is not ready", async () => {
    const db = fresh();
    const log: string[] = [];
    assert.equal(buildQueue(db).find((e) => e.number === 1)!.ci, "success");
    assert.equal(await detectRuns(db, "app", fakes(log).gh), 3, "only reviewed, open, non-draft heads are read");
    assert.ok(!log.some((l) => l.includes("sha3") || l.includes("sha4")));
    const e = buildQueue(db).find((x) => x.number === 1)!;
    assert.equal(e.state, "ci-approval");
    assert.equal(e.runsWaiting, 1);
    assert.equal(eligible(e), false);
    assert.equal(buildQueue(db).find((x) => x.number === 5)!.state, "needs-fix-up");
  });

  test("approves reviewed take and take-fix heads only, at the reviewed head, and audits each run", async () => {
    const db = fresh();
    const log: string[] = [];
    const r = await approveRuns(db, "app", { ...fakes(log, { moved: [2] }), limit: 10 });
    assert.deepEqual(r.approved, ["app#1", "app#5"]);
    assert.deepEqual(r.skipped, ["app#2"]);
    assert.deepEqual(log.filter((l) => l.startsWith("write")).sort(), ["write -X POST repos/storytold/app/actions/runs/101/approve", "write -X POST repos/storytold/app/actions/runs/105/approve"]);
    assert.ok(!log.some((l) => /pulls\/[34]\b|sha[34]/.test(l)), "nothing is read or written for the unreviewed and draft PRs");
    const rows = db.prepare("SELECT target, details FROM audit WHERE action = 'ci-run-approve' ORDER BY target").all() as { target: string; details: string }[];
    assert.deepEqual(rows.map((x) => x.target), ["app#1", "app#5"]);
    assert.ok(rows.every((x) => JSON.parse(x.details).state === "done"));
    // Until the next checks read, CI of the approved PR counts as not finished.
    const after = buildQueue(db).find((x) => x.number === 1)!;
    assert.equal(after.ci, "pending");
    assert.notEqual(after.state, "ci-approval");
    // The moved head still waits and nothing more is approved on a second run.
    assert.equal((await approveRuns(db, "app", { ...fakes([]), limit: 10 })).approved.length, 0);
  });

  test("the limit caps the PRs approved in one run", async () => {
    const r = await approveRuns(fresh(), "app", { ...fakes([]), limit: 1 });
    assert.equal(r.approved.length, 1);
  });

  test("the setting is per repo and audited", () => {
    const db = fresh();
    assert.equal(setCiApproval(db, "op", "app", true), true);
    assert.equal(setCiApproval(db, "op", "app", true), false);
    assert.throws(() => setCiApproval(db, "op", "nope", true), /not tracked/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'ci-approve'").get() as { n: number }).n, 1);
  });
});
