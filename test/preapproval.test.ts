// The pre-approved merge: a fix-up pushed, a take review, green CI and the hand-over to the merge queue; and a foreign push that cancels it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { actionable } from "../src/decisions.ts";
import { mergeDecisionId } from "../src/core/rules.ts";
import { advancePreapprovals, preapprovalOf, runPipelineStep } from "../src/preapproval/index.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = (): World => (current = world().repo());
afterEach(() => current?.close());

const start = (w: World, n: number, merge = true) =>
  runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge }, by: OPERATOR });
const pushed = (w: World, n: number, to: string) =>
  w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at, source) VALUES ('app', ?, ?, ?, 'pushed', 1, ?, 'operator')").run(n, `sha${n}`, to, T0);
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
});
