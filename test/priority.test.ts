import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { selectCandidates as decideCandidates } from "../src/decide/select.ts";
import { toDecision } from "../src/dash/api/decisions.ts";
import type { DecisionRow } from "../src/decisions.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { rescore, runPrioritize } from "../src/priority/index.ts";
import { priorityOf } from "../src/priority/read.ts";
import { duplicateCounts } from "../src/priority/reach.ts";
import { LEVELS, levelWith, parseHaikuImpacts, reachOf, reachScore, settleImpact, type Reach } from "../src/priority/score.ts";
import { selectCandidates as reviewCandidates } from "../src/review/candidates.ts";
import { selectCandidates as verifyCandidates } from "../src/verify/candidates.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

const none: Reach = { comments: 0, commenters: 0, linked: 0, duplicates: 0, security: false, ageDays: 0 };
const all: Reach = { comments: 99, commenters: 99, linked: 9, duplicates: 9, security: true, ageDays: 999 };

describe("score", () => {
  test("reach is a 0 to 99 tie-breaker and the security flag raises the level by one", () => {
    assert.equal(reachScore(none), 0);
    assert.equal(reachScore(all), 99);
    assert.equal(reachOf(all), 1);
    assert.ok(reachScore({ ...none, comments: 10 }) > reachScore(none));
    assert.ok(reachScore({ ...none, security: true }) > reachScore({ ...none, ageDays: 365 }));
    assert.ok(reachScore({ ...none, duplicates: 2 }) > reachScore(none));
    assert.deepEqual(LEVELS.map((l) => levelWith(l, true)), ["P0", "P0", "P1", "P2", "P3"]);
    assert.deepEqual(LEVELS.map((l) => levelWith(l, false)), [...LEVELS]);
  });

  test("Jev at 0.9 or more stands; below it Haiku decides", () => {
    assert.deepEqual(settleImpact({ impact: "P1", p: 0.9 }, "P3"), { impact: "P1", model: "jev" });
    assert.deepEqual(settleImpact({ impact: "P1", p: 0.89 }, "P3"), { impact: "P3", model: "haiku" });
    assert.deepEqual(settleImpact({ impact: "P1", p: 0.5 }, null), { impact: "P1", model: "jev-unsure" });
    assert.equal(settleImpact(null, null), null);
  });

  test("Haiku reply keeps asked refs with a known class", () => {
    const r = parseHaikuImpacts(JSON.stringify([{ ref: "a#1", impact: "P3", reason: "x" }, { ref: "a#2", impact: "huge" }, { ref: "a#2", impact: "normal" }, { ref: "z#9", impact: "P3" }]), ["a#1", "a#2"]);
    assert.deepEqual(r.answers.map((a) => a.ref), ["a#1"]);
    assert.deepEqual(r.missing, ["a#2"]);
  });
});

type Call = { cmd: string; input: string };
/** Jev answers with `p` per ref (impact from `impacts`); Haiku answers `low`. */
function fake(calls: Call[], impacts: Record<string, string>, p: number): Runner {
  return async (cmd, _args, input) => {
    calls.push({ cmd, input });
    if (cmd === "jev") {
      const ref = /"ref\\":\\"([^\\]+)\\"/.exec(input)![1]!;
      const choice = impacts[ref] ?? "P2";
      return { code: 0, stdout: JSON.stringify({ answers: { impact: { choice, confidence: p, probabilities: { [choice]: p } } }, usage: { input_tokens: 10, output_tokens: 2 } }), stderr: "" };
    }
    const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(refs.map((ref) => ({ ref, impact: "P3", reason: "cosmetic" }))), usage: { input_tokens: 10, output_tokens: 2 } }), stderr: "" };
  };
}

function fixture(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "priority-test-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, comments_count, head_oid)
    VALUES ('photocraft', ?, ?, 'OPEN', ?, ?, 'someone', ?, ?, ?, ?)`);
  item.run(1, "issue", "Crash on save", "Crashes and loses the file", "2026-01-01T00:00:00Z", "2026-10-01T00:00:00Z", 6, null);
  item.run(2, "issue", "Typo in dialog", "Wording", "2026-01-02T00:00:00Z", "2026-10-02T00:00:00Z", 0, null);
  item.run(3, "issue", "Odd thing", "Unclear", "2026-01-03T00:00:00Z", "2026-10-03T00:00:00Z", 0, null);
  return db;
}

describe("prioritize", () => {
  test("Jev sure is accepted, unsure goes to Haiku, both are recorded; unchanged text is not rerun", async () => {
    const db = fixture();
    const calls: Call[] = [];
    const restore = setRunner(async (cmd, args, input, ...rest) => {
      const ref = /photocraft#(\d)/.exec(input)?.[0];
      const p = ref === "photocraft#3" ? 0.6 : 0.95;
      return fake(calls, { "photocraft#1": "P0", "photocraft#2": "P3", "photocraft#3": "P1" }, p)(cmd, args, input, ...rest);
    });
    try {
      const r = await runPrioritize(db, { limit: 10 });
      assert.equal(r.saved, 3);
      const row = (n: number) => db.prepare("SELECT * FROM item_priority WHERE repo = 'photocraft' AND number = ?").get(n) as Record<string, unknown>;
      assert.deepEqual([row(1).impact, row(1).model, row(1).haiku_impact], ["P0", "jev", null]);
      assert.deepEqual([row(3).impact, row(3).model, row(3).jev_impact, row(3).haiku_impact], ["P3", "haiku", "P1", "P3"]);
      assert.equal(calls.filter((c) => c.cmd === "claude").length, 1);
      const n = calls.length;
      const again = await runPrioritize(db, { limit: 10 });
      assert.equal(again.sent, 0);
      assert.equal(calls.length, n);
      // A changed body is rated again.
      db.prepare("UPDATE items SET body = 'Now it is about something else', embed_hash = NULL WHERE number = 2").run();
      assert.equal((await runPrioritize(db, { limit: 10 })).sent, 1);
    } finally { restore(); }
  });

  test("reach follows the signals without a model call", () => {
    const db = fixture();
    db.prepare(`INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('photocraft', 1, 'h', 'P2', 0, 'jev', 'x')`).run();
    const com = db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 1, ?, 'comment', ?, '2026-02-01', 'b')");
    com.run("c1", "u1");
    com.run("c2", "u2");
    assert.equal(rescore(db), 1);
    const s = (db.prepare("SELECT score FROM item_priority WHERE number = 1").get() as { score: number }).score;
    assert.ok(s > 0 && s < 99);
    assert.equal(rescore(db), 0);
  });

  test("rows written with the old impact names become levels, and a migrated database is left alone", () => {
    const path = join(mkdtempSync(join(SCRATCH, "priority-migrate-")), "t.db");
    const db = connect(path);
    const ins = db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, jev_impact, haiku_impact, score, model, at) VALUES ('photocraft', ?, 'h', ?, ?, ?, 40, 'jev', 'x')");
    ins.run(1, "critical", "critical", null);
    ins.run(2, "high", "normal", "high");
    ins.run(3, "normal", null, "low");
    ins.run(4, "low", "low", null);
    ins.run(5, "P4", "P4", null);
    db.close();
    const again = connect(path);
    const rows = again.prepare("SELECT impact, jev_impact, haiku_impact FROM item_priority ORDER BY number").all() as Record<string, string | null>[];
    assert.deepEqual(rows.map((r) => [r.impact, r.jev_impact, r.haiku_impact]), [["P0", "P0", null], ["P1", "P2", "P1"], ["P2", null, "P3"], ["P3", "P3", null], ["P4", "P4", null]]);
    again.close();
  });

  test("duplicate counts are read only when the table exists", () => {
    const db = fixture();
    db.exec("DROP TABLE duplicate_pairs");
    assert.equal(duplicateCounts(db).size, 0);
    db.exec("CREATE TABLE duplicate_pairs (repo TEXT, number INTEGER, canonical INTEGER, verdict TEXT)");
    db.exec("INSERT INTO duplicate_pairs VALUES ('photocraft', 2, 1, 'duplicate'), ('photocraft', 3, 1, 'duplicate'), ('photocraft', 4, 1, 'distinct')");
    assert.equal(duplicateCounts(db).get("photocraft#1"), 2);
  });
});

describe("ordering and API", () => {
  test("decide, review, verify and fix-up candidates take the highest score first; unscored last", () => {
    const db = connect(join(mkdtempSync(join(SCRATCH, "priority-order-")), "t.db"));
    db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
    const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, head_oid, is_draft, additions, deletions, changed_files)
      VALUES ('photocraft', ?, 'pr', 'OPEN', 't', 'b', 'a', ?, ?, ?, 0, 5, 5, 1)`);
    const prio = db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('photocraft', ?, 'h', 'P2', ?, 'jev', 'x')");
    const rank = db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('photocraft', ?, ?, '{}', 'x')");
    const score = { run: (n: number, v: number) => { prio.run(n, v); rank.run(n, v); } };
    const cls = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('photocraft', ?, 'jev', 'r1', '2026-10-01', 'bugfix', '["needs decision"]', '{"top":0.95,"needs_decision":0.9}')`);
    // number 1 is oldest and unscored; 2 scores 30, 3 scores 80.
    for (const n of [1, 2, 3]) {
      item.run(n, `2026-01-0${n}T00:00:00Z`, "2026-10-01T00:00:00Z", `sha${n}`);
      cls.run(n);
      db.prepare("INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('photocraft', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '2026-10-02')").run(n, `sha${n}`);
    }
    score.run(2, 30);
    score.run(3, 80);
    db.exec("INSERT OR REPLACE INTO repos (name, visibility) VALUES ('photocraft', 'public')");
    const nums = (xs: { number: number }[]) => xs.map((x) => x.number);
    assert.deepEqual(nums(decideCandidates(db, "r1")), [3, 2, 1]);
    db.exec(`UPDATE classifications SET flags = '[]', probs = '{"top":0.95,"needs_decision":0.05}'`);
    assert.deepEqual(nums(reviewCandidates(db, "photocraft", "r1")), [3, 2, 1]);
    for (const n of [1, 2, 3]) db.prepare("INSERT INTO reviews (repo, number, head_oid, verdict, reason, fixes, run_id, at) VALUES ('photocraft', ?, ?, 'take-fix', 'r', '[{\"file\":\"a\",\"change\":\"c\"}]', 'rv', '2026-10-02')").run(n, `sha${n}`);
    finalizeReviews(db);
    db.exec("INSERT INTO settings (key, value) VALUES ('push_approved:photocraft', '{}')");
    const fix = selectFixups(db, "photocraft");
    assert.deepEqual(nums([...fix.fix, ...fix.cannotPush]), [3, 2, 1]);
    db.exec("UPDATE reviews SET verdict = 'take'");
    assert.deepEqual(nums(verifyCandidates(db, "photocraft", "r1", () => true)), [3, 2, 1]);
  });

  test("the item and decision responses carry the badge data", () => {
    const db = fixture();
    assert.equal(priorityOf(db, "photocraft", 1), null);
    db.prepare(`INSERT INTO item_priority (repo, number, text_hash, impact, score, model, reason, at) VALUES ('photocraft', 1, 'h', 'P0', 82, 'jev', 'P0 0.95', 'x')`).run();
    assert.deepEqual(priorityOf(db, "photocraft", 1), { level: "P0", model: "jev", reason: "P0 0.95" });
    db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('d1', 'scope', 'photocraft', 1, 'In scope?', '[]', '2026-10-01')`).run();
    const row = db.prepare("SELECT * FROM decisions WHERE id = 'd1'").get() as unknown as DecisionRow;
    assert.equal(toDecision(db, row, { login: "x", operator: false }).priority?.level, "P0");
  });
});
