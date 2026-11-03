// Operator controls against running batches: a hold or stop that lands before or during a merge stops it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { runBatches } from "../src/merge/batch.ts";
import { activeBatches, updateBatch } from "../src/merge/batch-store.ts";
import { holdMerge, stopBatch } from "../src/merge/controls.ts";
import { addFastTrack, fastFirst, workScores } from "../src/fasttrack.ts";
import { dir, deps, fresh, finishTask, T0, world, type World } from "./batch-fixture.ts";

const quiet = () => {};
const merges = (w: World) => w.log.filter((l) => l.startsWith("safe-merge-test"));
const stateOf = (db: DatabaseSync, id: number) => (db.prepare("SELECT state FROM merge_batches WHERE id = ?").get(id) as { state: string }).state;

/** An open batch of PRs 1 and 2 whose PR is #900. */
async function open(w: World, root: string) {
  const db = fresh([{ n: 1 }, { n: 2 }]);
  const d = deps(w, join(dir, root));
  await runBatches(db, { repo: "app" }, quiet, d);
  finishTask(db, activeBatches(db, "app")[0]!.task_id!);
  await runBatches(db, { repo: "app" }, quiet, d);
  const b = activeBatches(db, "app")[0]!;
  assert.equal(b.state, "open");
  w.tip.set("tip", b.commit_sha);
  return { db, d, b };
}

describe("controls against a running batch", () => {
  test("an open batch with a held member is rebuilt without it and the held PR is not merged", async () => {
    const w = world();
    const { db, d, b } = await open(w, "c1");
    holdMerge(db, "op", "app", 2);
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([s.superseded, s.merged, merges(w)], [[b.branch], [], []]);
    assert.equal(stateOf(db, b.id), "superseded");
    const next = activeBatches(db, "app")[0]!;
    assert.deepEqual(db.prepare("SELECT number FROM merge_batch_prs WHERE batch_id = ?").all(next.id).map((r) => (r as { number: number }).number), [1]);
  });

  test("a hold set after the batch was checked, before the merge command, stops the merge", async () => {
    const w = world();
    const { db, d, b } = await open(w, "c2");
    w.onRead = (n) => { if (n === 900) holdMerge(db, "op", "app", 2); };
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([s.merged, merges(w), s.waiting], [[], [], [b.branch]]);
    assert.equal(stateOf(db, b.id), "open");
  });

  test("a batch ended while the merge was being prepared is not merged", async () => {
    const w = world();
    const { db, d, b } = await open(w, "c3");
    w.onRead = (n) => { if (n === 900) updateBatch(db, b.id, T0, { state: "superseded", summary: "stopped by an operator" }); };
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([s.merged, merges(w)], [[], []]);
    assert.equal(stateOf(db, b.id), "superseded");
  });

  test("a batch PR closed by our own stop is not taken for a person's close", async () => {
    const w = world();
    const { db, d, b } = await open(w, "c4");
    w.prState.set(900, "CLOSED");
    w.onRead = () => {};
    const stopping = stopBatch(db, "op", b.id, async () => ({ code: 0, stdout: "", stderr: "" }));
    await stopping;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.failed, []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stages WHERE stage = 'hold' AND actor = 'batch'").get()!.n, 0);
  });

  test("a batch merged although a stop ended it meanwhile is recorded as merged and audited", async () => {
    const w = world();
    const { db, d, b } = await open(w, "c5");
    w.onRead = (n) => { if (n === 900) updateBatch(db, b.id, T0, { state: "superseded" }); };
    w.mergeExit = 0;
    // The ending lands while the merge command runs.
    const run = d.run;
    d.run = async (cmd, args) => { updateBatch(db, b.id, T0, { state: "superseded" }); return run(cmd, args); };
    w.onRead = undefined;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.merged, [1, 2]);
    assert.equal(stateOf(db, b.id), "merged");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'batch-merged-after-end'").get()!.n, 1);
  });

  test("stopping a batch that is still checking cancels its sandbox task", async () => {
    const w = world();
    const db = fresh([{ n: 1 }]);
    const d = deps(w, join(dir, "c6"));
    await runBatches(db, { repo: "app" }, quiet, d);
    const b = activeBatches(db, "app")[0]!;
    await stopBatch(db, "op", b.id, async () => ({ code: 0, stdout: "", stderr: "" }));
    assert.equal((db.prepare("SELECT state FROM build_tasks WHERE id = ?").get(b.task_id!) as { state: string }).state, "cancelled");
  });
});

describe("fast track across repos and Fix PRs", () => {
  test("repos whose best candidate is fast-tracked come first, and a fast-tracked issue's Fix PR takes its place", () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    db.exec("INSERT INTO tracked_repos (name, pipeline) VALUES ('zed', 1)");
    db.prepare(`INSERT INTO items (repo, number, kind, state, created_at, updated_at) VALUES ('zed', 7, 'pr', 'OPEN', ?, ?), ('app', 9, 'issue', 'OPEN', ?, ?)`).run(T0, T0, T0, T0);
    assert.deepEqual(fastFirst(db, ["app", "zed"], (r) => (r === "zed" ? 7 : 1)), ["app", "zed"]);
    addFastTrack(db, "op", "zed#7");
    assert.deepEqual(fastFirst(db, ["app", "zed"], (r) => (r === "zed" ? 7 : 1)), ["zed", "app"]);
    addFastTrack(db, "op", "app#9");
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 9, 'x', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/2', ?, ?)").run(T0, T0);
    const scores = workScores(db, "app");
    assert.ok(scores.get(2)! > (scores.get(1) ?? 0));
    assert.deepEqual(fastFirst(db, ["app", "zed"], (r) => (r === "zed" ? 7 : 2)), ["zed", "app"]);
  });
});
