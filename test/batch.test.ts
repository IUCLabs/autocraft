import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { runBatches } from "../src/merge/batch.ts";
import { activeBatches, admits, batchesDue, batchSizeOf, membersOf, setBatchSize } from "../src/merge/batch-store.ts";
import { reviewedHeads } from "../src/merge/ci-approval.ts";
import { buildQueue, eligible, singleMergeOnly } from "../src/merge/queue.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { selectCandidates } from "../src/review/candidates.ts";
import { Git } from "../src/fixup/git.ts";

import { dir, T0, T1, MAIN2, fresh, world, deps, type World } from "./batch-fixture.ts";
const states = (db: DatabaseSync) => Object.fromEntries(buildQueue(db, { repo: "app" }).map((e) => [e.number, e.state]));
const quiet = () => {};

describe("integration batches", () => {
  test("builds a batch, skips a conflicting PR, publishes, merges with merge commits and grows the size", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    setBatchSize(db, "app", 5);
    const w = world();
    w.conflicts.add("sha3");
    const d = deps(w, join(dir, "r1"));
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.started, ["integration-app-20260102-1"]);
    // The batch goes straight to an open PR: no sandbox task, upstream CI is the check.
    const b = activeBatches(db, "app")[0]!;
    assert.deepEqual(s.published, [b.branch]);
    assert.deepEqual([b.state, b.task_id], ["open", null]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
    assert.deepEqual(membersOf(db, b.id).map((m) => m.number), [1, 2, 4]);
    assert.ok(w.log.some((l) => l.startsWith("push ") && l.endsWith(`:refs/heads/${b.branch}`)));
    assert.ok(w.log.some((l) => l.startsWith("pr create") && l.includes("[app#1](https://github.com/storytold/app/pull/1)") && l.includes("[app#4]")));
    assert.deepEqual(states(db), { 1: "in-batch", 2: "in-batch", 3: "ready", 4: "in-batch" });

    const done = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(done.merged, [1, 2, 4]);
    assert.ok(w.log.includes("safe-merge-test storytold/app 900 --merge"));
    const rows = db.prepare("SELECT number, method, outcome FROM merges ORDER BY number").all();
    assert.deepEqual(rows.map((r) => `${r.number}:${r.method}:${r.outcome}`), ["1:merge:merged", "2:merge:merged", "4:merge:merged"]);
    assert.equal(batchSizeOf(db, "app"), 6);
  });

  test("a batch whose PR fails CI splits in half; a single failing PR is held and the size halves", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const w = world();
    const d = deps(w, join(dir, "r2"));
    await runBatches(db, { repo: "app" }, quiet, d);
    const first = activeBatches(db, "app")[0]!;
    assert.equal(membersOf(db, first.id).length, 3);
    w.ci = "FAILURE";
    const split = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(split.split.length, 1);
    assert.equal(batchSizeOf(db, "app"), 10);
    const kids = activeBatches(db, "app");
    assert.deepEqual(kids.map((k) => membersOf(db, k.id).map((m) => m.number)), [[1, 2], [3]]);

    const next = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(next.failed, [3]);
    assert.equal(states(db)[3], "batch-failed");
    assert.equal((db.prepare("SELECT summary FROM merge_batches WHERE id = ?").get(kids[1]!.id) as { summary: string }).summary, "upstream CI failed on the batch PR: ci");
    assert.equal(batchSizeOf(db, "app"), 2);
    assert.equal(next.split.length, 1);
  });

  test("a moved default branch rebuilds the batch and closes its PR; CI failure on the batch PR splits it", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    const w = world();
    const d = deps(w, join(dir, "r3"));
    await runBatches(db, { repo: "app" }, quiet, d);
    w.conflicts.add(activeBatches(db, "app")[0]!.commit_sha);
    w.mainHead = MAIN2;
    const moved = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(moved.superseded.length, 1);
    assert.ok(w.log.includes("pr close 900"));
    const rebuilt = activeBatches(db, "app");
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]!.base_sha, MAIN2);
    assert.equal(rebuilt[0]!.state, "open");

    w.ci = "FAILURE";
    const failed = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(failed.split.length, 1);
    assert.equal(activeBatches(db, "app").length, 2);
  });

  test("needs the repo's merge approval", async () => {
    const db = fresh([{ n: 1 }]);
    db.prepare("DELETE FROM main.settings WHERE key = 'merge_approved:app'").run();
    await assert.rejects(runBatches(db, { repo: "app" }, quiet, deps(world(), join(dir, "r4"))), /not approved/);
  });

  test("batch size rules: count, line cap and L-size alone", () => {
    const c = (size: string, lines: number) => ({ size, lines });
    assert.equal(admits([c("S", 10)], c("S", 10), 2), true);
    assert.equal(admits([c("S", 10), c("S", 10)], c("S", 10), 2), false);
    assert.equal(admits([c("S", 9500)], c("M", 600), 50), false);
    assert.equal(admits([c("S", 1500)], c("M", 600), 50), true);
    assert.equal(admits([c("S", 10)], c("L", 5), 10), false);
    assert.equal(admits([c("L", 900)], c("S", 5), 10), false);
  });

  test("the pipeline's own Fix PRs count as whitelisted", () => {
    const db = fresh([{ n: 1, author: "pipeline-bot" }, { n: 2, author: "pipeline-bot" }]);
    assert.deepEqual(states(db), { 1: "needs-decision", 2: "needs-decision" });
    db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', 'pipeline-bot')").run();
    db.prepare(`INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 50, 'x', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/1', '${T0}', '${T0}')`).run();
    assert.deepEqual(states(db), { 1: "ready", 2: "needs-decision" });
  });

  /** Builds a batch of PRs 1..n, which is published at once; returns the open batch. */
  async function open(n: number, w: World, root: string) {
    const db = fresh(Array.from({ length: n }, (_, k) => ({ n: k + 1, author: k === 1 ? "other" : "regular" })));
    db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('other', 'allow', 'op', ?)").run(T0);
    const d = deps(w, join(dir, root));
    await runBatches(db, { repo: "app" }, quiet, d);
    const b = activeBatches(db, "app")[0]!;
    assert.equal(b.state, "open");
    w.tip.set("tip", b.commit_sha);
    return { db, d, b };
  }
  const merged = (w: World) => w.log.some((l) => l.startsWith("safe-merge-test"));

  test("a member that loses its merge path while the batch is open is dropped before landing", async () => {
    const w = world();
    const { db, d } = await open(3, w, "f1");
    db.prepare("UPDATE whitelist_overrides SET status = 'deny' WHERE login = 'other'").run();
    assert.equal(states(db)[2], "needs-decision");
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(s.superseded.length, 1);
    assert.deepEqual(s.merged, []);
    assert.equal(merged(w), false);
    assert.deepEqual(activeBatches(db, "app").map((b) => membersOf(db, b.id).map((m) => m.number)), [[1, 3]]);
  });

  test("a member closed or pushed to after the batch PR opened is not landed at the old head", async () => {
    const w = world();
    const { db, d } = await open(3, w, "f2");
    w.heads.set(2, "pushed");
    w.prState.set(3, "CLOSED");
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(s.superseded.length, 1);
    assert.equal(merged(w), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM merges").get()!.n, 0);
    assert.deepEqual(activeBatches(db, "app").map((b) => membersOf(db, b.id).map((m) => m.number)), [[1]]);
  });

  test("a failing push is kept on the batch and retried with a growing wait; the fifth failure releases the PRs", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    const w = world();
    const d = deps(w, join(dir, "pf"));
    const inner = d.exec;
    d.exec = async (cmd, args, opts) => (cmd === "git" && args.includes("push") ? { code: 1, stdout: "", stderr: "remote: denied" } : inner(cmd, args, opts));
    await runBatches(db, { repo: "app" }, quiet, d);
    const b = activeBatches(db, "app")[0]!;
    assert.deepEqual([b.state, b.retries, b.pr_number], ["checking", 1, null]);
    assert.match(b.summary!, /push failed: remote: denied/);
    const again = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([again.waiting, activeBatches(db, "app")[0]!.retries], [[b.branch], 1]);
    assert.deepEqual(batchesDue(db, new Date(T1)), []);

    db.prepare("UPDATE merge_batches SET retries = 4, updated_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(b.id);
    assert.deepEqual(batchesDue(db, new Date(T1)), ["app"]);
    await runBatches(db, { repo: "app" }, quiet, d);
    const end = db.prepare("SELECT state, summary FROM merge_batches WHERE id = ?").get(b.id) as { state: string; summary: string };
    assert.equal(end.state, "failed");
    assert.match(end.summary, /^could not open the batch PR after 5 tries/);
    assert.notEqual(states(db)[1], "batch-failed");
  });

  test("a failed batch PR names the failing checks", async () => {
    const db = fresh([{ n: 1 }]);
    const w = world();
    const d = deps(w, join(dir, "fn"));
    await runBatches(db, { repo: "app" }, quiet, d);
    w.ci = "FAILURE";
    await runBatches(db, { repo: "app" }, quiet, d);
    assert.match((db.prepare("SELECT summary FROM merge_batches ORDER BY id LIMIT 1").get() as { summary: string }).summary, /^upstream CI failed on the batch PR: ci$/);
  });

  test("runs waiting for approval on the batch PR are approved only for a fully reviewed batch, and noted otherwise", async () => {
    const w = world();
    const { db, b } = await open(2, w, "ap");
    db.prepare("INSERT INTO ci_run_approvals (repo, number, head_oid, cross_repo, runs, approved, reread, failed, checked_at) VALUES ('app', 900, ?, 1, '[{\"id\":5,\"name\":\"ci\",\"event\":\"pull_request\"}]', '[]', 0, '{}', ?)").run(b.commit_sha, T1);
    assert.deepEqual(reviewedHeads(db, "app").map((c) => [c.number, c.head]), [[900, b.commit_sha]]);
    db.prepare("DELETE FROM opus_reviews WHERE number = 2").run();
    assert.deepEqual(reviewedHeads(db, "app"), []);
  });

  test("a batch larger than the daily limit left waits", async () => {
    const w = world();
    const { db, d } = await open(3, w, "f5");
    const s = await runBatches(db, { repo: "app", limit: 2 }, quiet, d);
    assert.deepEqual([s.merged, s.waiting.length, merged(w)], [[], 1, false]);
    assert.equal(activeBatches(db, "app")[0]!.state, "open");
  });

  test("PRs of a repo without CI go to the single-merge path, not into a batch", async () => {
    const db = fresh([{ n: 1, author: "stranger" }]);
    db.prepare("UPDATE pr_checks SET overall = 'none'").run();
    db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
    askMergeDecisions(db, { run: "r1" });
    db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = '2099-01-01'").run();
    const [e] = buildQueue(db, { repo: "app" });
    assert.ok(eligible(e!) && singleMergeOnly(e!));
    const s = await runBatches(db, { repo: "app" }, quiet, deps(world(), join(dir, "f6")));
    assert.deepEqual(s.started, []);
  });

  test("a batch PR merged outside the command is recorded as merged; one closed by a person holds its PRs", async () => {
    const w = world();
    const { db, d, b } = await open(2, w, "l1");
    w.prState.set(900, "MERGED");
    w.mainHead = MAIN2;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.merged, [1, 2]);
    assert.equal((db.prepare("SELECT state FROM merge_batches WHERE id = ?").get(b.id) as { state: string }).state, "merged");

    const w2 = world();
    const o = await open(2, w2, "l2");
    w2.prState.set(900, "CLOSED");
    await runBatches(o.db, { repo: "app" }, quiet, o.d);
    assert.deepEqual(states(o.db), { 1: "batch-failed", 2: "batch-failed" });
    assert.equal(activeBatches(o.db, "app").length, 0);
  });

  test("a main move that merges cleanly keeps the batch", async () => {
    const w = world();
    const { db, d } = await open(2, w, "f8");
    w.mainHead = MAIN2;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([s.superseded, s.merged], [[], [1, 2]]);
  });

  test("a batch PR left by a crash is adopted instead of created again", async () => {
    const db = fresh([{ n: 1 }]);
    const w = world();
    w.existingPr = "https://github.com/storytold/app/pull/900\n";
    const d = deps(w, join(dir, "l3"));
    await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(w.log.some((l) => l.startsWith("pr create")), false);
    assert.equal(activeBatches(db, "app")[0]!.pr_number, 900);
  });

  test("a fetch that fails on a ref lock is tried again", async () => {
    let calls = 0;
    const g = new Git(async () => (++calls < 3 ? { code: 1, stdout: "", stderr: "error: cannot lock ref 'refs/x': is at a but expected b" } : { code: 0, stdout: "ok", stderr: "" }), dir, "lock");
    assert.equal((await g.git(["fetch", "x"])).code, 0);
    assert.equal(calls, 3);
  });

  test("our integration PRs do not enter the queue or the review candidates", () => {
    const db = fresh([{ n: 1 }, { n: 5, author: "bot" }]);
    db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', 'bot')").run();
    db.prepare("INSERT INTO merge_batches (repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at) VALUES ('app', 'integration-app-1', 'open', 'a', 'b', 5, ?, ?)").run(T0, T0);
    assert.deepEqual(Object.keys(states(db)), ["1"]);
    db.prepare("DELETE FROM opus_reviews").run();
    assert.deepEqual(selectCandidates(db, "app").map((c) => c.number), [1]);
  });
});
