import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { addFastTrack, FastTrackError, parseItemRef, removeFastTrack } from "../src/fasttrack.ts";
import { holdMerge, releaseMerge, removeFromBatch, stopBatch } from "../src/merge/controls.ts";
import { insertBatch, membersOf, updateBatch } from "../src/merge/batch-store.ts";
import { runMerge } from "../src/merge/index.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { planSingles } from "../src/merge/single.ts";
import { selectCandidates } from "../src/review/candidates.ts";
import type { DiffFetcher } from "../src/review/diff.ts";
import { queuePage } from "../src/dash/api/queue-page.ts";
import type { Req } from "../src/dash/types.ts";
import type { Exec } from "../src/fixup/git.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "queue-controls-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

// `app` has its pipeline on, `off` has it off. Each has PRs 1 to 3: reviewed, verified, green and inside the merge rule.
// Work ranks: 1 highest, then 2, then 3. Issue 4 in `off` is open and unreviewed.
function fresh(reviewed = true): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('off', 0)");
  for (const repo of ["app", "off"]) {
    for (const n of [1, 2, 3]) {
      db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES (?, ?, 'pr', 'OPEN', ?, 'regular', 20, 0, ?, ?, ?)`)
        .run(repo, n, `PR ${n}`, `sha${n}`, T0, T0);
      db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, 'jev', 'r1', ?, 'bugfix', '[]', '{"top":0.95}')`).run(repo, n, T0);
      db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES (?, ?, ?, '{\"level\":\"P2\",\"rated\":\"P2\",\"security\":false,\"type\":\"bugfix\",\"size\":\"S\",\"sizeSource\":\"lines\",\"reach\":1}', ?)").run(repo, n, 400 - n * 100, T0);
      if (reviewed) {
        db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES (?, ?, ?, 'rv', ?, 'm', 'S', 'take', 'looks right')`).run(repo, n, `sha${n}`, T0);
        db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, summary, note, created_at) VALUES (?, ?, ?, 'tests', 'r', 'passed', NULL, 'ok', ?)`).run(repo, n, `sha${n}`, T0);
        db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES (?, ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, ?)`).run(repo, n, `sha${n}`, T1);
      }
    }
  }
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES ('off', 4, 'issue', 'OPEN', 'Issue 4', 'regular', ?, ?)`).run(T0, T0);
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  if (reviewed) finalizeReviews(db);
  return db;
}

const reviewOrder = (db: DatabaseSync, repo: string) => selectCandidates(db, repo, "r1").map((c) => c.number);
const mergeOrder = async (db: DatabaseSync, repo: string) => (await runMerge(db, { repo }, () => {})).attempted;

describe("fast track", () => {
  test("fast-tracked items go first in the order added, in Review and in merges; removing returns them to the ranking", async () => {
    const db = fresh(false);
    assert.deepEqual(reviewOrder(db, "app"), [1, 2, 3]);
    addFastTrack(db, "op", "app#3");
    addFastTrack(db, "op", "storytold/app#2");
    assert.deepEqual(reviewOrder(db, "app"), [3, 2, 1]);
    removeFastTrack(db, "op", "app#3");
    assert.deepEqual(reviewOrder(db, "app"), [2, 1, 3]);

    const m = fresh();
    assert.deepEqual(await mergeOrder(m, "app"), ["app#1", "app#2", "app#3"]);
    addFastTrack(m, "op", "https://github.com/storytold/app/pull/3");
    addFastTrack(m, "op", "app#2");
    assert.deepEqual(await mergeOrder(m, "app"), ["app#3", "app#2", "app#1"]);
  });

  test("a fast-tracked item runs in a repo whose pipeline is off; the others there do not", async () => {
    const db = fresh(false);
    assert.deepEqual(reviewOrder(db, "off"), []);
    addFastTrack(db, "op", "off#2");
    assert.deepEqual(reviewOrder(db, "off"), [2]);

    const m = fresh();
    assert.deepEqual(await mergeOrder(m, "off"), []);
    addFastTrack(m, "op", "off#3");
    assert.deepEqual(await mergeOrder(m, "off"), ["off#3"]);
  });

  test("closed items drop out of the list; only open items of tracked repos can be added", () => {
    const db = fresh(false);
    addFastTrack(db, "op", "app#1");
    addFastTrack(db, "op", "app#2");
    db.prepare("UPDATE items SET state = 'MERGED' WHERE repo = 'app' AND number = 1").run();
    assert.deepEqual(reviewOrder(db, "app").slice(0, 1), [2]);
    assert.throws(() => addFastTrack(db, "op", "app#1"), (e: unknown) => e instanceof FastTrackError && e.status === 409);
    assert.throws(() => addFastTrack(db, "op", "nope#1"), /not a tracked repo/);
    assert.throws(() => addFastTrack(db, "op", "other/app#1"), /not in the storytold organisation/);
    assert.deepEqual(parseItemRef("designcraft#1484"), { repo: "designcraft", number: 1484 });
  });

  test("the Queue page lists fast-tracked items of a pipeline-off repo first, with their place, and the repo filter applies", async () => {
    const db = fresh();
    addFastTrack(db, "op", "off#3");
    addFastTrack(db, "op", "app#2");
    const get = (query: string) => queuePage(db, req(query));
    const def = await get("tab=all");
    assert.deepEqual(def.rows.map((r) => `${r.repo}#${r.number}`), ["off#3", "app#2", "app#1", "app#3"]);
    assert.deepEqual(def.rows.slice(0, 2).map((r) => r.fast), [{ position: 1, of: 2 }, { position: 2, of: 2 }]);
    const all = await get("tab=all&repos=all");
    assert.equal(all.rows.length, 6);
    assert.deepEqual((await get("tab=all&repos=off")).rows.map((r) => r.number), [3, 1, 2]);
    const merge = await get("tab=merge");
    assert.deepEqual(merge.nextMerges.map((n) => `${n.repo}#${n.number}`), ["off#3", "app#2", "app#1", "app#3"]);
    assert.equal(merge.nextMerges[0]!.waitsFor, "ready");
  });
});

const user = { login: "op", role: "operator" as const, canWrite: async () => true, canRead: async () => true };
function req(query: string): Req {
  return { method: "GET", path: "/", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), user, csrf: "", nonce: "" } as unknown as Req;
}

describe("merge holds", () => {
  const saved = process.env.CRAFT_AUTO_DIFF_CACHE;
  after(() => { if (saved === undefined) delete process.env.CRAFT_AUTO_DIFF_CACHE; else process.env.CRAFT_AUTO_DIFF_CACHE = saved; });
  const diffs: DiffFetcher = async (_repo, n) => ({ ok: true, text: `diff --git a/src/pr${n}.rs b/src/pr${n}.rs\n--- a/src/pr${n}.rs\n+++ b/src/pr${n}.rs\n@@ -1 +1 @@\n-a\n+b\n` });

  test("a held PR is skipped by the single and the batch merge and comes back on release; the queue still shows it, held", async () => {
    const db = fresh();
    process.env.CRAFT_AUTO_DIFF_CACHE = mkdtempSync(join(dir, "diffs-"));
    assert.deepEqual([...(await planSingles(db, "app", diffs))!].sort(), [1, 2, 3]);
    assert.ok(holdMerge(db, "op", "app", 2));
    assert.equal(holdMerge(db, "op", "app", 2), false);
    assert.deepEqual([...(await planSingles(db, "app", diffs))!].sort(), [1, 3]);
    assert.deepEqual(await mergeOrder(db, "app"), ["app#1", "app#3"]);
    const e = buildQueue(db, { repo: "app", merged: "exclude" }).find((x) => x.number === 2)!;
    assert.deepEqual([e.state, e.held], ["ready", true]);
    assert.equal((await queuePage(db, req("tab=merge"))).nextMerges.at(-1)!.waitsFor, "held");
    assert.ok(releaseMerge(db, "op", "app", 2));
    assert.deepEqual([...(await planSingles(db, "app", diffs))!].sort(), [1, 2, 3]);
    assert.deepEqual(db.prepare("SELECT action FROM audit WHERE action LIKE 'merge-%' ORDER BY rowid").all().map((r) => (r as { action: string }).action), ["merge-hold", "merge-release"]);
  });
});

describe("batch controls", () => {
  // Writes go through an injected exec that records the `gh` calls; nothing reaches GitHub.
  const fakeGh = (code = 0) => {
    const calls: string[][] = [];
    const run: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code, stdout: "", stderr: code ? "boom" : "" }; };
    return { calls, run };
  };
  function withBatch(db: DatabaseSync, branch: string, nums: number[], pr: number | null = 90): number {
    const id = insertBatch(db, { repo: "app", branch, baseSha: "b".repeat(40), commitSha: "c".repeat(40), parentId: null, taskId: null, members: nums.map((n) => ({ number: n, head_oid: `sha${n}` })), at: T0 });
    updateBatch(db, id, T0, pr === null ? {} : { state: "open", pr_number: pr, pr_url: `https://github.com/storytold/app/pull/${pr}` });
    return id;
  }
  const stateOf = (db: DatabaseSync, id: number) => (db.prepare("SELECT state, summary FROM merge_batches WHERE id = ?").get(id) as { state: string; summary: string }).state;

  test("stop batch closes the batch PR through the write path, audits it and holds each member so the next run does not re-batch them", async () => {
    const db = fresh();
    const id = withBatch(db, "integration-app-20260101-1", [1, 2]);
    assert.deepEqual(buildQueue(db, { repo: "app", merged: "exclude" }).filter((e) => e.state === "in-batch").map((e) => e.number), [1, 2]);
    const gh = fakeGh();
    const out = await stopBatch(db, "op", id, gh.run);
    assert.deepEqual([out.closed, out.prs, out.held], [90, [1, 2], [1, 2]]);
    assert.deepEqual(gh.calls.map((c) => c.slice(0, 4)), [["gh", "pr", "close", "90"]]);
    assert.equal(stateOf(db, id), "superseded");
    const q = buildQueue(db, { repo: "app", merged: "exclude" });
    assert.deepEqual(q.filter((e) => e.number <= 2).map((e) => [e.state, e.held]), [["ready", true], ["ready", true]]);
    assert.deepEqual(await mergeOrder(db, "app"), ["app#3"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'merge-hold'").get()!.n, 2);
    releaseMerge(db, "op", "app", 1);
    assert.deepEqual(await mergeOrder(db, "app"), ["app#1", "app#3"]);
    const actions = db.prepare("SELECT action, details FROM audit WHERE action IN ('batch-stop', 'batch-pr-close') ORDER BY rowid").all() as { action: string; details: string }[];
    assert.deepEqual(actions.map((a) => a.action), ["batch-stop", "batch-pr-close"]);
    assert.equal(JSON.parse(actions[1]!.details).state, "done");
    await assert.rejects(() => stopBatch(db, "op", id, gh.run), /not in flight/);
  });

  test("remove from batch holds the PR and ends the batch with a close; the others become eligible for a new batch", async () => {
    const db = fresh();
    const id = withBatch(db, "integration-app-20260101-1", [1, 2, 3]);
    const gh = fakeGh();
    const out = await removeFromBatch(db, "op", "app", 2, gh.run);
    assert.equal(out.closed, 90);
    assert.equal(gh.calls.length, 1);
    assert.equal(stateOf(db, id), "superseded");
    assert.equal(membersOf(db, id).length, 3);
    const q = buildQueue(db, { repo: "app", merged: "exclude" });
    assert.deepEqual(q.map((e) => [e.number, e.state, e.held]), [[1, "ready", false], [2, "ready", true], [3, "ready", false]]);
    await assert.rejects(() => removeFromBatch(db, "op", "app", 1, gh.run), /not in a batch/);
  });

  test("a batch still being checked has no PR to close, and a failed close is reported and leaves the batch in flight to retry", async () => {
    const db = fresh();
    const a = withBatch(db, "integration-app-20260101-1", [1], null);
    const quiet = fakeGh();
    assert.equal((await stopBatch(db, "op", a, quiet.run)).closed, null);
    assert.equal(quiet.calls.length, 0);
    const b = withBatch(db, "integration-app-20260101-2", [3]);
    await assert.rejects(() => stopBatch(db, "op", b, fakeGh(1).run), (e: unknown) => (e as { status: number }).status === 502);
    assert.equal(stateOf(db, b), "open");
    const row = db.prepare("SELECT details FROM audit WHERE action = 'batch-pr-close'").get() as { details: string };
    assert.equal(JSON.parse(row.details).state, "failed");
  });
});
