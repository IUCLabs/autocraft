import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
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
import { BANDS, IMPACTS, parseHaikuImpacts, reachOf, scoreOf, settleImpact, type Reach } from "../src/priority/score.ts";
import { selectCandidates as reviewCandidates } from "../src/review/candidates.ts";
import { selectCandidates as verifyCandidates } from "../src/verify/candidates.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });

const none: Reach = { comments: 0, commenters: 0, linked: 0, duplicates: 0, security: false, ageDays: 0 };
const all: Reach = { comments: 99, commenters: 99, linked: 9, duplicates: 9, security: true, ageDays: 999 };

describe("score", () => {
  test("impact sets the band and reach moves the score inside it", () => {
    for (const i of IMPACTS) {
      assert.equal(scoreOf(i, none), BANDS[i][0]);
      assert.equal(scoreOf(i, all), BANDS[i][1]);
    }
    assert.equal(reachOf(all), 1);
    assert.ok(scoreOf("normal", { ...none, comments: 10 }) > scoreOf("normal", none));
    assert.ok(scoreOf("normal", { ...none, security: true }) > scoreOf("normal", { ...none, ageDays: 365 }));
    assert.ok(scoreOf("normal", { ...none, duplicates: 2 }) > scoreOf("normal", none));
    assert.ok(scoreOf("critical", none) >= scoreOf("high", all));
  });

  test("Jev at 0.9 or more stands; below it Haiku decides", () => {
    assert.deepEqual(settleImpact({ impact: "high", p: 0.9 }, "low"), { impact: "high", model: "jev" });
    assert.deepEqual(settleImpact({ impact: "high", p: 0.89 }, "low"), { impact: "low", model: "haiku" });
    assert.deepEqual(settleImpact({ impact: "high", p: 0.5 }, null), { impact: "high", model: "jev-unsure" });
    assert.equal(settleImpact(null, null), null);
  });

  test("Haiku reply keeps asked refs with a known class", () => {
    const r = parseHaikuImpacts(JSON.stringify([{ ref: "a#1", impact: "low", reason: "x" }, { ref: "a#2", impact: "huge" }, { ref: "z#9", impact: "low" }]), ["a#1", "a#2"]);
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
      const choice = impacts[ref] ?? "normal";
      return { code: 0, stdout: JSON.stringify({ answers: { impact: { choice, confidence: p, probabilities: { [choice]: p } } }, usage: { input_tokens: 10, output_tokens: 2 } }), stderr: "" };
    }
    const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(refs.map((ref) => ({ ref, impact: "low", reason: "cosmetic" }))), usage: { input_tokens: 10, output_tokens: 2 } }), stderr: "" };
  };
}

function fixture(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "priority-test-")), "t.db"));
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
      return fake(calls, { "photocraft#1": "critical", "photocraft#2": "low", "photocraft#3": "high" }, p)(cmd, args, input, ...rest);
    });
    try {
      const r = await runPrioritize(db, { limit: 10 });
      assert.equal(r.saved, 3);
      const row = (n: number) => db.prepare("SELECT * FROM item_priority WHERE repo = 'photocraft' AND number = ?").get(n) as Record<string, unknown>;
      assert.deepEqual([row(1).impact, row(1).model, row(1).haiku_impact], ["critical", "jev", null]);
      assert.deepEqual([row(3).impact, row(3).model, row(3).jev_impact, row(3).haiku_impact], ["low", "haiku", "high", "low"]);
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

  test("rescoring follows reach without a model call", () => {
    const db = fixture();
    db.prepare(`INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('photocraft', 1, 'h', 'normal', 25, 'jev', 'x')`).run();
    const com = db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 1, ?, 'comment', ?, '2026-02-01', 'b')");
    com.run("c1", "u1");
    com.run("c2", "u2");
    assert.equal(rescore(db), 1);
    const s = (priorityOf(db, "photocraft", 1))!.score;
    assert.ok(s > 25 && s < 50);
    assert.equal(rescore(db), 0);
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
    const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, head_oid, is_draft, additions, deletions, changed_files)
      VALUES ('photocraft', ?, 'pr', 'OPEN', 't', 'b', 'a', ?, ?, ?, 0, 5, 5, 1)`);
    const score = db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('photocraft', ?, 'h', 'normal', ?, 'jev', 'x')");
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
    db.exec("UPDATE classifications SET flags = '[]'");
    assert.deepEqual(nums(reviewCandidates(db, "photocraft", "r1")), [3, 2, 1]);
    for (const n of [1, 2, 3]) db.prepare("INSERT INTO reviews (repo, number, head_oid, verdict, reason, fixes, run_id, at) VALUES ('photocraft', ?, ?, 'take-fix', 'r', '[{\"file\":\"a\",\"change\":\"c\"}]', 'rv', '2026-10-02')").run(n, `sha${n}`);
    db.exec("INSERT INTO settings (key, value) VALUES ('push_approved:photocraft', '{}')");
    const fix = selectFixups(db, "photocraft");
    assert.deepEqual(nums([...fix.fix, ...fix.cannotPush]), [3, 2, 1]);
    db.exec("UPDATE reviews SET verdict = 'take'");
    assert.deepEqual(nums(verifyCandidates(db, "photocraft", "r1", () => true)), [3, 2, 1]);
  });

  test("the item and decision responses carry the badge data", () => {
    const db = fixture();
    assert.equal(priorityOf(db, "photocraft", 1), null);
    db.prepare(`INSERT INTO item_priority (repo, number, text_hash, impact, score, model, reason, at) VALUES ('photocraft', 1, 'h', 'critical', 82, 'jev', 'critical 0.95', 'x')`).run();
    assert.deepEqual(priorityOf(db, "photocraft", 1), { impact: "critical", score: 82, model: "jev", reason: "critical 0.95" });
    db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('d1', 'scope', 'photocraft', 1, 'In scope?', '[]', '2026-10-01')`).run();
    const row = db.prepare("SELECT * FROM decisions WHERE id = 'd1'").get() as unknown as DecisionRow;
    assert.equal(toDecision(db, row, { login: "x", operator: false }).priority?.score, 82);
  });
});
