// Duplicate groups: one comparison per group (fake model calls), one decision per
// group, migration of open pair decisions, fallback by rule, re-runs by hash.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { ask, getDecision, optionsOf, factsOf } from "../src/decisions.ts";
import { runDupeCompare, type CompareDeps, type Reply } from "../src/dupes/compare.ts";
import { applyDuplicateAnswers } from "../src/dupes/decide.ts";
import { duplicateHeld, notHeldSql } from "../src/dupes/held.ts";
import { compareWork, dupesWork } from "../src/dupes/index.ts";
import { dueSets, DROP_PAUSE_MS, RULE_RETRY_MS } from "../src/dupes/plan.ts";
import { askGroupDecisions, resetGroupAnswer } from "../src/dupes/decide.ts";
import { selectCandidates } from "../src/decide/select.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "dupe-groups-test-"));
const T0 = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-06-01T00:00:00Z");
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null };
const DIFF = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

type Spec = { n: number; kind?: "pr" | "issue"; state?: string; created?: string; comments?: number; closing?: number[] };
function fresh(specs: Spec[], pairs: [number, number][]): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, created_at, updated_at, closed_at, closing_issues, comments_count, embed_hash, head_oid)
    VALUES ('app', ?, ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of specs) {
    const state = s.state ?? "OPEN", kind = s.kind ?? "issue";
    item.run(s.n, kind, state, `Item ${s.n}`, s.created ?? `2026-01-0${s.n % 9 + 1}T00:00:00Z`, T0, state === "OPEN" ? null : "2026-03-01T00:00:00Z",
      s.closing ? JSON.stringify(s.closing) : null, s.comments ?? 0, `h${s.n}`, kind === "pr" ? `sha${s.n}` : null);
  }
  for (const [a, b] of pairs)
    db.prepare(`INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at)
      VALUES ('app', ?, ?, ?, ?, 0.95, 0.95, 'duplicate', ?, ?, ?)`).run(a, b, `h${a}`, `h${b}`, a, T0, T0);
  return db;
}

type Call = { id: string; model: string; input: any; checkout?: string };
function deps(replies: (c: Call) => string | null): CompareDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetchDiff: async () => ({ ok: true, text: DIFF }),
    baseCheckout: async () => "/checkout/base",
    ask: (async (id: string, model: string, input: unknown, checkout?: string): Promise<Reply> => {
      const c = { id, model, input, checkout };
      calls.push(c);
      const text = replies(c);
      return text === null ? null : { text, usage: USAGE };
    }) as CompareDeps["ask"],
    now: () => NOW,
  };
}
const pr = (keep: number, others: object[], reason = "most complete", extra: object = {}) => JSON.stringify({ keep, reason, ...extra, others });
const WORDS = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const GROUP_ID = "app:dupegroup:1";

describe("PR group", () => {
  const specs: Spec[] = [{ n: 1, kind: "pr" }, { n: 2, kind: "pr", closing: [9] }, { n: 3, kind: "pr" }];
  const SUMMARY = "Keep #2: it fixes the layout guard in full. #1 only covers master pages, which are worth carrying over.";
  const reply = () => pr(2, [
    { number: 1, duplicate: true, better: ["handles master pages (src/a.rs)"], carry: ["master-page handling in src/a.rs"] },
    { number: 3, duplicate: true, better: [], carry: [] },
  ], "most complete", { summary: SUMMARY, why: "#2 fixes the layout guard that #1 and #3 leave out." });

  test("three PRs are compared in one Opus call with a base checkout and give one decision", async () => {
    const db = fresh(specs, [[1, 2], [2, 3]]);
    const d = deps(reply);
    const r = await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 1);
    assert.deepEqual([d.calls[0]!.id, d.calls[0]!.model, d.calls[0]!.checkout], ["dupes.compare-prs.opus", "opus", "/checkout/base"]);
    assert.deepEqual(d.calls[0]!.input.prs.map((p: any) => p.ref), ["#1", "#2", "#3"]);
    assert.deepEqual(d.calls[0]!.input.prs[1].linked_issues, ["#9"]);
    assert.ok(d.calls[0]!.input.prs[0].diff.includes("+new"));
    assert.deepEqual(r.asked, [GROUP_ID]);
    const dec = getDecision(db, GROUP_ID)!;
    assert.deepEqual([dec.kind, dec.number, dec.recommended], ["duplicate", 2, "accept"]);
    assert.equal(dec.question, "Keep #2 and close #1, #3 as its duplicates?");
    assert.deepEqual(optionsOf(dec).map((o) => o.key).filter((k) => k !== "backlog"), ["accept", "keep:1", "keep:3", "distinct"]);
    // The summary is the model's text, whole; the better/carry points stay structured in the stored detail.
    assert.deepEqual([dec.summary, dec.summary_by], [SUMMARY, "opus"]);
    assert.equal(dec.recommended_reason, "#2 fixes the layout guard that #1 and #3 leave out.");
    assert.ok(!factsOf(dec).some((f) => f.startsWith("Carry over")));
    assert.deepEqual(optionsOf(dec).slice(0, 4).map((o) => o.label), ["Keep #2", "Keep #1 instead", "Keep #3 instead", "Not duplicates"]);
    assert.match(db.prepare("SELECT detail FROM dupe_group_items WHERE decision_id = ? AND number = 1").get(GROUP_ID)!.detail as string, /master-page handling/);
    const roles = db.prepare("SELECT number, role, target FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(GROUP_ID);
    assert.deepEqual(roles.map((x: any) => [x.number, x.role, x.target]), [[1, "close", 2], [2, "keep", null], [3, "close", 2]]);
    // The items to close wait out the later stages; the kept one does not.
    assert.equal(duplicateHeld(db, "app", 1), true);
    assert.equal(duplicateHeld(db, "app", 2), false);
    assert.deepEqual((db.prepare(`SELECT i.number FROM items i WHERE ${notHeldSql("i")} ORDER BY i.number`).all() as { number: number }[]).map((x) => x.number), [2]);
  });

  test("a member whose head changes is compared again; unchanged groups are not", async () => {
    const db = fresh(specs, [[1, 2], [2, 3]]);
    const d = deps(reply);
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(compareWork(db), false);
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 1);
    db.prepare("UPDATE items SET head_oid = 'sha3b' WHERE number = 3").run();
    assert.equal(compareWork(db), true);
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'duplicate'").get()!.n, 1);
  });

  test("a model failure falls back to the rule and the decision says so", async () => {
    const db = fresh(specs, [[1, 2], [2, 3]]);
    const d = deps(() => "not json");
    const r = await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 2, "two attempts");
    assert.equal(r.byRule, 1);
    const dec = getDecision(db, GROUP_ID)!;
    assert.equal(dec.recommended, null);
    assert.ok(dec.context!.includes("rule"));
    assert.ok(factsOf(dec).some((f) => f.startsWith("Chosen by: rule")));
    assert.equal(dec.recommended_reason, null);
    assert.ok(!dec.summary_by);
    assert.match(dec.summary!, /by rule/);
  });

  test("a summary over the cap is asked again once, then stored as its first sentence; a reply without one keeps the reason whole", async () => {
    const long = `First sentence stays. ${WORDS(100)}.`;
    const db = fresh(specs, [[1, 2], [2, 3]]);
    const d = deps(() => pr(2, [{ number: 1, duplicate: true, better: [], carry: [] }, { number: 3, duplicate: true, better: [], carry: [] }], "most complete", { summary: long }));
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 2, "asked again once");
    assert.equal(getDecision(db, GROUP_ID)!.summary, "First sentence stays.");

    const old = fresh(specs, [[1, 2], [2, 3]]);
    await runDupeCompare(old, {}, () => {}, deps(() => pr(2, [{ number: 1, duplicate: true, better: ["x"], carry: ["y"] }, { number: 3, duplicate: true, better: [], carry: [] }], `${WORDS(40)} end.`)));
    const dec = getDecision(old, GROUP_ID)!;
    assert.equal(dec.summary, `${WORDS(40)} end.`);
    assert.ok(!dec.summary_by);
    assert.equal(dec.recommended, null, "a reason that is not one short sentence gives no recommendation");
    assert.ok(!dec.summary!.includes("does better"));
  });

  test("a PR the model says is not a duplicate stays open", async () => {
    const db = fresh(specs, [[1, 2], [2, 3]]);
    await runDupeCompare(db, {}, () => {}, deps(() => pr(2, [{ number: 1, duplicate: false, better: ["other file"], carry: [] }, { number: 3, duplicate: true, better: [], carry: [] }])));
    assert.deepEqual(db.prepare("SELECT number, role FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(GROUP_ID).map((x: any) => x.role), ["stay", "keep", "close"]);
    assert.equal(getDecision(db, GROUP_ID)!.question, "Keep #2 and close #3 as its duplicate?");
  });
});

describe("issue group", () => {
  test("all reports go to Sonnet in one call without tools; the decision lists what the others add", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }], [[1, 2], [1, 3]]);
    const d = deps(() => JSON.stringify({ keep: 1, reason: "clear steps", summary: "Keep #1: it has the clearest steps. #2 adds the Linux version.", others: [{ number: 2, adds: ["Linux version 0.9.2"] }, { number: 3, adds: [] }] }));
    await runDupeCompare(db, {}, () => {}, d);
    assert.deepEqual([d.calls.length, d.calls[0]!.id, d.calls[0]!.model, d.calls[0]!.checkout], [1, "dupes.compare-issues.sonnet", "sonnet", undefined]);
    assert.equal(d.calls[0]!.input.issues.length, 3);
    const dec = getDecision(db, GROUP_ID)!;
    assert.equal(dec.summary, "Keep #1: it has the clearest steps. #2 adds the Linux version.");
    assert.equal(dec.summary_by, "sonnet");
    assert.match(db.prepare("SELECT detail FROM dupe_group_items WHERE decision_id = ? AND number = 2").get(GROUP_ID)!.detail as string, /Linux version 0\.9\.2/);
  });

  test("more than ten members are compared in rounds whose winners meet", async () => {
    const specs: Spec[] = Array.from({ length: 12 }, (_, i) => ({ n: i + 1 }));
    const db = fresh(specs, specs.slice(1).map((s) => [1, s.n]));
    const d = deps((c) => {
      const nums = c.input.issues.map((i: any) => Number(i.ref.slice(1)));
      return JSON.stringify({ keep: nums[0], reason: "r", others: nums.slice(1).map((number: number) => ({ number, adds: [] })) });
    });
    await runDupeCompare(db, {}, () => {}, d);
    assert.deepEqual(d.calls.map((c) => c.input.issues.length), [6, 6, 2]);
    const roles = db.prepare("SELECT COUNT(*) AS n FROM dupe_group_items WHERE decision_id = ? AND role = 'close'").get(GROUP_ID) as { n: number };
    assert.equal(roles.n, 11);
  });
});

describe("closed members and mixed groups", () => {
  test("a merged PR wins without a model call; the open ones are closed as its duplicates", async () => {
    const db = fresh([{ n: 1, kind: "pr" }, { n: 2, kind: "pr", state: "MERGED" }, { n: 3, kind: "pr" }], [[1, 2], [2, 3]]);
    const d = deps(() => { throw new Error("must not be called"); });
    const r = await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 0);
    assert.equal(r.closedWins, 1);
    const dec = getDecision(db, GROUP_ID)!;
    assert.deepEqual([dec.number, dec.question], [2, "Keep #2 and close #1, #3 as its duplicates?"]);
    assert.ok(factsOf(dec).some((f) => f.includes("already merged")));
  });

  test("PRs are never closed as duplicates of issues: each kind keeps its own, the kept PR is linked to the kept issue", async () => {
    const db = fresh([{ n: 1, kind: "pr" }, { n: 2, kind: "pr" }, { n: 3 }, { n: 4 }], [[1, 2], [2, 3], [3, 4]]);
    const d = deps((c) => c.id === "dupes.compare-prs.opus"
      ? pr(1, [{ number: 2, duplicate: true, better: [], carry: [] }])
      : JSON.stringify({ keep: 3, reason: "r", others: [{ number: 4, adds: [] }] }));
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 2);
    const rows = db.prepare("SELECT number, kind, role, target, detail FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(GROUP_ID) as any[];
    assert.deepEqual(rows.map((r) => [r.number, r.role, r.target]), [[1, "keep", null], [2, "close", 1], [3, "keep", null], [4, "close", 3]]);
    assert.deepEqual(JSON.parse(rows[0].detail), { link: 3 });
    assert.equal(getDecision(db, GROUP_ID)!.number, 1);
  });
});

describe("pair decisions and answers", () => {
  const specs: Spec[] = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const pairQ = (x: number, y: number) => ({
    id: `app#${x}:duplicate@${y}`, kind: "duplicate", repo: "app", number: x, question: `Close #${x} as a duplicate of #${y}?`,
    facts: [`duplicate of app#${y}`], options: [{ key: "close", label: "Close" }, { key: "distinct", label: "Not" }], asked_at: T0,
  });

  test("open pair decisions of the group are superseded and audited; an answered close keeps its effect", async () => {
    const db = fresh(specs, [[1, 2], [1, 3]]);
    ask(db, [pairQ(2, 1), pairQ(3, 1)]);
    db.prepare("UPDATE decisions SET answer = 'close', answered_by = 'op', answered_at = ? WHERE id = 'app#3:duplicate@1'").run(T0);
    await runDupeCompare(db, {}, () => {}, deps(() => JSON.stringify({ keep: 1, reason: "r", others: [{ number: 2, adds: [] }, { number: 3, adds: [] }] })));
    const p2 = getDecision(db, "app#2:duplicate@1")!;
    assert.deepEqual([p2.answer, p2.answered_by, p2.applied_at !== null], ["superseded", "dupes", true]);
    const p3 = getDecision(db, "app#3:duplicate@1")!;
    assert.deepEqual([p3.answer, p3.applied_at], ["close", null]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'duplicate-superseded'").get() as { n: number }).n, 1);
    // The group decision covers only #2: #3 is closed by its answered pair decision.
    assert.deepEqual(db.prepare("SELECT number FROM dupe_group_items WHERE decision_id = ? AND role = 'close'").all(GROUP_ID).map((x: any) => x.number), [2]);
    assert.equal(getDecision(db, GROUP_ID)!.question, "Keep #1 and close #2 as its duplicate?");
  });

  test("keep #N instead rewrites the roles; not duplicates stores every pair as distinct and releases the items", async () => {
    const db = fresh(specs, [[1, 2], [1, 3]]);
    await runDupeCompare(db, {}, () => {}, deps(() => JSON.stringify({ keep: 1, reason: "r", others: [{ number: 2, adds: [] }, { number: 3, adds: [] }] })));
    const answer = (a: string) => db.prepare("UPDATE decisions SET answer = ?, answered_by = 'op', answered_at = ? WHERE id = ?").run(a, T0, GROUP_ID);
    assert.equal(dupesWork(db, "m"), false);
    answer("keep:3");
    assert.equal(dupesWork(db, "m"), true);
    assert.equal(applyDuplicateAnswers(db, T0), 1);
    assert.equal(dupesWork(db, "m"), false);
    assert.deepEqual(db.prepare("SELECT number, role, target FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(GROUP_ID).map((x: any) => [x.role, x.target]), [["close", 3], ["close", 3], ["keep", null]]);
    assert.equal(duplicateHeld(db, "app", 1), true);
    assert.equal(duplicateHeld(db, "app", 3), false);

    db.prepare("UPDATE decisions SET answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?").run(GROUP_ID);
    answer("distinct");
    assert.equal(applyDuplicateAnswers(db, T0), 1);
    assert.equal(duplicateHeld(db, "app", 1), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM duplicate_pairs WHERE verdict = 'distinct' AND by_operator = 1").get() as { n: number }).n, 3);
    assert.equal(dueSets(db).length, 0);
  });
});

const issueReply = (keep: number, others: number[]) => JSON.stringify({ keep, reason: "r", others: others.map((number) => ({ number, adds: [] })) });
const roles = (db: DatabaseSync, id = GROUP_ID) => (db.prepare("SELECT number, role FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(id) as { number: number; role: string }[]).map((r) => `${r.number}:${r.role}`);
const answerAs = (db: DatabaseSync, a: string, id = GROUP_ID) => db.prepare("UPDATE decisions SET answer = ?, answered_by = 'op', answered_at = ? WHERE id = ?").run(a, T0, id);
const undo = (db: DatabaseSync, id = GROUP_ID) => { db.prepare("UPDATE decisions SET answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?").run(id); resetGroupAnswer(db, id); };

describe("review fixes: answers, undo and refresh", () => {
  async function three() {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }], [[1, 2], [1, 3]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(1, [2, 3])));
    return db;
  }
  test("undo then answer again rebuilds the roles from the comparison", async () => {
    const db = await three();
    answerAs(db, "keep:2");
    applyDuplicateAnswers(db, T0);
    assert.deepEqual(roles(db), ["1:close", "2:keep", "3:close"]);
    undo(db);
    assert.deepEqual(roles(db), ["1:keep", "2:close", "3:close"]);
    answerAs(db, "keep:2");
    applyDuplicateAnswers(db, T0);
    assert.deepEqual(roles(db), ["1:close", "2:keep", "3:close"]);
    // keep:3, undo, then use the answer: the comparison's keep returns.
    undo(db);
    answerAs(db, "keep:3");
    applyDuplicateAnswers(db, T0);
    undo(db);
    answerAs(db, "accept");
    applyDuplicateAnswers(db, T0);
    assert.deepEqual(roles(db), ["1:keep", "2:close", "3:close"]);
  });

  test("asking again with nothing changed keeps the open decision as it was", async () => {
    const db = await three();
    const before = getDecision(db, GROUP_ID)!.asked_at;
    assert.deepEqual(askGroupDecisions(db, undefined, "2030-01-01T00:00:00.000Z"), []);
    assert.equal(getDecision(db, GROUP_ID)!.asked_at, before);
  });

  test("a new comparison text replaces the stale summary and recommendation of the open decision, and a second run changes nothing", async () => {
    const db = await three();
    db.prepare("UPDATE decisions SET summary = 'Sonnet said keep #1.', summary_by = 'sonnet', recommended = NULL, recommended_reason = NULL WHERE id = ?").run(GROUP_ID);
    askGroupDecisions(db, undefined, "2030-01-01T00:00:00.000Z");
    const d = getDecision(db, GROUP_ID)!;
    assert.deepEqual([d.summary_by, d.recommended, d.summary?.startsWith("Sonnet")], [null, "accept", false]);
    db.prepare("UPDATE dupe_comparisons SET summary = 'New view: keep #2.', why = 'It is the complete fix.'").run();
    askGroupDecisions(db, undefined, "2030-01-02T00:00:00.000Z");
    assert.deepEqual([getDecision(db, GROUP_ID)!.summary, getDecision(db, GROUP_ID)!.recommended_reason], ["New view: keep #2.", "It is the complete fix."]);
    const again = getDecision(db, GROUP_ID)!;
    askGroupDecisions(db, undefined, "2030-01-03T00:00:00.000Z");
    assert.deepEqual(getDecision(db, GROUP_ID), again);
  });

  test("a refresh drops the applied answer and restores the comparison's roles", async () => {
    const db = await three();
    db.prepare("UPDATE dupe_group_items SET role = 'keep' WHERE decision_id = ? AND number = 2").run(GROUP_ID);
    db.prepare("UPDATE dupe_groups SET applied_answer = 'keep:2'").run();
    askGroupDecisions(db, undefined, T0);
    assert.deepEqual(roles(db), ["1:keep", "2:close", "3:close"]);
    assert.equal((db.prepare("SELECT applied_answer FROM dupe_groups").get() as any).applied_answer, null);
  });

  test("keep #N instead leaves the old keep as stay when it is not open", async () => {
    const db = await three();
    db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 1").run();
    // The closed #1 keeps winning by the closed rule only after a new comparison; here the roles are set directly.
    answerAs(db, "keep:2");
    applyDuplicateAnswers(db, T0);
    assert.equal(roles(db).includes("1:stay") || roles(db).includes("1:close"), true);
    assert.equal(roles(db).includes("1:close"), false);
  });
});

describe("review fixes: members already gone", () => {
  test("a member closed as a duplicate, or with an answered close pair decision, is not part of the group", async () => {
    const db = fresh([{ n: 10 }, { n: 11 }, { n: 12, state: "CLOSED" }], [[10, 12], [10, 11]]);
    db.prepare("UPDATE items SET state_reason = 'DUPLICATE' WHERE number = 12").run();
    const d = deps(() => issueReply(10, [11]));
    await runDupeCompare(db, {}, () => {}, d);
    assert.deepEqual(d.calls[0]!.input.issues.map((i: any) => i.ref), ["#10", "#11"]);
    assert.equal(getDecision(db, "app:dupegroup:10")!.question, "Keep #10 and close #11 as its duplicate?");
  });

  test("a pair close answered but not acted yet keeps that member out of the keep", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }], [[1, 2]]);
    ask(db, [{ id: "app#2:duplicate@1", kind: "duplicate", repo: "app", number: 2, question: "q", options: [{ key: "close", label: "c" }, { key: "distinct", label: "n" }], asked_at: T0 }]);
    answerAs(db, "close", "app#2:duplicate@1");
    const d = deps(() => issueReply(2, [1]));
    await runDupeCompare(db, {}, () => {}, d);
    assert.equal(d.calls.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id LIKE '%dupegroup%'").get()!.n, 0);
  });

  test("a closed, unmerged PR is left out; a merged one still wins", async () => {
    const db = fresh([{ n: 1, kind: "pr" }, { n: 2, kind: "pr" }, { n: 3, kind: "pr", state: "CLOSED" }], [[1, 2], [2, 3]]);
    const d = deps(() => pr(1, [{ number: 2, duplicate: true, better: [], carry: [] }]));
    await runDupeCompare(db, {}, () => {}, d);
    assert.deepEqual(d.calls[0]!.input.prs.map((p: any) => p.ref), ["#1", "#2"]);
  });
});

describe("review fixes: queue, retries, atomic writes", () => {
  test("a set dropped by the live check does not use the limit and is not retried for a while", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], [[1, 2], [3, 4]]);
    const d = deps(() => issueReply(3, [4]));
    d.querier = { spent: 0, remaining: 1, async query() {
      const repository: any = {};
      for (const n of [1, 2, 3, 4]) repository[`i${n}`] = { state: n === 1 ? "CLOSED" : "OPEN" };
      return { repository };
    } } as never;
    const r = await runDupeCompare(db, { limit: 1 }, () => {}, d);
    assert.deepEqual([r.dropped, d.calls.length], [1, 1]);
    assert.equal(dueSets(db, undefined, NOW.getTime() + 1000).length, 0);
    db.prepare("DELETE FROM dupe_comparisons").run();
    assert.equal(dueSets(db, undefined, NOW.getTime() + 1000).length, 1, "the set that was not dropped is due again, the dropped one waits");
    assert.equal(dueSets(db, undefined, NOW.getTime() + DROP_PAUSE_MS + 1000).length, 2);
  });

  test("a rule result is compared again after a day, three times at most", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }], [[1, 2]]);
    const run = (ms: number) => runDupeCompare(db, {}, () => {}, { ...deps(() => "no"), now: () => new Date(NOW.getTime() + ms) });
    await run(0);
    assert.equal(dueSets(db, undefined, NOW.getTime() + 1000).length, 0);
    assert.equal(dueSets(db, undefined, NOW.getTime() + RULE_RETRY_MS + 1000).length, 1);
    await run(RULE_RETRY_MS + 1000);
    await run(2 * RULE_RETRY_MS + 2000);
    assert.equal((db.prepare("SELECT attempts FROM dupe_comparisons").get() as any).attempts, 3);
    assert.equal(dueSets(db, undefined, NOW.getTime() + 9 * RULE_RETRY_MS).length, 0);
    // A model answer on a retry replaces the rule result.
    db.prepare("UPDATE dupe_comparisons SET attempts = 1").run();
    await runDupeCompare(db, {}, () => {}, { ...deps(() => issueReply(2, [1])), now: () => new Date(NOW.getTime() + 4 * RULE_RETRY_MS) });
    assert.equal((db.prepare("SELECT source FROM dupe_comparisons").get() as any).source, "model");
    assert.equal(getDecision(db, GROUP_ID)!.number, 2);
  });

  test("a failed refresh leaves nothing half written", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }], [[1, 2]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(1, [2])));
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON dupe_group_items BEGIN SELECT RAISE(ABORT, 'boom'); END");
    db.prepare("UPDATE decisions SET question = 'old'").run();
    assert.throws(() => askGroupDecisions(db, undefined, T0), /boom/);
    assert.equal(getDecision(db, GROUP_ID)!.question, "old");
    assert.equal(roles(db).length, 2);
  });

  test("the kept item of an open group decision is not held back from Decide", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }], [[1, 2]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(1, [2])));
    db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 1, 'jev', 'r1', ?, 'missing feature', '[\"needs decision\"]', '{\"top\":0.95}')").run(T0);
    assert.deepEqual(selectCandidates(db, "r1", ["app"]).map((c) => c.number), [1]);
  });
});

describe("review fixes: groups that grow", () => {
  test("a member joining after an answer is asked against the answered keep, and the answered members are not asked again", async () => {
    const db = fresh([{ n: 3 }, { n: 7 }, { n: 9 }], [[3, 7]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(3, [7])));
    answerAs(db, "accept", "app:dupegroup:3");
    applyDuplicateAnswers(db, T0);
    db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at) VALUES ('app', 3, 9, 'h3', 'h9', 0.9, 0.95, 'duplicate', 3, ?, ?)").run(T0, T0);
    // The model would now keep the new #9; the answered keep stays.
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(9, [3, 7])));
    const ids = (db.prepare("SELECT id FROM decisions WHERE id LIKE '%dupegroup%' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids, ["app:dupegroup:3", "app:dupegroup:9"]);
    assert.deepEqual(roles(db, "app:dupegroup:9"), ["3:keep", "9:close"]);
    assert.equal(getDecision(db, "app:dupegroup:9")!.question, "Keep #3 and close #9 as its duplicate?");
  });

  test("a lower member joining an open group refreshes the same decision", async () => {
    const db = fresh([{ n: 1 }, { n: 5 }, { n: 6 }], [[5, 6]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(5, [6])));
    assert.ok(getDecision(db, "app:dupegroup:5"));
    db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at) VALUES ('app', 1, 5, 'h1', 'h5', 0.9, 0.95, 'duplicate', 1, ?, ?)").run(T0, T0);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(5, [1, 6])));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id LIKE '%dupegroup%'").get()!.n, 1);
    assert.equal(getDecision(db, "app:dupegroup:5")!.question, "Keep #5 and close #1, #6 as its duplicates?");
  });

  test("open pair decisions are superseded even when the group has nothing to close", async () => {
    const db = fresh([{ n: 1, kind: "pr" }, { n: 2, kind: "pr" }], [[1, 2]]);
    ask(db, [{ id: "app#2:duplicate@1", kind: "duplicate", repo: "app", number: 2, question: "q", options: [{ key: "close", label: "c" }, { key: "distinct", label: "n" }], asked_at: T0 }]);
    await runDupeCompare(db, {}, () => {}, deps(() => pr(1, [{ number: 2, duplicate: false, better: ["x"], carry: [] }])));
    assert.equal(getDecision(db, "app#2:duplicate@1")!.answer, "superseded");
  });

  test("a group answer is applied when any member is in the pilot", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }], [[1, 2]]);
    await runDupeCompare(db, {}, () => {}, deps(() => issueReply(1, [2])));
    answerAs(db, "accept");
    db.prepare("INSERT INTO settings (key, value) VALUES ('pilot_items', '[\"app#2\"]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    assert.equal(dupesWork(db, "m"), true);
  });
});
