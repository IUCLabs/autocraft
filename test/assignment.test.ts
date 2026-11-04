// The one assignment rule: AutoCraft is assigned while it works an item through to merge and takes the assignment back when the
// item waits on a person or a stage gave up. Decision rows for PRs and issues, then the step against a fake GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideItem } from "../src/core/decide-item.ts";
import { decidePr } from "../src/core/decide.ts";
import type { AssignFacts } from "../src/core/plan.ts";
import { runAssign } from "../src/assign/index.ts";
import { world } from "./world-db.ts";
import { itemFacts, prFacts } from "./world.ts";

const nobody: AssignFacts = { login: "bot", assignees: [], ours: false };
const ours: AssignFacts = { login: "bot", assignees: ["bot"], ours: true };
const kinds = (a: { actions: { kind: string }[] }) => a.actions.map((x) => x.kind).filter((k) => k === "assign" || k === "unassign");
const FIXUP = { review: { verdict: "take-fix" }, fixup: { fixes: 2, attempts: 0, recorded: [] as string[] } };
const NEEDS_DECISION = { size: "L", lines: 900 } as const;

test("a PR with a fix-up due is assigned once, not again on the next pass", () => {
  assert.deepEqual(kinds(decidePr(prFacts({ ...FIXUP, assignment: nobody }))), ["assign"]);
  assert.deepEqual(kinds(decidePr(prFacts({ ...FIXUP, assignment: ours }))), []);
  // We assigned it and someone removed us: no second assignment.
  assert.deepEqual(kinds(decidePr(prFacts({ ...FIXUP, assignment: { login: "bot", assignees: [], ours: true } }))), []);
  // A person is assigned: never added next to them.
  assert.deepEqual(kinds(decidePr(prFacts({ ...FIXUP, assignment: { login: "bot", assignees: ["alice"], ours: false } }))), []);
});

test("a PR that needs a decision is unassigned only when we are the sole assignee and made the assignment", () => {
  const plan = (assignment: AssignFacts) => decidePr(prFacts({ ...NEEDS_DECISION, assignment }));
  assert.equal(plan(ours).state, "needs-decision");
  assert.deepEqual(kinds(plan(ours)), ["unassign"]);
  assert.deepEqual(kinds(plan({ login: "bot", assignees: ["bot", "alice"], ours: true })), []);
  assert.deepEqual(kinds(plan({ login: "bot", assignees: ["bot"], ours: false })), []);
  assert.deepEqual(kinds(plan({ login: "bot", assignees: ["alice"], ours: false })), []);
});

test("a PR outside the pipeline's scope is unassigned, a merged one is left alone", () => {
  assert.deepEqual(kinds(decidePr(prFacts({ inScope: false, assignment: ours }))), ["unassign"]);
  assert.deepEqual(kinds(decidePr(prFacts({ ghState: "MERGED", assignment: ours }))), []);
});

test("an issue whose fix attempt gave up is unassigned; one being fixed is not", () => {
  const attempt = (state: string) => ({ attempt: { state, textChanged: false, headDone: false, baseDone: true } });
  assert.deepEqual(kinds(decideItem(itemFacts({ assignment: ours, fix: attempt("failed") }))), ["unassign"]);
  assert.deepEqual(kinds(decideItem(itemFacts({ assignment: ours, fix: attempt("testing") }))), []);
  assert.deepEqual(kinds(decideItem(itemFacts({ assignment: nobody, fix: attempt("testing") }))), ["assign"]);
  assert.deepEqual(kinds(decideItem(itemFacts({ assignment: { login: "bot", assignees: ["bot", "alice"], ours: true }, fix: attempt("failed") }))), []);
});

test("the assign step writes once per assignment and leaves other people's items alone", async () => {
  const w = world().repo().pr(1).review(1).verified(1).premerge(1, "clean").pr(2).review(2).verified(2).premerge(2, "clean");
  w.db.prepare("UPDATE items SET assignees = '[\"alice\"]' WHERE repo = 'app' AND number = 2").run();
  const run = () => runAssign(w.db, { repo: "app", by: "pipeline", runId: "t", querier: w.gh.querier });
  assert.deepEqual((await run()).assigned, ["app#1"]);
  assert.deepEqual((await run()).assigned, []);
  assert.deepEqual(w.gh.writesOf("assign").map((x) => x.number), [1]);
  // A hold by an operator's answer puts it on a person: our assignment goes.
  w.db.prepare("UPDATE items SET assignees = '[\"pipeline-bot\"]' WHERE repo = 'app' AND number = 1").run();
  w.answer(1, "hold");
  assert.deepEqual((await run()).unassigned, ["app#1"]);
  assert.deepEqual((await run()).unassigned, []);
});
