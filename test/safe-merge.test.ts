import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSafeMergeArgs, refuseAuthors, refuseRuns, refuseView, type Check, type PrView } from "../src/merge/safe-merge.ts";

const ok: Check = { name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
const view = (o: Partial<PrView> = {}): PrView => ({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: "abc", statusCheckRollup: [ok], ...o });

test("refuseView", () => {
  const cases: [string, PrView, string[], string | null][] = [
    ["green", view(), [], null],
    ["merged", view({ state: "MERGED" }), [], "state is MERGED"],
    ["draft", view({ isDraft: true }), [], "PR is a draft"],
    ["conflicting", view({ mergeable: "CONFLICTING" }), [], "mergeable is CONFLICTING"],
    ["failed", view({ statusCheckRollup: [ok, { name: "lint", status: "COMPLETED", conclusion: "FAILURE" }] }), [], "checks not green:\nlint: FAILURE"],
    ["unfinished", view({ statusCheckRollup: [ok, { name: "slow", status: "IN_PROGRESS", conclusion: "" }] }), [], "checks not green:\nslow: not finished"],
    ["unfinished allowed", view({ statusCheckRollup: [ok, { name: "slow", status: "IN_PROGRESS", conclusion: "" }] }), ["slow"], null],
    ["pending status context", view({ statusCheckRollup: [ok, { context: "ci/x", state: "PENDING" }] }), [], "checks not green:\nci/x: not finished"],
    ["allowed but failed", view({ statusCheckRollup: [ok, { name: "slow", status: "COMPLETED", conclusion: "FAILURE" }] }), ["slow"], "checks not green:\nslow: FAILURE"],
    ["no checks", view({ statusCheckRollup: [] }), [], "no checks have run"],
    ["only skipped and neutral", view({ statusCheckRollup: [{ name: "a", conclusion: "SKIPPED" }, { name: "b", conclusion: "NEUTRAL" }] }), [], "no check succeeded (only skipped or neutral)"],
    ["skipped beside success", view({ statusCheckRollup: [ok, { name: "a", conclusion: "SKIPPED" }] }), [], null],
  ];
  for (const [name, v, allow, want] of cases) assert.equal(refuseView(v, allow), want, name);
});

test("refuseRuns", () => {
  assert.equal(refuseRuns([{ name: "CI", status: "completed", conclusion: "success" }, { name: "Docs", status: "completed", conclusion: "skipped" }]), null);
  assert.equal(refuseRuns([{ name: "CI", status: "completed", conclusion: "startup_failure" }]), "workflow runs not green:\nCI: startup_failure");
  assert.equal(refuseRuns([{ name: "CI", status: "queued", conclusion: null }]), "workflow runs not green:\nCI: queued");
  assert.equal(refuseRuns([{ name: "CI", status: "queued", conclusion: null }], ["CI"]), null);
  assert.equal(refuseRuns([{ name: "CI", status: "completed", conclusion: "failure" }], ["CI"]), "workflow runs not green:\nCI: failure");
});

test("refuseAuthors", () => {
  const own = { author: { login: "me" }, commits: [{ authors: [{ login: "me" }] }] };
  const other = { author: { login: "me" }, commits: [{ authors: [{ login: "me" }, { login: null, email: "x@y.z" }] }] };
  assert.equal(refuseAuthors(own, "--squash"), null);
  assert.match(refuseAuthors(other, "--squash")!, /^commits by x@y\.z: use --merge/);
  assert.equal(refuseAuthors(other, "--merge"), null);
});

test("parseSafeMergeArgs", () => {
  assert.deepEqual(parseSafeMergeArgs(["o/r", "5", "--merge", "--allow-pending", "A", "--allow-pending", "B"]), { repo: "o/r", pr: "5", method: "--merge", allow: ["A", "B"] });
  assert.equal(parseSafeMergeArgs(["o/r", "5", "--rebase"]), null);
  assert.equal(parseSafeMergeArgs(["o/r", "5", "--merge", "--allow-pending"]), null);
});
