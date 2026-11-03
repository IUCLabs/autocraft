// Gaps where items stopped for a person: Merge? asked without a merge approval, answers that write nothing marked
// applied, the plugin label, "not verified" and "no CI" merge decisions, visibility of holds, and operator releases.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { applyUsedAnswers } from "../src/decisions-used.ts";
import { factsOf as decisionFacts, getDecision } from "../src/decisions.ts";
import { planLabels } from "../src/labels/plan.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { buildQueue, eligible } from "../src/merge/queue.ts";
import { ActionError, actionsOf, fixAgain, reviewAgain, verifyAgain } from "../src/operator-actions.ts";
import { classifyListOf, factsOf, nextStepOf } from "../src/rank/next.ts";
import { settledOf } from "../src/classify/settled.ts";
import { saveVerification } from "../src/verify/index.ts";
import { unavailableCandidates } from "../src/verify/candidates.ts";
import { LANES } from "../src/runner/autopilot.ts";
import { finalizeReviews } from "./fixture.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "gaps-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO tracked_repos (name) VALUES ('app')").run();
  return db;
}

type Opts = { n: number; kind?: "pr" | "issue"; label?: string; lines?: number; ci?: string; verify?: string; verdict?: string; labels?: string[] };

/** A PR (or issue) with a settled label; PRs also get a review, checks and optionally a verification, all at head sha<n>. */
function add(db: DatabaseSync, o: Opts): void {
  const kind = o.kind ?? "pr";
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, labels, created_at, updated_at)
    VALUES ('app', ?, ?, 'OPEN', ?, 'regular', ?, 0, ?, ?, '${T0}', '${T0}')`).run(o.n, kind, `Item ${o.n}`, o.lines ?? 20, kind === "pr" ? `sha${o.n}` : null, JSON.stringify(o.labels ?? []));
  db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', ?, '[]', '{"top":0.95}')`).run(o.n, o.label ?? "bugfix");
  if (kind !== "pr") return;
  db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'S', ?, 'looks right')`).run(o.n, `sha${o.n}`, o.verdict ?? "take");
  finalizeReviews(db);
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', ?, ?, 'OPEN', 0, ?, '[]', 'MERGEABLE', 1, '${T1}')`).run(o.n, `sha${o.n}`, o.ci ?? "success");
  if (o.verify) {
    db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, summary, created_at) VALUES ('app', ?, ?, ?, 'r', ?, ?, '${T0}')`)
      .run(o.n, `sha${o.n}`, o.verify === "unavailable" ? "unavailable" : "tests", o.verify, o.verify === "unavailable" ? "the repo is private" : null);
  }
}

const answer = (db: DatabaseSync, id: string, key: string, by = "op") =>
  db.prepare("UPDATE decisions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(key, by, T1, id);
const decision = (db: DatabaseSync, id: string, kind: string, n: number, extra = "") =>
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES (?, ?, 'app', ?, 'q', '[{"key":"a","label":"A"},{"key":"b","label":"B"}]', '${T0}')${extra}`).run(id, kind, n);
const appliedAt = (db: DatabaseSync, id: string) => (db.prepare("SELECT applied_at FROM decisions WHERE id = ?").get(id) as { applied_at: string | null }).applied_at;

describe("Merge? asked without a merge approval", () => {
  test("a take PR outside the rule is asked in a repo with no merge approval, once", () => {
    const db = fresh();
    add(db, { n: 1, label: "missing feature", verify: "passed" });
    add(db, { n: 2, verify: "passed" }); // inside the rule: not asked
    const ids = askMergeDecisions(db, { repos: ["app"], run: "r1" });
    assert.deepEqual(ids, ["app#1:merge@sha1"]);
    assert.deepEqual(askMergeDecisions(db, { run: "r1" }), []);
    const lane = LANES.find((l) => l.name === "merge-ask")!;
    assert.deepEqual(lane.detect(db, { run: "r1", jevRun: "r1", tracked: ["app"] }), []);
  });

  test("the autopilot lane queues merge-ask when a question is due", () => {
    const db = fresh();
    add(db, { n: 1, label: "missing feature", verify: "passed" });
    const lane = LANES.find((l) => l.name === "merge-ask")!;
    assert.deepEqual(lane.detect(db, { run: "r1", jevRun: "r1", tracked: ["app"] }), [{ step: "merge-ask", params: {} }]);
    assert.deepEqual(lane.detect(db, { run: "r1", jevRun: "r1", tracked: ["other"] }), []);
  });

  test("not verified: the question says why, the rule never merges it, an operator's merge answer can", () => {
    const db = fresh();
    add(db, { n: 1, verify: "unavailable" });
    let [e] = buildQueue(db, { run: "r1" });
    assert.equal(e!.state, "needs-decision");
    assert.equal(e!.path, null);
    assert.ok(e!.outsideRule.some((r) => r.startsWith("not verified: the repo is private")));
    askMergeDecisions(db, { run: "r1" });
    const d = getDecision(db, "app#1:merge@sha1")!;
    assert.ok(decisionFacts(d).includes("not verified: the repo is private"));
    answer(db, d.id, "merge");
    [e] = buildQueue(db, { run: "r1" });
    assert.equal(e!.state, "decision-answered-merge");
    assert.ok(eligible(e!));
  });

  test("no CI: the question says so, the rule never merges it, an operator's merge answer can", () => {
    const db = fresh();
    add(db, { n: 1, verify: "passed", ci: "none" });
    let [e] = buildQueue(db, { run: "r1" });
    assert.equal(e!.state, "needs-decision");
    assert.ok(e!.outsideRule.includes("the repo has no CI checks"));
    askMergeDecisions(db, { run: "r1" });
    assert.ok(decisionFacts(getDecision(db, "app#1:merge@sha1")!).some((f) => f.includes("no CI checks")));
    answer(db, "app#1:merge@sha1", "merge");
    [e] = buildQueue(db, { run: "r1" });
    assert.ok(eligible(e!));
  });

  test("a PR without checks in a repo that has CI keeps waiting for CI", () => {
    const db = fresh();
    add(db, { n: 1, verify: "passed", ci: "none" });
    add(db, { n: 2, verify: "passed" }); // another PR of the repo reported checks
    const e = buildQueue(db, { run: "r1" }).find((x) => x.number === 1)!;
    assert.equal(e.noCi, false);
    assert.equal(e.state, "waiting-ci");
    assert.ok(!e.outsideRule.some((r) => r.includes("no CI")));
  });

  test("a PR held by an open Duplicate? decision is held-duplicate and not eligible", () => {
    const db = fresh();
    add(db, { n: 1, verify: "passed" });
    decision(db, "app#1:dup", "duplicate", 1);
    const [e] = buildQueue(db, { run: "r1" });
    assert.equal(e!.state, "held-duplicate");
    assert.ok(!eligible(e!));
  });
});

describe("Verify unavailable", () => {
  test("private repo PRs are listed with a reason and recorded as unavailable", () => {
    const db = fresh();
    db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'private')").run();
    add(db, { n: 1 });
    const u = unavailableCandidates(db, "app", "r1");
    assert.equal(u.length, 1);
    assert.equal(u[0]!.reason, "the repo is private");
    saveVerification(db, u[0]!.c, { kind: "unavailable", reason: u[0]!.reason, plan: null, model: null, headTask: null, baseTask: null, baseSha: null, state: "unavailable", summary: u[0]!.reason });
    assert.deepEqual(unavailableCandidates(db, "app", "r1"), []);
    const [e] = buildQueue(db, { run: "r1" });
    assert.equal(e!.state, "needs-decision");
    assert.equal(db.prepare("SELECT stage FROM stages WHERE repo = 'app' AND number = 1").get()!.stage, "verify-unavailable");
  });
});

describe("answers that write nothing are marked applied", () => {
  test("scope take on a PR is applied once the PR was reviewed after the answer", () => {
    const db = fresh();
    add(db, { n: 1, label: "missing feature", verify: "passed" });
    decision(db, "app#1:scope", "scope", 1);
    answer(db, "app#1:scope", "take");
    assert.equal(applyUsedAnswers(db, T1), 0);
    db.prepare("UPDATE reviews SET at = ? WHERE number = 1").run("2026-01-03T00:00:00Z");
    assert.equal(applyUsedAnswers(db, T1), 1);
    assert.equal(appliedAt(db, "app#1:scope"), T1);
  });

  test("scope need-info, Close? hold and keep are applied at the next pass; close and a non-operator answer are not", () => {
    const db = fresh();
    for (const n of [1, 2, 3, 4, 5]) add(db, { n, label: "missing feature" });
    decision(db, "s1", "scope", 1);
    decision(db, "c2", "close", 2);
    decision(db, "c3", "close", 3);
    decision(db, "s4", "scope", 4);
    decision(db, "s5", "scope", 5);
    answer(db, "s1", "need-info");
    answer(db, "c2", "hold");
    answer(db, "c3", "keep");
    answer(db, "s4", "close");
    answer(db, "s5", "need-info", "stranger");
    assert.equal(applyUsedAnswers(db, T1), 3);
    assert.equal(appliedAt(db, "s4"), null);
    assert.equal(appliedAt(db, "s5"), null);
  });

  test("scope plugin is applied once the item carries the plugin candidate label", () => {
    const db = fresh();
    add(db, { n: 1, kind: "issue", label: "missing feature" });
    decision(db, "app#1:scope", "scope", 1);
    answer(db, "app#1:scope", "plugin");
    assert.equal(applyUsedAnswers(db, T1), 0);
    db.prepare("UPDATE items SET labels = '[\"Plugin candidate\"]' WHERE number = 1").run();
    assert.equal(applyUsedAnswers(db, T1), 1);
  });

  test("scope take on an issue that is not a bugfix has no reader left and is applied", () => {
    const db = fresh();
    add(db, { n: 1, kind: "issue", label: "missing feature" });
    add(db, { n: 2, kind: "issue", label: "bugfix" });
    decision(db, "i1", "scope", 1);
    decision(db, "i2", "scope", 2);
    answer(db, "i1", "take");
    answer(db, "i2", "take");
    assert.equal(applyUsedAnswers(db, T1), 1);
    assert.equal(appliedAt(db, "i2"), null);
  });
});

describe("plugin answer labels", () => {
  test("the Label plan adds the plugin candidate label from an operator's answer, also for unsettled items", () => {
    const db = fresh();
    add(db, { n: 1, kind: "issue", label: "missing feature" });
    add(db, { n: 2, kind: "issue", label: "missing feature" });
    db.prepare("UPDATE classifications SET probs = '{\"top\":0.5}' WHERE number = 2").run(); // unsettled: Haiku missing
    decision(db, "p1", "scope", 1);
    decision(db, "p2", "scope", 2);
    answer(db, "p1", "plugin");
    answer(db, "p2", "plugin", "stranger");
    const rows = planLabels(db, "app", "r1");
    assert.deepEqual(rows.find((r) => r.number === 1)!.add, ["plugin candidate"]);
    assert.equal(rows.find((r) => r.number === 2)!.status, "unsettled");
  });
});

describe("what the Work queue says", () => {
  const facts = (db: DatabaseSync, n: number) => {
    const kind = (db.prepare("SELECT kind, head_oid FROM items WHERE number = ?").get(n) as { kind: string; head_oid: string | null });
    return factsOf(db, "app", n, kind.kind, kind.head_oid, settledOf(db, "app", n, "r1"));
  };

  test("held by a Duplicate? decision, not verified, no CI", () => {
    const db = fresh();
    add(db, { n: 1, verify: "passed" });
    add(db, { n: 2, verify: "unavailable" });
    decision(db, "app#1:dup", "duplicate", 1);
    assert.match(nextStepOf(facts(db, 1)), /Duplicate\?/);
    assert.match(nextStepOf(facts(db, 2)), /not verified/);
    const noCi = fresh();
    add(noCi, { n: 3, verify: "passed", ci: "none" });
    assert.match(nextStepOf(facts(noCi, 3)), /no CI/);
  });

  test("a label disagreement outside the scope labels names the problem and links the list", () => {
    const db = fresh();
    add(db, { n: 1, kind: "issue", label: "bugfix" });
    db.prepare("UPDATE classifications SET probs = '{\"top\":0.5}' WHERE number = 1").run();
    db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('app', 1, 'haiku', 'r1', '${T0}', 'infra', '[]')`).run();
    const f = facts(db, 1);
    assert.equal(f.disagree, true);
    assert.equal(nextStepOf(f), "Models disagree: needs a label");
    assert.equal(classifyListOf("app"), "/items?status=disagree&repo=app");
  });
});

describe("operator releases", () => {
  test("review again deletes the hold at the current head, audited", () => {
    const db = fresh();
    add(db, { n: 1, verdict: "hold" });
    assert.equal(actionsOf(db, "app", 1).reviewAgain, true);
    reviewAgain(db, "op", "app", 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()!.n, 0);
    assert.equal(db.prepare("SELECT action FROM audit WHERE login = 'op'").get()!.action, "review-again");
    assert.throws(() => reviewAgain(db, "op", "app", 1), (e) => e instanceof ActionError && e.status === 409);
  });

  test("a take review is not a hold", () => {
    const db = fresh();
    add(db, { n: 1 });
    assert.throws(() => reviewAgain(db, "op", "app", 1), ActionError);
    assert.equal(actionsOf(db, "app", 1).reviewAgain, false);
  });

  test("verify again marks a failed verification stale so Verify plans it again", () => {
    const db = fresh();
    add(db, { n: 1, verify: "failed" });
    add(db, { n: 2, verify: "passed" });
    assert.equal(actionsOf(db, "app", 1).verifyAgain, true);
    verifyAgain(db, "op", "app", 1);
    assert.equal(db.prepare("SELECT state FROM verifications WHERE number = 1").get()!.state, "stale");
    assert.throws(() => verifyAgain(db, "op", "app", 2), ActionError);
    assert.equal(buildQueue(db, { run: "r1" }).find((e) => e.number === 1)!.state, "waiting-verify");
  });

  test("try the fix again forgets a skipped attempt but keeps one with a PR", () => {
    const db = fresh();
    add(db, { n: 1, kind: "issue" });
    add(db, { n: 2, kind: "issue" });
    const row = db.prepare(`INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, round, pr_url, created_at, updated_at) VALUES ('app', ?, 'm', 'h', ?, 3, ?, '${T0}', '${T0}')`);
    row.run(1, "skipped", null);
    row.run(2, "failed", "https://example.test/pr/1");
    assert.equal(actionsOf(db, "app", 1).fixAgain, true);
    assert.equal(actionsOf(db, "app", 2).fixAgain, false);
    fixAgain(db, "op", "app", 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fix_attempts WHERE number = 1").get()!.n, 0);
    assert.throws(() => fixAgain(db, "op", "app", 2), ActionError);
  });
});
