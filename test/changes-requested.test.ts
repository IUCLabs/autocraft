import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { changesRequestedBy, failureNote, recordGate, recordGateFailure, type ReviewFact } from "../src/merge/changes-requested.ts";
import { runBatches } from "../src/merge/batch.ts";
import { activeBatches, membersOf, setBatchSize } from "../src/merge/batch-store.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { safeMerge } from "../src/merge/safe-merge.ts";
import { dir, fresh, world, deps, finishTask, T0 } from "./batch-fixture.ts";

const quiet = () => {};
const states = (db: DatabaseSync) => Object.fromEntries(buildQueue(db, { repo: "app" }).map((e) => [e.number, e.state]));
let seq = 0;
/** Mirrors a review the way the sync stores it. */
function review(db: DatabaseSync, n: number, author: string, state: string, association: string, at: string): void {
  db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, review_state, counted, author_association) VALUES ('app', ?, ?, 'review', ?, ?, '', ?, 0, ?)")
    .run(n, `rv${++seq}`, author, at, state, association);
}

describe("changes requested: rule", () => {
  const r = (author: string, state: string, at: string, association = "MEMBER"): ReviewFact => ({ author, association, state, at });
  test("latest formal review per maintainer decides", () => {
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1")]), ["ana"]);
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "APPROVED", "2")]), []);
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "DISMISSED", "2")]), []);
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "COMMENTED", "2")]), ["ana"]);
    assert.deepEqual(changesRequestedBy([r("ana", "APPROVED", "1"), r("ana", "CHANGES_REQUESTED", "2")]), ["ana"]);
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1"), r("bo", "APPROVED", "2")]), ["ana"]);
    assert.deepEqual(changesRequestedBy([r("stranger", "CHANGES_REQUESTED", "1", "NONE")]), []);
    // The association is relative to the viewer, so a contributor or an unknown one may still be a maintainer.
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1", "CONTRIBUTOR")]), ["ana"]);
    assert.deepEqual(changesRequestedBy([r("ana", "CHANGES_REQUESTED", "1", null as unknown as string)]), ["ana"]);
  });
});

describe("changes requested: queue", () => {
  test("a member's block makes the PR ineligible; approval, dismissal, comments and strangers behave as GitHub does", () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
    review(db, 1, "ana", "CHANGES_REQUESTED", "COLLABORATOR", "2026-01-01T01:00:00Z");
    review(db, 2, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    review(db, 2, "ana", "APPROVED", "MEMBER", "2026-01-01T02:00:00Z");
    review(db, 3, "ana", "CHANGES_REQUESTED", "OWNER", "2026-01-01T01:00:00Z");
    review(db, 3, "ana", "DISMISSED", "OWNER", "2026-01-01T02:00:00Z");
    review(db, 4, "visitor", "CHANGES_REQUESTED", "NONE", "2026-01-01T01:00:00Z");
    review(db, 5, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    review(db, 5, "ana", "COMMENTED", "MEMBER", "2026-01-01T02:00:00Z");
    assert.deepEqual(states(db), { 1: "changes-requested", 2: "ready", 3: "ready", 4: "ready", 5: "changes-requested" });
    assert.deepEqual(buildQueue(db, { repo: "app" }).filter(eligible).map((e) => e.number), [2, 3, 4]);
  });

  test("GitHub's review decision blocks too, and a row without association blocks until refreshed", () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    db.prepare("UPDATE items SET review_decision = 'CHANGES_REQUESTED' WHERE number = 1").run();
    db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, review_state) VALUES ('app', 2, 'old', 'review', 'ana', '2026-01-01T01:00:00Z', '', 'CHANGES_REQUESTED')").run();
    assert.deepEqual(states(db), { 1: "changes-requested", 2: "changes-requested" });
  });

  test("no Merge? question is asked while blocked, and an open one is withdrawn", () => {
    const db = fresh([{ n: 1, author: "newcomer" }, { n: 2, author: "newcomer" }]);
    assert.deepEqual(askMergeDecisions(db, { at: T0 }).sort(), [mergeDecisionId("app", 1, "sha1"), mergeDecisionId("app", 2, "sha2")]);
    review(db, 1, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    recordGate(db, "app", 1, [{ id: "x", author: "ana", association: "NONE", state: "CHANGES_REQUESTED", at: "2026-01-03T00:00:00Z" }], null);
    assert.deepEqual(askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" }), []);
    const d = db.prepare("SELECT id, answer, answered_by FROM decisions WHERE id LIKE 'app#1:merge@sha1%'").all() as { id: string; answer: string | null; answered_by: string }[];
    assert.equal(d.length, 1);
    assert.match(d[0]!.id, /~replaced-/);
    assert.deepEqual([d[0]!.answer, d[0]!.answered_by], ["withdrawn", "pipeline"]);
    assert.equal(states(db)[1], "changes-requested");
    assert.equal(states(db)[2], "needs-decision");
    // The block clears: the question is asked again.
    review(db, 1, "ana", "APPROVED", "MEMBER", "2026-01-04T00:00:00Z");
    recordGate(db, "app", 1, [], null);
    assert.deepEqual(askMergeDecisions(db, { at: "2026-01-05T00:00:00Z" }), [mergeDecisionId("app", 1, "sha1")]);
  });
});

describe("changes requested: live reads", () => {
  const ana: ReviewFact = { id: "x", author: "ana", association: "NONE", state: "CHANGES_REQUESTED", at: "2026-01-03T00:00:00Z" };
  test("a live read survives a sync, and decides over the mirror until the PR changes", () => {
    const db = fresh([{ n: 1 }]);
    recordGate(db, "app", 1, [ana], null);
    // A sync rewrites the PR's comments and knows nothing of the block.
    db.prepare("DELETE FROM comments WHERE repo = 'app' AND number = 1").run();
    assert.equal(states(db)[1], "changes-requested");
    // A newer live read that finds none clears it even though the mirror says otherwise.
    review(db, 1, "bo", "CHANGES_REQUESTED", "CONTRIBUTOR", "2026-01-03T00:00:00Z");
    recordGate(db, "app", 1, [], null);
    assert.equal(states(db)[1], "ready");
    // The PR changes after the read: the mirror decides again until the next read.
    db.prepare("UPDATE items SET updated_at = '2999-01-01T00:00:00Z' WHERE number = 1").run();
    assert.equal(states(db)[1], "changes-requested");
  });

  test("the queue says so after three failed reads in a row", () => {
    const db = fresh([{ n: 1 }]);
    const note = () => buildQueue(db, { repo: "app" })[0]!.note;
    recordGateFailure(db, "app", 1); recordGateFailure(db, "app", 1);
    assert.equal(note(), null);
    recordGateFailure(db, "app", 1);
    assert.equal(note(), failureNote(3));
    recordGate(db, "app", 1, [], null);
    assert.equal(note(), null);
  });
});

describe("changes requested: decisions", () => {
  test("a hold answer stands when the PR becomes blocked; a merge answer is set aside", () => {
    const db = fresh([{ n: 1, author: "newcomer" }, { n: 2, author: "newcomer" }]);
    askMergeDecisions(db, { at: T0 });
    db.prepare("UPDATE decisions SET answer = 'hold', answered_by = 'op', answered_at = ?, applied_at = ? WHERE id = ?").run(T0, T0, mergeDecisionId("app", 1, "sha1"));
    db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = ? WHERE id = ?").run(T0, mergeDecisionId("app", 2, "sha2"));
    review(db, 1, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    review(db, 2, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    recordGate(db, "app", 1, [{ id: "x", author: "ana", association: "NONE", state: "CHANGES_REQUESTED", at: "2026-01-03T00:00:00Z" }], null);
    recordGate(db, "app", 2, [{ id: "x", author: "ana", association: "NONE", state: "CHANGES_REQUESTED", at: "2026-01-03T00:00:00Z" }], null);
    // Declined PRs are not blocked-state entries in the queue; only the merge answer is withdrawn.
    askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id = ?").get(mergeDecisionId("app", 1, "sha1")) as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id = ?").get(mergeDecisionId("app", 2, "sha2")) as { n: number }).n, 0);
  });
});

describe("changes requested: withdrawal source", () => {
  test("a mirror-only block leaves an operator's merge answer in place; a live block withdraws it", () => {
    const db = fresh([{ n: 1, author: "newcomer" }]);
    const id = mergeDecisionId("app", 1, "sha1");
    askMergeDecisions(db, { at: T0 });
    db.prepare("UPDATE decisions SET answer = 'merge', answered_by = 'op', answered_at = ? WHERE id = ?").run(T0, id);
    review(db, 1, "ana", "CHANGES_REQUESTED", "CONTRIBUTOR", "2026-01-01T01:00:00Z");
    askMergeDecisions(db, { at: "2026-01-03T00:00:00Z" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id = ?").get(id) as { n: number }).n, 1);
    recordGate(db, "app", 1, [{ id: "x", author: "ana", association: "NONE", state: "CHANGES_REQUESTED", at: "2026-01-03T00:00:00Z" }], null);
    askMergeDecisions(db, { at: "2026-01-04T00:00:00Z" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id = ?").get(id) as { n: number }).n, 0);
  });
});

describe("changes requested: safe-merge", () => {
  const pr = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: "abc", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] };
  function gh(people: { reviews?: object[]; reviewDecision?: string | null }, calls: string[] = []) {
    return async (args: string[]): Promise<string> => {
      const json = args[args.indexOf("--json") + 1] ?? "";
      calls.push(args.slice(0, 2).join(" ") + " " + json);
      if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: people.reviewDecision ?? null, latestOpinionatedReviews: { nodes: people.reviews ?? [] } } } } });
      if (args[0] === "api") return JSON.stringify({ workflow_runs: [] });
      if (json.startsWith("state,isDraft")) return JSON.stringify(pr);
      if (json.startsWith("author")) return JSON.stringify({ author: { login: "dev" }, commits: [{ authors: [{ login: "dev" }] }] });
      if (json === "state,mergeCommit") return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "def" } });
      return "";
    };
  }
  const nap = async () => {};
  const rev = (login: string, state: string, authorAssociation: string, submittedAt: string) => ({ author: { login }, authorAssociation, state, submittedAt });

  test("refuses while a maintainer's changes-requested review stands", async () => {
    const calls: string[] = [];
    const r = await safeMerge("o/app", "5", "--merge", [], gh({ reviews: [rev("ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T00:00:00Z"), rev("ana", "COMMENTED", "MEMBER", "2026-01-02T00:00:00Z")] }, calls), nap);
    assert.deepEqual(r, { merged: false, reason: "REFUSED o/app#5: changes requested by a maintainer (ana)" });
    assert.ok(!calls.some((c) => c.startsWith("pr merge")));
  });

  test("refuses on GitHub's review decision alone", async () => {
    const r = await safeMerge("o/app", "5", "--merge", [], gh({ reviews: [], reviewDecision: "CHANGES_REQUESTED" }), nap);
    assert.equal(r.merged, false);
  });

  test("a private member shown as NONE still blocks; approval and dismissal clear; the pipeline account's request counts", async () => {
    assert.equal((await safeMerge("o/app", "5", "--merge", [], gh({ reviews: [rev("ana", "CHANGES_REQUESTED", "NONE", "2026-01-01T00:00:00Z")] }), nap)).merged, false);
    assert.equal((await safeMerge("o/app", "5", "--merge", [], gh({ reviews: [rev("pipeline-bot", "CHANGES_REQUESTED", "CONTRIBUTOR", "2026-01-01T00:00:00Z")] }), nap)).merged, false);
    for (const reviews of [
      [rev("ana", "APPROVED", "MEMBER", "2026-01-02T00:00:00Z")],
      [rev("ana", "DISMISSED", "MEMBER", "2026-01-02T00:00:00Z")],
    ]) {
      const r = await safeMerge("o/app", "5", "--merge", [], gh({ reviews }), nap);
      assert.equal(r.merged, true);
    }
  });
});

describe("changes requested: batches", () => {
  test("a blocked PR is left out of a batch", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }]);
    setBatchSize(db, "app", 5);
    review(db, 2, "ana", "CHANGES_REQUESTED", "MEMBER", "2026-01-01T01:00:00Z");
    await runBatches(db, { repo: "app" }, quiet, deps(world(), join(dir, "cr1")));
    const b = activeBatches(db, "app")[0]!;
    assert.deepEqual(membersOf(db, b.id).map((m) => m.number), [1, 3]);
    assert.deepEqual(states(db), { 1: "batch-checking", 2: "changes-requested", 3: "batch-checking" });
  });

  test("a review on the batch PR itself fails the batch and holds its PRs", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    const w = world();
    const d = deps(w, join(dir, "cr3"));
    const query = d.querier.query.bind(d.querier);
    let blocked = false;
    d.querier.query = async (q: string, v: object) => {
      if (q.includes("reviewThreads") && blocked && (v as { number: number }).number === 900) {
        return { repository: { pullRequest: { author: null, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
          formal: { nodes: [{ id: "y", author: { login: "ana" }, authorAssociation: "NONE", createdAt: "2026-01-03T00:00:00Z", submittedAt: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED" }] } } } };
      }
      return query(q, v);
    };
    await runBatches(db, { repo: "app" }, quiet, d);
    finishTask(db, activeBatches(db, "app")[0]!.task_id!);
    await runBatches(db, { repo: "app" }, quiet, d);
    w.tip.set("tip", activeBatches(db, "app")[0]!.commit_sha);
    blocked = true;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.merged, []);
    assert.ok(!w.log.some((l) => l.startsWith("safe-merge-test")));
    assert.deepEqual(s.superseded, []);
    assert.deepEqual(activeBatches(db, "app"), []);
    assert.deepEqual(states(db), { 1: "batch-failed", 2: "batch-failed" });
  });

  test("a member that gets a changes-requested review before the batch PR merges is dropped, and nothing merges", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    setBatchSize(db, "app", 5);
    const w = world();
    const d = deps(w, join(dir, "cr2"));
    const query = d.querier.query.bind(d.querier);
    let blocked = false;
    d.querier.query = async (q: string, v: object) => {
      if (q.includes("reviewThreads") && blocked && (v as { number: number }).number === 2) {
        return { repository: { pullRequest: { author: null, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
          formal: { nodes: [{ id: "x", author: { login: "ana" }, authorAssociation: "MEMBER", createdAt: "2026-01-03T00:00:00Z", submittedAt: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED" }] } } } };
      }
      return query(q, v);
    };
    await runBatches(db, { repo: "app" }, quiet, d);
    const first = activeBatches(db, "app")[0]!;
    finishTask(db, first.task_id!);
    await runBatches(db, { repo: "app" }, quiet, d);
    w.tip.set("tip", activeBatches(db, "app")[0]!.commit_sha);
    blocked = true;
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.merged, []);
    assert.ok(s.superseded.length >= 1);
    // The live result is written back, so the queue agrees and the PR is not batched again.
    assert.equal(states(db)[2], "changes-requested");
    assert.deepEqual(activeBatches(db, "app").flatMap((b) => membersOf(db, b.id).map((m) => m.number)), [1]);
    assert.ok(!w.log.some((l) => l.startsWith("safe-merge-test")));
  });
});
