// An operator's answer is final: a pre-approval whose review cannot proceed asks a Merge question, and a sure re-review keeps an answered merge.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { advancePreapprovals, preapprovalOf, runPipelineStep } from "../src/preapproval/index.ts";
import { recordReviewFailure, reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = (): World => (current = world().repo());
afterEach(() => current?.close());

const save = (w: World, n: number, head: string, verdict: "take" | "hold", sure: boolean, blocked: string[] = []) =>
  saveOpus(w.db, "rv", { repo: "app", number: n, head_oid: head }, {
    mode: "full", base: null, model: "m",
    review: { ref: `app#${n}`, verdict, sure, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: blocked },
  });
const startPushed = async (w: World, n: number, to: string) => {
  await runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge: true }, by: OPERATOR });
  const fix = w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n)[0]!.id as number;
  w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at, source, operator_fix) VALUES ('app', ?, ?, ?, 'pushed', 1, ?, 'operator', ?)").run(n, `sha${n}`, to, T0, fix);
  w.synced(n, to);
};
const settle = (w: World) => { for (let i = 0; i < 5; i++) advancePreapprovals(w.db); };

describe("pre-approval and review holds", () => {
  test("the fix-up push lifts a blocked hold; a review that failed for good asks a Merge question", async () => {
    const w = fresh().pr(1).review(1, { verdict: "take-fix" }).pr(2).pr(3).review(3, { verdict: "take-fix" });
    w.db.prepare("UPDATE opus_reviews SET verdict = 'hold' WHERE number = 1").run();
    save(w, 1, "sha1", "hold", true, ["app#2"]);
    await startPushed(w, 1, "sha1b");
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "review", String(preapprovalOf(w.db, "app", 1)?.reason));
    assert.equal(reviewHold(w.db, "app", 1, "sha1b"), null);

    await startPushed(w, 3, "sha3b");
    for (let i = 0; i < 4; i++) recordReviewFailure(w.db, "app", 3, "sha3b");
    settle(w);
    assert.equal(preapprovalOf(w.db, "app", 3)?.state, "asked");
    assert.equal(w.rows("SELECT 1 FROM decisions WHERE id = ?", mergeDecisionId("app", 3, "sha3b")).length, 1);
  });
});

describe("a re-review at the same head", () => {
  test("keeps an answered, unapplied merge answer while sure take, and withdraws it with the reason on a hold", () => {
    const w = fresh().pr(1).review(1).answer(1, "merge");
    const id = mergeDecisionId("app", 1, "sha1");
    save(w, 1, "sha1", "take", true);
    assert.equal(w.rows("SELECT answer FROM decisions WHERE id = ?", id)[0]?.answer, "merge");
    save(w, 1, "sha1", "hold", true);
    assert.equal(w.rows("SELECT 1 FROM decisions WHERE id = ?", id).length, 0);
    assert.match(String(w.rows("SELECT answer_note FROM decisions WHERE id LIKE ?", `${id}~replaced-%`)[0]?.answer_note), /new review is a hold/);
  });
});
