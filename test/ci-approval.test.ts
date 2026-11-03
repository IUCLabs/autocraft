import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Exec } from "../src/fixup/git.ts";
import { approveRuns, markReread, overallAt, recordRuns, setCiApproval, type Suite } from "../src/merge/ci-approval.ts";
import { buildQueue, eligible, refusedAsBefore } from "../src/merge/queue.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "ci-approval-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

// #1 take; #2 take, head moved on GitHub; #3 no review; #4 draft; #5 take-fix; #6 same-repo branch; #7 held; #8 Merge? answered hold; #9 take, only a pull_request_target run.
const waiting = (n: number, event = "pull_request"): Suite => ({ id: 100 + n, name: "CI", event, status: "COMPLETED", conclusion: "ACTION_REQUIRED" });

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
  for (let n = 1; n <= 9; n++) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
      VALUES ('app', ?, 'pr', 'OPEN', ?, 'outsider', 10, 0, ?, '${T0}', '${T0}')`).run(n, `PR ${n}`, `sha${n}`);
    if (n !== 3) db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, sure, mode) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', ?, 'ok', 1, 'full')`)
      .run(n, `sha${n}`, n === 5 ? "take-fix" : "take");
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
      VALUES ('app', ?, ?, 'OPEN', ?, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(n, `sha${n}`, n === 4 ? 1 : 0);
    recordRuns(db, { repo: "app", number: n, head_oid: `sha${n}`, state: "OPEN", cross_repo: n !== 6, suites: [waiting(n, n === 9 ? "pull_request_target" : "pull_request")] });
  }
  db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 7, 'op', ?)").run(T0);
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer) VALUES ('app#8:merge@sha8', 'merge', 'app', 8, 'q', '[]', ?, 'hold')`).run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  setCiApproval(db, "op", "app", true);
  return db;
}

type Opts = { moved?: number[]; failWrites?: boolean; transient?: boolean };
/** GitHub stand-in: every read and write is logged. PR 6 is a branch of the base repo. */
function fakes(log: string[], o: Opts = {}) {
  const gh = async (args: string[]): Promise<string> => {
    const path = args[1]!;
    log.push(`read ${path}`);
    const run = path.match(/head_sha=(\w+)/);
    if (run) return JSON.stringify({ workflow_runs: [{ id: 777, name: "CI", event: "pull_request", head_sha: run[1], head_repository: { full_name: "fork/app" }, repository: { full_name: "org/app" } }] });
    const n = Number(path.match(/pulls\/(\d+)/)![1]);
    return JSON.stringify({ state: "open", draft: false, head: { sha: o.moved?.includes(n) ? "newer" : `sha${n}`, repo: { full_name: n === 6 ? "org/app" : "fork/app" } }, base: { repo: { full_name: "org/app" } } });
  };
  const exec: Exec = async (_cmd, args) => {
    log.push(`write ${args[args.length - 1]}`);
    return o.transient ? { code: 1, stdout: "", stderr: "HTTP 502" } : o.failWrites ? { code: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" } : { code: 0, stdout: "", stderr: "" };
  };
  return { gh, exec };
}
const writes = (log: string[]) => log.filter((l) => l.startsWith("write")).map((l) => l.replace(/.*runs\/(\d+)\/approve/, "$1")).sort();

describe("runs waiting for approval", () => {
  test("a head with a waiting run shows ci-approval, is never eligible, and says who must act", () => {
    const db = fresh();
    const e = buildQueue(db).find((x) => x.number === 1)!;
    assert.equal(e.state, "ci-approval");
    assert.equal(eligible(e), false);
    assert.equal(e.runsBlocked, null);
    setCiApproval(db, "op", "app", false);
    assert.equal(buildQueue(db).find((x) => x.number === 1)!.runsBlocked, "off");
  });

  test("with the setting off the step refuses and reads nothing", async () => {
    const db = fresh();
    setCiApproval(db, "op", "app", false);
    const log: string[] = [];
    await assert.rejects(approveRuns(db, "app", { ...fakes(log), limit: 10 }), /not approved/);
    assert.deepEqual(log, []);
  });

  test("approves only reviewed fork PRs at the reviewed head; each run is audited as the stage", async () => {
    const db = fresh();
    const log: string[] = [];
    const r = await approveRuns(db, "app", { ...fakes(log, { moved: [2] }), limit: 10 });
    assert.deepEqual(r.approved, ["app#1", "app#5"]);
    assert.deepEqual(r.skipped, ["app#2"]);
    assert.deepEqual(writes(log), ["101", "105"]);
    // Unreviewed, draft, held, declined and pull_request_target-only PRs are neither read nor written.
    assert.ok(!log.some((l) => /pulls\/[34789]\b|#?(103|104|107|108|109)/.test(l)));
    const rows = db.prepare("SELECT login, target, details FROM audit WHERE action = 'ci-run-approve' ORDER BY target").all() as { login: string; target: string; details: string }[];
    assert.deepEqual(rows.map((x) => `${x.login} ${x.target}`), ["ci-approve app#1", "ci-approve app#5"]);
    assert.ok(rows.every((x) => JSON.parse(x.details).state === "done"));
  });

  test("the limit caps the PRs approved in one run", async () => {
    const r = await approveRuns(fresh(), "app", { ...fakes([]), limit: 1 });
    assert.equal(r.approved.length, 1);
  });

  test("runs at another head are dropped when the head moves", () => {
    const db = fresh();
    recordRuns(db, { repo: "app", number: 1, head_oid: "sha1b", state: "OPEN", cross_repo: true, suites: [] });
    assert.equal(db.prepare("SELECT runs FROM ci_run_approvals WHERE number = 1").get()!.runs, "[]");
  });

  test("CI stays pending after the approval until the approved runs finished", async () => {
    const db = fresh();
    await approveRuns(db, "app", { ...fakes([]), limit: 10 });
    const at = (suites: Suite[]) => {
      recordRuns(db, { repo: "app", number: 1, head_oid: "sha1", state: "OPEN", cross_repo: true, suites });
      return buildQueue(db).find((x) => x.number === 1)!;
    };
    // The suite still reads action_required, then runs, then succeeds.
    assert.equal(at([waiting(1)]).ci, "pending");
    assert.notEqual(at([waiting(1)]).state, "ci-approval");
    assert.equal(at([{ ...waiting(1), status: "IN_PROGRESS", conclusion: null }]).ci, "pending");
    assert.equal(at([{ ...waiting(1), conclusion: "SUCCESS" }]).ci, "success");
  });

  test("a run that appears after an empty read is found through the refusal and approved", async () => {
    const db = fresh();
    db.prepare("DELETE FROM ci_run_approvals WHERE number = 1").run();
    assert.notEqual(buildQueue(db).find((x) => x.number === 1)!.state, "ci-approval");
    markReread(db, "app", 1, "sha1");
    assert.equal(buildQueue(db).find((x) => x.number === 1)!.state, "ci-approval");
    const log: string[] = [];
    await approveRuns(db, "app", { ...fakes(log), limit: 10 });
    assert.ok(log.includes("read repos/storytold/app/actions/runs?head_sha=sha1&status=action_required&per_page=100"));
    assert.ok(writes(log).includes("777"));
  });

  test("after two failed approvals the PR is left to a person and not tried again", async () => {
    const db = fresh();
    for (let k = 0; k < 3; k++) await approveRuns(db, "app", { ...fakes([], { failWrites: true }), limit: 10 });
    assert.equal(buildQueue(db).find((x) => x.number === 1)!.runsBlocked, "failed");
    const log: string[] = [];
    await approveRuns(db, "app", { ...fakes(log, { failWrites: true }), limit: 10 });
    assert.deepEqual(log.filter((l) => l.includes("101")), []);
    const failed = db.prepare("SELECT details FROM audit WHERE action = 'ci-run-approve' AND target = 'app#1'").all() as { details: string }[];
    assert.equal(failed.length, 2);
  });

  test("transient errors are not counted against a run", async () => {
    const db = fresh();
    for (let k = 0; k < 4; k++) await approveRuns(db, "app", { ...fakes([], { transient: true }), limit: 10 });
    assert.equal(buildQueue(db).find((x) => x.number === 1)!.runsBlocked, null);
  });

  test("runs the step never approves go to a person", () => {
    const q = buildQueue(fresh());
    assert.equal(q.find((x) => x.number === 6)!.runsBlocked, "unsupported", "same-repo branch");
    assert.equal(q.find((x) => x.number === 9)!.runsBlocked, "unsupported", "not a pull_request run");
  });

  test("a mark the suites do not confirm is cleared by the sync only while the approval is off", () => {
    const db = fresh();
    const sync = () => recordRuns(db, { repo: "app", number: 3, head_oid: "sha3", state: "OPEN", cross_repo: true, suites: [] });
    markReread(db, "app", 3, "sha3");
    sync();
    assert.equal(db.prepare("SELECT reread FROM ci_run_approvals WHERE number = 3").get()!.reread, 1);
    setCiApproval(db, "op", "app", false);
    sync();
    assert.equal(db.prepare("SELECT reread FROM ci_run_approvals WHERE number = 3").get()!.reread, 0);
  });

  test("CI reads pending while runs wait, for the review and skip paths", () => {
    const db = fresh();
    assert.equal(overallAt(db, "app", 1, "sha1", "success"), "pending");
    assert.equal(overallAt(db, "app", 1, "other", "success"), "success");
  });

  test("a merge refused for action_required is tried again once the approved runs passed", async () => {
    const db = fresh();
    const entry = () => buildQueue(db).find((x) => x.number === 1)!;
    // The sync did not list the run (as at the refusal); safe-merge's refusal marks the head.
    db.prepare("DELETE FROM ci_run_approvals WHERE number = 1").run();
    db.prepare(`INSERT INTO merges (repo, number, head_oid, run_id, at, path, outcome, reason, ci, mergeable) VALUES ('app', 1, 'sha1', 'r', '2026-01-03T00:00:00.000Z', 'operator', 'refused', 'workflow runs not green: CI: action_required', 'success', 'MERGEABLE')`).run();
    markReread(db, "app", 1, "sha1", "2026-01-03T00:00:01.000Z");
    await approveRuns(db, "app", { ...fakes([]), limit: 10 });
    const suite: Suite = { id: 777, name: "CI", event: "pull_request", status: "COMPLETED", conclusion: "SUCCESS" };
    recordRuns(db, { repo: "app", number: 1, head_oid: "sha1", state: "OPEN", cross_repo: true, suites: [suite] });
    const e = entry();
    assert.equal(e.ci, "success");
    // Same ci and mergeable as at the refusal, but the approval came later: not "refused as before".
    assert.equal(refusedAsBefore(db, { ...e, state: "refused" }), false);
  });
});
