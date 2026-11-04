// The decision table for open PRs, review to merge: facts overrides in, state, path and due actions out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr } from "../src/core/decide.ts";
import { PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, UNSURE_REASON } from "../src/core/rules.ts";
import { QUEUE_STATES, type Plan, type PrFacts } from "../src/core/plan.ts";
import { NOW, REVIEW_AT, prFacts } from "./world.ts";

type Over = Parameters<typeof prFacts>[0];
type Row = { name: string; facts: Over; expect: { state: string; path?: "rule" | "operator" | null; actions?: string[]; reasons?: string[]; eligible?: boolean; note?: string } };

const tokens = (p: Plan): string[] => p.actions.map((a) => (typeof a.params?.bucket === "string" ? `${a.kind}:${a.params.bucket}` : a.kind)).sort();
const SIZE_L = { size: "L", lines: 900 } as const;
const answered = (answer: string, after = true) => ({ asked: true, answer, mergeAnswerAfterReview: after });
const premerge = (o: Partial<NonNullable<PrFacts["premerge"]>>) => ({ at: "2026-11-04T10:30:00.000Z", tries: 0, hasFindings: true, defects: 0, defectsAllFixable: true, minor: 0, error: null, ...o });
const runs = (o: Partial<NonNullable<PrFacts["runs"]>> = {}) => ({ waiting: 1, reread: false, crossRepo: true, approvable: 1, ...o });

const rows: Row[] = [
  // ---- the rule path
  { name: "clean rule PR is ready and merges", facts: {}, expect: { state: "ready", path: "rule", actions: ["merge"], reasons: [], eligible: true } },
  { name: "take-fix goes to fix-up, outside the rule", facts: { review: { verdict: "take-fix" } }, expect: { state: "needs-fix-up", path: null, actions: [], reasons: ["review asks for fixes"] } },
  { name: "size L is outside the rule and asked about", facts: SIZE_L, expect: { state: "needs-decision", path: null, actions: ["ask-merge"], reasons: ["size L"] } },
  { name: "other label", facts: { label: "performance" }, expect: { state: "needs-decision", reasons: ["label performance"], actions: ["ask-merge"] } },
  { name: "no settled label", facts: { label: null }, expect: { state: "needs-decision", reasons: ["no settled label"], actions: ["ask-merge"] } },
  { name: "tier not on the whitelist", facts: { tier: "not" }, expect: { state: "needs-decision", reasons: ["author not on the whitelist"] } },
  { name: "unknown author", facts: { tier: "not", author: null }, expect: { state: "needs-decision", reasons: ["author unknown"] } },
  { name: "allow tier counts as whitelisted", facts: { tier: "allow" }, expect: { state: "ready", path: "rule" } },
  { name: "review mode skipped never merges by rule", facts: { review: { mode: "skipped" } }, expect: { state: "needs-decision", reasons: ["the review was skipped"], actions: ["ask-merge"] } },
  { name: "an open Merge? question counts against the rule", facts: { decision: { openQuestion: true } }, expect: { state: "needs-decision", reasons: ["a Merge? question is still open"] } },
  { name: "verification unavailable puts it outside the rule", facts: { verification: { state: "unavailable", summary: "the repo is private" } }, expect: { state: "needs-decision", reasons: ["not verified: the repo is private"], actions: ["ask-merge"] } },
  { name: "no CI in the repo puts it outside the rule", facts: { ci: "none", repoFacts: { noCi: true } }, expect: { state: "needs-decision", reasons: ["the repo has no CI checks"] } },
  { name: "several reasons keep the queue's order", facts: { ...SIZE_L, label: "infra", tier: "not", review: { verdict: "take-fix" } }, expect: { state: "needs-fix-up", reasons: ["review asks for fixes", "size L", "author not on the whitelist"] } },

  // ---- unsure heads and operator answers
  { name: "unsure head does not merge by rule", facts: { review: { unsure: true } }, expect: { state: "needs-decision", path: null, actions: ["ask-merge"], reasons: [UNSURE_REASON] } },
  { name: "unsure head, Merge answer given before the review, does not merge", facts: { review: { unsure: true }, decision: answered("merge", false) }, expect: { state: "needs-decision", path: null, actions: [] } },
  { name: "unsure head, Merge answer after the review, merges as operator", facts: { review: { unsure: true }, decision: answered("merge", true) }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"], reasons: [UNSURE_REASON] } },
  { name: "unsure head, Hold answer is declined and does not merge", facts: { review: { unsure: true }, decision: answered("hold") }, expect: { state: "declined", actions: [] } },
  { name: "Hold answer on a PR outside the rule: no merge", facts: { ...SIZE_L, decision: answered("hold") }, expect: { state: "declined", path: null, actions: [] } },
  { name: "Hold answer blocks the pre-merge fix-up", facts: { ...SIZE_L, decision: answered("hold") , premerge: premerge({ defects: 1 }) }, expect: { state: "declined", actions: [] } },
  { name: "Merge answer on a large PR merges as operator", facts: { ...SIZE_L, decision: answered("merge") }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"], eligible: true } },
  { name: "asked and unanswered: waits, no second question", facts: { ...SIZE_L, decision: { asked: true } }, expect: { state: "needs-decision", actions: [] } },
  { name: "member of an open duplicate group is asked later", facts: { ...SIZE_L, decision: { inOpenGroup: true } }, expect: { state: "needs-decision", actions: [] } },
  { name: "operator Merge answer accepts a repo without CI", facts: { ...SIZE_L, ci: "none", repoFacts: { noCi: true }, decision: answered("merge") }, expect: { state: "decision-answered-merge", actions: ["merge"], eligible: true } },
  { name: "operator Merge answer on an unverifiable repo merges", facts: { verification: { state: "unavailable", summary: "x" }, decision: answered("merge") }, expect: { state: "decision-answered-merge", actions: ["merge"] } },

  // ---- order of the state rules
  { name: "conflicting PR", facts: { mergeable: "CONFLICTING", conflict: { bucket: "merge", base: "main" } }, expect: { state: "conflict", path: "rule", actions: [], note: "conflict: merging main" } },
  { name: "failed CI", facts: { ci: "failure" }, expect: { state: "ci-failed", actions: [] } },
  { name: "conflict outranks failed CI", facts: { ci: "failure", mergeable: "CONFLICTING" }, expect: { state: "conflict" } },
  { name: "failed CI on a PR outside the rule", facts: { ...SIZE_L, ci: "failure" }, expect: { state: "ci-failed", actions: [] } },
  { name: "runs waiting for approval", facts: { runs: runs({ waiting: 2 }) }, expect: { state: "ci-approval", actions: ["approve-ci"] } },
  { name: "CI pending", facts: { ci: "pending" }, expect: { state: "waiting-ci", actions: [] } },
  { name: "mergeable not computed yet", facts: { mergeable: "UNKNOWN" }, expect: { state: "waiting-ci", actions: [] } },
  { name: "checks of another head: CI unknown", facts: { ci: "unknown", checksHere: false }, expect: { state: "waiting-ci" } },
  { name: "no verification yet", facts: { verification: null }, expect: { state: "waiting-verify", path: "rule", actions: ["verify:plan"] } },
  { name: "stale verification is verified again", facts: { verification: { state: "stale" } }, expect: { state: "waiting-verify", actions: ["verify:plan"] } },
  { name: "failed verification", facts: { verification: { state: "failed" } }, expect: { state: "verify-failed", actions: [] } },
  { name: "verification error", facts: { verification: { state: "error" } }, expect: { state: "verify-error", actions: [] } },
  { name: "CI is enough counts as verified", facts: { verification: { state: "ci-enough" } }, expect: { state: "ready", actions: ["merge"] } },
  { name: "outside the rule, not verified yet: no question before the result", facts: { ...SIZE_L, verification: null }, expect: { state: "waiting-verify", actions: ["verify:plan"] } },
  { name: "unavailable repo is Verify's second bucket", facts: { verification: null, verifyUnavailable: "the repo is private" }, expect: { state: "waiting-verify", actions: ["verify:unavailable"] } },

  // ---- pre-merge review
  { name: "no pre-merge review yet", facts: { premerge: null }, expect: { state: "waiting-premerge", path: "rule", actions: ["premerge"] } },
  { name: "no pre-merge review, merging not approved in the repo", facts: { premerge: null, repoFacts: { mergeApproved: false } }, expect: { state: "waiting-premerge", actions: [] } },
  { name: "failed try waits for its backoff", facts: { premerge: premerge({ hasFindings: false, tries: 1, at: new Date(NOW - 600_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: [] } },
  { name: "failed try is due after the backoff", facts: { premerge: premerge({ hasFindings: false, tries: 1, at: new Date(NOW - 3_700_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: ["premerge"] } },
  { name: "three failed tries: outside the rule", facts: { premerge: premerge({ hasFindings: false, tries: 3 }) }, expect: { state: "needs-decision", reasons: [PREMERGE_FAILED_REASON], actions: ["ask-merge"] } },
  { name: "defect without a fix is asked about", facts: { premerge: premerge({ defects: 1, defectsAllFixable: false }) }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON], actions: ["ask-merge"] } },
  { name: "fixable defects go to fix-up", facts: { premerge: premerge({ defects: 2 }) }, expect: { state: "needs-fix-up", path: "rule", actions: [], note: "pre-merge review: 2 defects to fix" } },
  { name: "one fixable defect is singular", facts: { premerge: premerge({ defects: 1 }) }, expect: { state: "needs-fix-up", note: "pre-merge review: 1 defect to fix" } },
  { name: "fix-up already used: defect", facts: { premerge: premerge({ defects: 1 }), premergeFixUsed: true }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "no push approval: defect", facts: { premerge: premerge({ defects: 1 }), repoFacts: { pushApproved: false } }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "branch not pushable: defect", facts: { premerge: premerge({ defects: 1 }), pushable: false }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "a Merge? decision at the head blocks the fix-up", facts: { premerge: premerge({ defects: 1 }), decision: { asked: true } }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON], actions: [] } },
  { name: "minor findings do not block", facts: { premerge: premerge({ minor: 3 }) }, expect: { state: "ready", actions: ["merge"] } },
  { name: "a PR outside the rule skips the pre-merge review", facts: { ...SIZE_L, premerge: null }, expect: { state: "needs-decision", actions: ["ask-merge"] } },

  // ---- merge, refusal, holds, batches, main CI
  { name: "refused PR with changed CI is retried", facts: { lastMerge: { outcome: "refused", reason: "x", ci: "pending", mergeable: "MERGEABLE" } }, expect: { state: "refused", path: "rule", actions: ["merge"], eligible: true } },
  { name: "refused PR in the same state waits, on every path", facts: { lastMerge: { outcome: "refused", reason: "x", ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "refused", actions: [], eligible: true } },
  { name: "refused PR waits also when it merges alone", facts: { verification: { state: "unavailable", summary: "s" }, decision: answered("merge"), lastMerge: { outcome: "refused", reason: "x", ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "refused", actions: [] } },
  { name: "refusal without a recorded CI state waits", facts: { lastMerge: { outcome: "refused", reason: "x", ci: null, mergeable: null } }, expect: { state: "refused", actions: [] } },
  { name: "approved runs after a refusal release it", facts: { lastMerge: { outcome: "refused", reason: "x", ci: "success", mergeable: "MERGEABLE" }, runsApprovedAfterMerge: true }, expect: { state: "refused", actions: ["merge"] } },
  { name: "held PR keeps its state and never merges", facts: { mergeHeld: true }, expect: { state: "ready", path: "rule", actions: [], eligible: false } },
  { name: "held PR with an operator answer never merges", facts: { ...SIZE_L, decision: answered("merge"), mergeHeld: true }, expect: { state: "decision-answered-merge", actions: [], eligible: false } },
  { name: "batch state replaces ready", facts: { batch: "in-batch" }, expect: { state: "in-batch", actions: [] } },
  { name: "batch state replaces waiting-ci", facts: { batch: "batch-checking", ci: "pending" }, expect: { state: "batch-checking" } },
  { name: "failed batch state", facts: { batch: "batch-failed" }, expect: { state: "batch-failed", actions: [] } },
  { name: "batch does not take a rule PR without a clean pre-merge review", facts: { batch: "in-batch", premerge: null }, expect: { state: "waiting-premerge" } },
  { name: "batch takes an operator-approved PR", facts: { ...SIZE_L, decision: answered("merge"), batch: "in-batch", premerge: null }, expect: { state: "in-batch" } },
  { name: "red main holds a ready PR", facts: { repoFacts: { mainRed: true } }, expect: { state: "waiting-main-ci", actions: [] } },
  { name: "red main does not hold the PR that fixes it", facts: { repoFacts: { mainRed: true }, mainFix: true }, expect: { state: "ready", actions: ["merge"] } },
  { name: "batch members keep the batch state while main is red", facts: { repoFacts: { mainRed: true }, batch: "in-batch" }, expect: { state: "in-batch" } },
  { name: "main fix merges alone", facts: { mainFix: true }, expect: { state: "ready", actions: ["merge"] } },

  // ---- changes requested, held, merged
  { name: "changes requested blocks a ready PR", facts: { changesRequested: { why: "changes requested by a maintainer (ana)", live: true } }, expect: { state: "changes-requested", path: null, actions: [], note: "changes requested by a maintainer (ana)" } },
  { name: "changes requested blocks an operator Merge answer", facts: { ...SIZE_L, decision: answered("merge"), changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "changes requested blocks the question", facts: { ...SIZE_L, changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "failed review reads give a note", facts: { gateFailureNote: "reviews could not be read from GitHub 3 times in a row", ...SIZE_L }, expect: { state: "needs-decision", note: "reviews could not be read from GitHub 3 times in a row" } },
  { name: "backlog hold wins over the rule", facts: { heldBacklog: true }, expect: { state: "held-backlog", actions: [] } },
  { name: "duplicate hold", facts: { heldDuplicate: true }, expect: { state: "held-duplicate", actions: [] } },
  { name: "merged PR", facts: { ghState: "MERGED" }, expect: { state: "merged", actions: [] } },
  { name: "PR merged by us before the mirror noticed", facts: { lastMerge: { outcome: "merged", reason: null, ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "merged", actions: [] } },

  // ---- open PRs outside the queue
  { name: "not reviewed yet", facts: { review: null }, expect: { state: "not-reviewed", path: null, actions: ["review"] } },
  { name: "review at an older head", facts: { head: "h2" }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "review made stale by the discussion", facts: { review: { stale: true, staleActionable: true } }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "stale review at the daily re-review cap waits", facts: { review: { stale: true, staleActionable: false } }, expect: { state: "review-stale", actions: [] } },
  { name: "a stale take is never verified or merged", facts: { review: { stale: true, staleActionable: true }, verification: null }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "label that gets no code review", facts: { review: null, label: "plugin candidate" }, expect: { state: "label-not-reviewed", actions: [] } },
  { name: "unclassified PR", facts: { review: null, label: null }, expect: { state: "label-not-reviewed", actions: [] } },
  { name: "needs-decision flag waits for a scope answer", facts: { review: null, needsDecisionFlag: true }, expect: { state: "scope", actions: [] } },
  { name: "scope answer take lets it be reviewed", facts: { review: null, needsDecisionFlag: true, scopeAnswer: "take" }, expect: { state: "not-reviewed", actions: ["review"] } },
  { name: "scope answer plugin keeps it out", facts: { review: null, scopeAnswer: "plugin" }, expect: { state: "scope", actions: [] } },
  { name: "draft without a review", facts: { review: null, draft: true }, expect: { state: "draft", actions: [] } },
  { name: "draft with a take review stays in the queue", facts: { draft: true, verification: null }, expect: { state: "waiting-verify", actions: [] } },
  { name: "Opus said hold", facts: { review: { verdict: "hold" } }, expect: { state: "opus-hold", actions: [] } },
  { name: "Opus said close", facts: { review: { verdict: "close" } }, expect: { state: "opus-close", actions: [] } },
  { name: "backlog without a review", facts: { review: null, heldBacklog: true }, expect: { state: "backlog", actions: [] } },
  { name: "duplicate hold without a review", facts: { review: null, heldDuplicate: true }, expect: { state: "duplicate", actions: [] } },
  { name: "outside the pilot", facts: { inScope: false }, expect: { state: "out-of-scope", actions: [] } },
  { name: "integration PR with runs to read", facts: { integration: true, runs: runs({ reread: true }) }, expect: { state: "integration", actions: ["approve-ci"] } },
  { name: "integration PR without runs", facts: { integration: true }, expect: { state: "integration", actions: [] } },

  // ---- other actions
  { name: "review not posted yet", facts: { post: { posted: null } }, expect: { state: "ready", actions: ["merge", "post-review"] } },
  { name: "newer review than the post is posted again", facts: { post: { posted: { head: "h1", at: "2026-11-04T09:00:00.000Z", opusAt: "2026-11-04T09:00:00.000Z" } } }, expect: { state: "ready", actions: ["merge", "post-review"] } },
  { name: "no public text, nothing posted", facts: { post: { postable: false, posted: null } }, expect: { state: "ready", actions: ["merge"] } },
  { name: "the pipeline's own PR gets no posted review", facts: { post: { posted: null }, authorIsPipeline: true }, expect: { state: "ready", actions: ["merge"] } },
  { name: "waiting runs of a fork PR are approved", facts: { runs: runs(), ci: "pending" }, expect: { state: "ci-approval", actions: ["approve-ci"] } },
  { name: "runs that failed twice are left to a person", facts: { runs: runs({ approvable: 0 }) }, expect: { state: "ci-approval", actions: [] } },
  { name: "runs of a same-repo PR are not approved", facts: { runs: runs({ crossRepo: false }) }, expect: { state: "ci-approval", actions: [] } },
  { name: "no approval of runs after an answer that is not Merge", facts: { ...SIZE_L, decision: answered("hold"), runs: runs() }, expect: { state: "declined", actions: [] } },
  { name: "no approval of runs for a held merge", facts: { runs: runs(), mergeHeld: true }, expect: { state: "ci-approval", actions: [] } },
  { name: "checks of another head: nothing to approve", facts: { runs: runs(), checksHere: false, ci: "unknown" }, expect: { state: "ci-approval", actions: [] } },
  { name: "failing CI is not verified", facts: { ci: "failure", verification: null }, expect: { state: "ci-failed", actions: [] } },
];

for (const row of rows) {
  test(row.name, () => {
    const p = decidePr(prFacts(row.facts));
    assert.equal(p.state, row.expect.state);
    if (row.expect.path !== undefined) assert.equal(p.path, row.expect.path);
    if (row.expect.actions) assert.deepEqual(tokens(p), [...row.expect.actions].sort());
    if (row.expect.reasons) assert.deepEqual(p.reasons, row.expect.reasons);
    if (row.expect.eligible !== undefined) assert.equal(p.eligible, row.expect.eligible);
    if (row.expect.note !== undefined) assert.equal(p.note, row.expect.note);
  });
}

// ---- safety rules, checked over many fact sets

const merges = (f: PrFacts): boolean => decidePr(f).actions.some((a) => a.kind === "merge");

test("a rule PR without a clean pre-merge review never gets merge", () => {
  for (const pm of [null, premerge({ hasFindings: false, tries: 1 }), premerge({ hasFindings: false, tries: 3 }), premerge({ defects: 1 }), premerge({ defects: 1, defectsAllFixable: false })]) {
    assert.equal(merges(prFacts({ premerge: pm })), false, JSON.stringify(pm));
  }
  assert.equal(merges(prFacts({ premerge: premerge({}) })), true);
});

test("an unsure head merges only on an operator Merge answer given after its latest review", () => {
  for (const decision of [{}, answered("merge", false), answered("hold"), answered("close")]) {
    assert.equal(merges(prFacts({ review: { unsure: true }, decision })), false, JSON.stringify(decision));
  }
  assert.equal(merges(prFacts({ review: { unsure: true }, decision: answered("merge", true) })), true);
});

test("a held PR never merges, whatever its path", () => {
  for (const over of [{}, { ...SIZE_L, decision: answered("merge") }, { review: { unsure: true }, decision: answered("merge") }]) {
    assert.equal(merges(prFacts({ ...over, mergeHeld: true })), false);
  }
});

test("a Hold answer means no merge and no pre-merge fix-up", () => {
  for (const over of [{ ...SIZE_L }, { review: { unsure: true } }, { premerge: premerge({ defects: 1 }) }]) {
    const p = decidePr(prFacts({ ...over, decision: answered("hold") }));
    assert.notEqual(p.state, "needs-fix-up");
    assert.equal(p.actions.some((a) => a.kind === "merge"), false);
  }
});

test("changes requested blocks every action that moves the PR toward a merge", () => {
  for (const over of [{}, { ...SIZE_L, decision: answered("merge") }, { ...SIZE_L }, { premerge: null }, { verification: null }, { runs: runs() }]) {
    const p = decidePr(prFacts({ ...over, changesRequested: { why: "w", live: false } }));
    assert.equal(p.state, "changes-requested");
    assert.deepEqual(p.actions.filter((a) => ["merge", "ask-merge", "premerge"].includes(a.kind)), []);
  }
});

test("a PR in a batch keeps the batch state", () => {
  for (const batch of ["batch-checking", "in-batch", "batch-failed"] as const) {
    assert.equal(decidePr(prFacts({ batch })).state, batch);
    assert.equal(decidePr(prFacts({ batch, ci: "pending" })).state, batch);
    assert.equal(decidePr(prFacts({ batch, repoFacts: { mainRed: true } })).state, batch);
    assert.equal(merges(prFacts({ batch })), false);
  }
});

test("every plan state is one of the declared states", () => {
  const all = new Set<string>([...QUEUE_STATES, "out-of-scope", "integration", "backlog", "duplicate", "draft", "opus-hold", "opus-close", "review-stale", "label-not-reviewed", "scope", "not-reviewed"]);
  for (const row of rows) assert.ok(all.has(decidePr(prFacts(row.facts)).state), row.name);
  assert.equal(REVIEW_AT.length > 0, true);
});
