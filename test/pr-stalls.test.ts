// PR stalls: every PR that needs a person is asked (a decision) or shows a typed wait with the reason; nothing waits silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr } from "../src/core/decide.ts";
import { UNKNOWN_GAP_MS, UNKNOWN_REREADS } from "../src/core/rules.ts";
import { NOW, prFacts } from "./world.ts";

const kinds = (f: Parameters<typeof prFacts>[0]) => decidePr(prFacts(f)).actions.filter((a) => a.kind !== "unassign").map((a) => `${a.kind}${a.params?.hold ? ":hold" : ""}${a.params?.withdraw ? ":withdraw" : ""}${typeof a.params?.bucket === "string" ? `:${a.params.bucket}` : ""}`);
const cifix = (o: Record<string, unknown> = {}) => ({ states: [] as string[], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: null, skipReason: null, ...o });
const HOLD = { review: { verdict: "hold" } } as const;

test("a hold review asks the Hold question once, waits on the person, then on the author after Wait", () => {
  assert.deepEqual(kinds(HOLD), ["ask-merge:hold"]);
  const open = decidePr(prFacts({ ...HOLD, decision: { hold: { asked: true, open: true, answer: null, otherOpen: false } } }));
  assert.deepEqual(open.actions.filter((a) => a.kind !== "unassign"), []);
  assert.equal(open.waitKind, "person");
  const waiting = decidePr(prFacts({ ...HOLD, decision: { hold: { asked: true, open: false, answer: "wait", otherOpen: false } } }));
  assert.equal(waiting.waitKind, "contributor");
});

test("a Hold question left open for a head that is no longer held is set aside", () => {
  assert.deepEqual(kinds({ review: { verdict: "take", stale: true }, decision: { hold: { asked: true, open: true, answer: null, otherOpen: false } } }).filter((k) => k.startsWith("ask-merge")), ["ask-merge:hold:withdraw"]);
});

test("CI red only on a check the CI fix skipped asks Merge? with the reason", () => {
  const f = { ci: "failure", cifix: cifix({ states: ["skipped"], skipReason: "the gate checks passed; only an optional check failed" }) } as const;
  const p = decidePr(prFacts({ ...f, size: "S" }));
  assert.equal(p.state, "needs-decision");
  assert.ok(p.actions.some((a) => a.kind === "ask-merge"));
  assert.ok(p.reasons.some((r) => r.includes("the CI fix has nothing to fix") && r.includes("optional check")));
  // A CI fix still working keeps the queue state.
  assert.equal(decidePr(prFacts({ ci: "failure", cifix: cifix() })).state, "ci-failed");
});

test("red CI that holds the review with no take review at the head asks the contributor", () => {
  const f = { review: { verdict: "hold", head: "h0" }, ci: "failure", cifix: cifix(), reviewHold: { kind: "ci", wait: "CI on the latest commit to pass", red: true } } as const;
  assert.deepEqual(kinds(f), ["cifix:ask"]);
  const asked = decidePr(prFacts({ ...f, cifix: cifix({ states: ["asked"] }) }));
  assert.equal(asked.waitKind, "contributor");
  const skipped = decidePr(prFacts({ ...f, cifix: cifix({ states: ["skipped"], skipReason: "nothing to fix" }) }));
  assert.equal(skipped.waitKind, "person");
});

test("a failed or errored verification asks Merge? with the failure, and the answer stands", () => {
  for (const state of ["failed", "error"]) {
    const p = decidePr(prFacts({ verification: { state, kind: "tests", summary: "2 tests fail", note: null } }));
    assert.equal(p.state, "needs-decision");
    assert.ok(p.actions.some((a) => a.kind === "ask-merge"));
    assert.ok(p.reasons.some((r) => r.startsWith("verification") && r.includes("2 tests fail")));
    const merged = decidePr(prFacts({ verification: { state, kind: "tests", summary: "2 tests fail", note: null }, decision: { asked: true, answer: "merge", mergeAnswerAfterReview: true } }));
    assert.equal(merged.path, "operator");
    assert.ok(merged.actions.some((a) => a.kind === "merge"));
  }
});

test("a mergeable state unknown after every re-read asks Merge?; before that the wait says how often it was read", () => {
  const since = new Date(NOW - 10 * 3600_000).toISOString();
  const reading = decidePr(prFacts({ mergeable: "UNKNOWN", unknown: { since, rereads: 1, lastAt: new Date(NOW - 60_000).toISOString() } }));
  assert.equal(reading.state, "waiting-ci");
  assert.match(reading.wait ?? "", /read again 1 of 3/);
  const stuck = decidePr(prFacts({ mergeable: "UNKNOWN", unknown: { since, rereads: UNKNOWN_REREADS, lastAt: new Date(NOW - UNKNOWN_GAP_MS - 1).toISOString() } }));
  assert.equal(stuck.state, "needs-decision");
  assert.ok(stuck.actions.some((a) => a.kind === "ask-merge"));
  assert.ok(stuck.reasons.some((r) => r.includes("unknown")));
});

test("a merge refused for a reason other than CI or mergeable asks Merge?; a state refusal waits for the change", () => {
  const refused = (reason: string) => ({ lastMerge: { outcome: "refused", reason, ci: "success", mergeable: "MERGEABLE" } });
  const other = decidePr(prFacts(refused("REFUSED app#1: the PR touches a protected file")));
  assert.equal(other.state, "needs-decision");
  assert.ok(other.reasons.some((r) => r.includes("protected file")));
  const state = decidePr(prFacts(refused("not ready at merge time: CI pending, mergeable unknown")));
  assert.equal(state.state, "refused");
  // An operator who already answered Merge and was refused is shown a person wait with the reason.
  const answered = decidePr(prFacts({ ...refused("REFUSED app#1: the PR touches a protected file"), decision: { asked: true, answer: "merge", mergeAnswerAfterReview: true } }));
  assert.equal(answered.waitKind, "person");
  assert.match(answered.wait ?? "", /protected file/);
});

test("the Hold question is written once per head, prepared like other questions, and set aside by a new review", async () => {
  const { world } = await import("./world-db.ts");
  const { askHoldDecisions } = await import("../src/act/index.ts");
  const { saveOpus } = await import("../src/review/opus.ts");
  const w = world().repo().pr(1).review(1, { verdict: "hold", reason: "needs a design call" });
  try {
    assert.equal(w.prPlan(1).state, "opus-hold");
    const ids = askHoldDecisions(w.db, new Date().toISOString());
    assert.deepEqual(ids, ["app#1:hold@" + (w.prPlan(1).head ?? "")]);
    const d = w.rows("SELECT kind, question, options, facts FROM decisions WHERE id = ?", ids[0]!)[0]!;
    assert.equal(d.kind, "hold");
    assert.deepEqual((JSON.parse(String(d.options)) as { key: string }[]).map((o) => o.key), ["wait", "close"]);
    assert.ok(String(d.facts).includes("needs a design call"));
    // Asked: the plan waits on a person and does not ask again.
    assert.deepEqual(w.prPlan(1).actions.filter((a) => a.kind === "ask-merge"), []);
    assert.equal(w.prPlan(1).waitKind, "person");
    assert.deepEqual(askHoldDecisions(w.db, new Date().toISOString()), []);
    // A new review at the same head sets the question aside; a hold again asks it anew.
    saveOpus(w.db, "rv2", { repo: "app", number: 1, head_oid: w.prPlan(1).head! }, { mode: "full", base: null, model: "m", review: { ref: "app#1", verdict: "hold", sure: true, reason: "still open", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] } });
    assert.equal(w.rows("SELECT 1 FROM decisions WHERE id LIKE '%:hold@%~replaced-%'").length, 1);
    assert.equal(askHoldDecisions(w.db, new Date().toISOString()).length, 1);
  } finally { w.close(); }
});

test("a hold review whose item has another open question waits for it instead of replacing it", () => {
  const p = decidePr(prFacts({ ...HOLD, decision: { hold: { asked: false, open: false, answer: null, otherOpen: true } } }));
  assert.deepEqual(p.actions.filter((a) => a.kind !== "unassign"), []);
  assert.equal(p.waitKind, "person");
});
