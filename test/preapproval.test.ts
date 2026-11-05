// The pre-approved merge: a fix-up pushed, a take review, green CI and the hand-over to the merge queue; and a foreign push that cancels it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { actionable } from "../src/decisions.ts";
import { mergeDecisionId } from "../src/core/rules.ts";
import { advancePreapprovals, cancelPreapproval, preapprovalOf, runPipelineStep } from "../src/preapproval/index.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = (): World => (current = world().repo());
afterEach(() => current?.close());

const start = (w: World, n: number, merge = true) =>
  runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge }, by: OPERATOR });
const fixId = (w: World, n: number): number => (w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n)[0]!.id as number);
const fixRow = (w: World, n: number, state: string, to: string | null = null) =>
  w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at, source, operator_fix) VALUES ('app', ?, ?, ?, ?, 1, ?, 'operator', ?)").run(n, `sha${n}`, to, state, T0, fixId(w, n));
const pushed = (w: World, n: number, to: string) => fixRow(w, n, "pushed", to);
const kindsOf = (w: World, n: number) => w.prPlan(n).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
/** A pre-approved merge whose fix-up pushed `<n>b` and whose sure take review of it exists: it waits in ci for CI and the pre-merge review. */
const inCi = async (w: World, n: number) => {
  await start(w, n);
  pushed(w, n, `sha${n}b`);
  w.synced(n, `sha${n}b`).review(n, { head: `sha${n}b` });
  settle(w);
  assert.equal(preapprovalOf(w.db, "app", n)?.state, "ci");
};
const answerOf = (w: World, n: number, head: string) => w.rows("SELECT answer FROM decisions WHERE id = ?", mergeDecisionId("app", n, head));
const settle = (w: World) => { for (let i = 0; i < 5; i++) advancePreapprovals(w.db); };

describe("pre-approved merge", () => {
  test("fix-up pushed, review take, CI green: the Merge answer is written for the operator", async () => {
    const w = fresh().pr(1).review(1, { verdict: "take-fix" });
    await start(w, 1);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "fixup");
    // The planner works the operator's fix-up and merges nothing meanwhile.
    const kinds = w.prPlan(1).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
    assert.ok(kinds.includes("fixup:operator"), kinds.join());
    assert.ok(!kinds.some((k) => k.startsWith("fixup:review") || k.startsWith("merge")), kinds.join());

    pushed(w, 1, "sha1b");
    w.synced(1, "sha1b");
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "review");
    assert.equal(preapprovalOf(w.db, "app", 1)?.head, "sha1b");

    w.review(1, { head: "sha1b" });
    settle(w);
    // CI is green, but the pre-merge review of the pushed head comes first.
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "ci");
    assert.ok(kindsOf(w, 1).includes("premerge:"), kindsOf(w, 1).join());
    w.premerge(1, "clean");
    settle(w);
    const p = preapprovalOf(w.db, "app", 1)!;
    assert.equal(p.state, "queued");
    const id = mergeDecisionId("app", 1, "sha1b");
    assert.deepEqual(actionable(w.db).filter((a) => a.id === id).map((a) => [a.answer, a.kind]), [["merge", "merge"]]);
    assert.ok(w.rows("SELECT state FROM preapprovals").every((r) => r.state === "queued"));
    assert.ok(w.rows("SELECT action FROM audit WHERE target = 'app#1' AND action = 'preapproval'").length >= 4);
  });

  test("a push by someone else cancels it, and a red CI asks a Merge question instead", async () => {
    const w = fresh().pr(2).review(2, { verdict: "take-fix" }).pr(3).review(3, { verdict: "take-fix" });
    await start(w, 2);
    w.synced(2, "foreign");
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 2)?.state, "cancelled");
    assert.equal(w.rows("SELECT state FROM operator_fixups WHERE number = 2")[0]!.state, "ended");

    await start(w, 3);
    pushed(w, 3, "sha3b");
    w.synced(3, "sha3b").review(3, { head: "sha3b" });
    w.db.prepare("UPDATE pr_checks SET overall = 'failure' WHERE number = 3").run();
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 3)?.state, "asked");
    const q = w.rows("SELECT answer FROM decisions WHERE id = ?", mergeDecisionId("app", 3, "sha3b"));
    assert.deepEqual(q, [{ answer: null }]);
  });

  test("a sure take review does not let the queue merge or ask while the pre-approval waits", async () => {
    const w = fresh().pr(8).review(8).verified(8).premerge(8, "clean");
    assert.ok(kindsOf(w, 8).some((k) => k.startsWith("merge")), kindsOf(w, 8).join());
    await start(w, 8);
    assert.ok(!kindsOf(w, 8).some((k) => k.startsWith("merge") || k.startsWith("ask-merge")), kindsOf(w, 8).join());
  });

  test("an unsure or non-take review of the push asks a Merge question", async () => {
    const w = fresh().pr(4).review(4, { verdict: "take-fix" });
    await start(w, 4);
    pushed(w, 4, "sha4b");
    w.synced(4, "sha4b").review(4, { head: "sha4b", sure: false });
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 4)?.state, "asked");
    assert.deepEqual(answerOf(w, 4, "sha4b"), [{ answer: null }]);
  });

  test("a re-review that turns unsure during ci hands nothing over", async () => {
    const w = fresh().pr(5).review(5, { verdict: "take-fix" });
    await inCi(w, 5);
    w.premerge(5, "clean");
    w.db.prepare("UPDATE opus_reviews SET sure = 0 WHERE number = 5 AND head_oid = 'sha5b'").run();
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 5)?.state, "asked");
    assert.deepEqual(answerOf(w, 5, "sha5b"), [{ answer: null }]);
  });

  test("the pre-merge review gates the hand-over: no review waits, a defect asks", async () => {
    const w = fresh().pr(9).review(9, { verdict: "take-fix" }).pr(10).review(10, { verdict: "take-fix" });
    await inCi(w, 9);
    assert.equal(w.rows("SELECT 1 FROM decisions WHERE id = ?", mergeDecisionId("app", 9, "sha9b")).length, 0);
    await inCi(w, 10);
    w.premerge(10, "defect", false);
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 10)?.state, "asked");
    assert.deepEqual(answerOf(w, 10, "sha10b"), [{ answer: null }]);
  });

  test("cancelling after the hand-over takes the Merge answer back, and the cancelled row stays cancelled", async () => {
    const w = fresh().pr(6).review(6, { verdict: "take-fix" });
    await inCi(w, 6);
    w.premerge(6, "clean");
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 6)?.state, "queued");
    assert.deepEqual(answerOf(w, 6, "sha6b"), [{ answer: "merge" }]);
    assert.equal(cancelPreapproval(w.db, OPERATOR, "app", 6).state, "cancelled");
    assert.deepEqual(answerOf(w, 6, "sha6b"), [{ answer: null }]);
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 6)?.state, "cancelled");
    assert.deepEqual(actionable(w.db).filter((a) => a.id === mergeDecisionId("app", 6, "sha6b")), []);
  });

  test("an operator fix-up stored for linting is planned for its lint check, and a dropped one ends the request instead of looping", async () => {
    const w = fresh().pr(11).pr(12);
    await start(w, 11);
    fixRow(w, 11, "linting");
    const kinds = kindsOf(w, 11);
    assert.ok(!kinds.includes("fixup:operator"), kinds.join());
    assert.ok(kinds.includes("lint:operator"), kinds.join());

    await start(w, 12);
    fixRow(w, 12, "superseded");
    assert.ok(!kindsOf(w, 12).includes("fixup:operator"), kindsOf(w, 12).join());
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 12)?.state, "failed");
  });
});
