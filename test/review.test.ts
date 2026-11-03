import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { claudeArgs, renderClaude } from "../src/prompts/index.ts";
import { DEFAULT_CAPS, makeBatches, type Batchable } from "../src/review/batch.ts";
import { selectCandidates } from "../src/review/candidates.ts";
import { checksQuery, parseChecks } from "../src/review/checks.ts";
import { codeDiff } from "../src/review/diff.ts";
import { runReview, type ReviewDeps } from "../src/review/index.ts";
import { applyDuplicateRule, parseReviewReply, type ReviewPr } from "../src/review/parse.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "review-test-"));
process.env.CRAFT_AUTO_DIFF_CACHE = join(dir, "diffs");

const T0 = "2026-01-01T00:00:00Z";

function fresh() {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  const pr = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, additions, deletions, changed_files, head_oid, created_at, updated_at)
    VALUES ('app', ?, 'pr', ?, ?, 'body', ?, ?, 0, 1, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', ?, ?, ?)`);
  const haiku = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('app', ?, 'haiku', 'r1', '${T0}', ?, '[]')`);
  const add = (n: number, label: string, o: { top?: number; flags?: string[]; draft?: boolean; state?: string; lines?: number; haiku?: string } = {}) => {
    pr.run(n, o.state ?? "OPEN", `PR ${n}`, o.draft ? 1 : 0, o.lines ?? 20, `sha${n}a`);
    jev.run(n, label, JSON.stringify(o.flags ?? []), JSON.stringify({ top: o.top ?? 0.95 }));
    if (o.haiku) haiku.run(n, o.haiku);
  };
  add(1, "bugfix");
  add(2, "plugin candidate");
  add(3, "bugfix", { draft: true });
  add(4, "bugfix", { state: "CLOSED" });
  add(5, "missing feature", { flags: ["needs decision"] });
  add(6, "missing feature", { flags: ["needs decision"] });
  add(7, "performance", { top: 0.6, haiku: "performance" });
  add(8, "performance", { top: 0.6, haiku: "bugfix" });
  add(9, "infra", { lines: 900 });
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_at)
    VALUES ('d1', 'scope', 'app', 6, 'q', '[]', '${T0}', 'take', '${T0}')`).run();
  return db;
}

const diffOf = (n: number) =>
  `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old${n}\n+new${n}\n` +
  `diff --git a/tests/t.rs b/tests/t.rs\n--- a/tests/t.rs\n+++ b/tests/t.rs\n@@ -1 +1 @@\n-a\n+b\n` +
  `diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-a\n+b\n`;

/** GitHub stand-in: checks report the head stored in `heads` (default the mirror's), CI green. */
function fakeQuerier(heads: Map<number, string>): Querier & { calls: number } {
  const q = {
    spent: 0, remaining: 5000 as number | null, calls: 0,
    async query(query: string) {
      q.calls++;
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      const repository = Object.fromEntries(nums.map((n) => [`pr${n}`, {
        number: n, state: "OPEN", isDraft: false, headRefOid: heads.get(n) ?? `sha${n}a`, mergeable: "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
      }]));
      return { repository };
    },
  };
  return q;
}

type Call = { args: string[]; input: string };

/** Claude stand-in: answers take for every PR in the prompt. */
function fakeClaude(calls: Call[], reply?: (refs: string[]) => unknown): Runner {
  return async (_cmd, args, input) => {
    calls.push({ args, input });
    const refs = [...input.matchAll(/"ref": "(app#\d+)"/g)].map((m) => m[1]!).filter((r, i, a) => a.indexOf(r) === i);
    const body = reply ? reply(refs) : refs.map((ref) => ({ ref, verdict: "take", reason: "fixes it", fixes: [], duplicate_of: null, overlaps: [], risks: [] }));
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(body), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
  };
}

function deps(heads = new Map<number, string>()): ReviewDeps & { querier: ReturnType<typeof fakeQuerier> } {
  return {
    querier: fakeQuerier(heads),
    fetchDiff: async (_repo, n) => ({ ok: true, text: diffOf(n) }),
    caps: DEFAULT_CAPS, model: "sonnet",
  };
}

const quiet = () => {};

describe("review candidates", () => {
  test("open, non-draft, wanted label, no open scope question", () => {
    const db = fresh();
    const got = selectCandidates(db, "app").map((c) => [c.number, c.size]);
    // 2 plugin candidate, 3 draft, 4 closed, 5 needs decision, 8 Jev unsure and Haiku disagrees
    assert.deepEqual(got, [[1, "S"], [6, "S"], [7, "S"], [9, "L"]]);
  });

  test("a scope answer of small-extra keeps a needs-decision PR; plugin does not", () => {
    const db = fresh();
    db.prepare("UPDATE decisions SET answer = 'small-extra' WHERE id = 'd1'").run();
    assert.ok(selectCandidates(db, "app").some((c) => c.number === 6));
    db.prepare("UPDATE decisions SET answer = 'plugin' WHERE id = 'd1'").run();
    assert.ok(!selectCandidates(db, "app").some((c) => c.number === 6));
  });
});

describe("runReview", () => {
  test("sends the registered prompt, stores verdicts, and re-reviews only a new head commit", async () => {
    const db = fresh();
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls));
    try {
      const d = deps();
      const s = await runReview(db, { repo: "app" }, quiet, d);
      assert.equal(s.reviewed, 4);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args, claudeArgs("review.sonnet", "sonnet"));
      const prs = JSON.parse(calls[0]!.input.split("<prs>\n")[1]!.split("\n</prs>")[0]!) as ReviewPr[];
      assert.equal(calls[0]!.input, renderClaude("review.sonnet", prs));
      // code only: the test file and the lockfile are listed, not shown
      assert.deepEqual(prs[0]!.files, ["src/lib.rs"]);
      assert.deepEqual(prs[0]!.tests_omitted, ["tests/t.rs"]);
      assert.ok(!prs[0]!.diff.includes("tests/t.rs"));
      assert.equal(prs[0]!.ci, "success");
      assert.deepEqual(prs[0]!.same_files_as.map((x) => x.ref), ["app#6", "app#7", "app#9"]);
      const rows = db.prepare("SELECT number, head_oid, verdict FROM reviews ORDER BY number").all().map((r) => ({ ...r }));
      assert.deepEqual(rows.map((r) => r.number), [1, 6, 7, 9]);
      const stages = db.prepare("SELECT stage FROM stages WHERE number = 1 ORDER BY rowid").all().map((r) => r.stage);
      assert.deepEqual(stages, ["reviewed", "take"]);
      assert.equal((db.prepare("SELECT sum(items) AS n FROM token_usage WHERE stage = 'review'").get() as { n: number }).n, 4);

      // Same heads: nothing to do, no model call.
      const again = await runReview(db, { repo: "app" }, quiet, d);
      assert.equal(again.candidates, 0);
      assert.equal(calls.length, 1);

      // A push to #7, seen by the next sync: only #7 is reviewed again.
      const pushed = deps(new Map([[7, "sha7b"]]));
      db.prepare("UPDATE pr_checks SET fetched_at = '2020-01-01T00:00:00Z'").run(); // older than the mirror row
      db.prepare("UPDATE items SET head_oid = 'sha7b', updated_at = '2026-02-01T00:00:00Z' WHERE number = 7").run();
      const third = await runReview(db, { repo: "app" }, quiet, pushed);
      assert.equal(third.reviewed, 1);
      assert.deepEqual(db.prepare("SELECT head_oid FROM reviews WHERE number = 7 ORDER BY at").all().map((r) => r.head_oid), ["sha7a", "sha7b"]);
    } finally {
      restore();
    }
  });

  test("a PR above the code-line cap is held without a model call; a bad reply is asked once more", async () => {
    const db = fresh();
    process.env.CRAFT_AUTO_DIFF_CACHE = join(dir, "diffs-2");
    db.prepare("DELETE FROM items WHERE number <> 1 AND number <> 7").run();
    const calls: Call[] = [];
    let n = 0;
    const restore = setRunner(fakeClaude(calls, (refs) => (n++ === 0 ? [{ ref: refs[0], verdict: "maybe", reason: "x" }] : refs.map((ref) => ({ ref, verdict: "hold", reason: "unsure" })))));
    try {
      const d = deps();
      const big = "+x\n".repeat(2000);
      d.fetchDiff = async (_repo, num) => ({ ok: true, text: num === 7 ? `diff --git a/src/big.rs b/src/big.rs\n@@ -0,0 +1 @@\n${big}` : diffOf(num) });
      const s = await runReview(db, { repo: "app" }, quiet, d);
      assert.equal(calls.length, 2);
      assert.deepEqual(s.verdicts, { hold: 2 });
      const r7 = db.prepare("SELECT model, reason FROM reviews WHERE number = 7").get() as { model: string | null; reason: string };
      assert.equal(r7.model, null);
      assert.match(r7.reason, /too large to review automatically/);
    } finally {
      restore();
    }
  });
});

describe("review batching", () => {
  const pr = (ref: string, files: string[], diffChars: number, area = "a"): Batchable => ({ ref, files, area, diffChars });
  test("respects the PR and character caps and keeps PRs on the same files together", () => {
    const prs = [
      pr("x#1", ["a.rs"], 100), pr("x#2", ["b.rs"], 100, "b"), pr("x#3", ["a.rs"], 100),
      pr("x#4", ["c.rs"], 900, "c"), pr("x#5", ["d.rs"], 2000, "d"),
    ];
    const caps = { perCall: 3, charsPerCall: 1000 };
    const batches = makeBatches(prs, caps);
    for (const b of batches) {
      assert.ok(b.length <= caps.perCall);
      assert.ok(b.length === 1 || b.reduce((s, p) => s + p.diffChars, 0) <= caps.charsPerCall);
    }
    const where = (ref: string) => batches.findIndex((b) => b.some((p) => p.ref === ref));
    assert.equal(where("x#1"), where("x#3"));
    assert.deepEqual(batches.flat().map((p) => p.ref).sort(), ["x#1", "x#2", "x#3", "x#4", "x#5"]);
    assert.deepEqual(batches.find((b) => b.some((p) => p.ref === "x#5"))!.map((p) => p.ref), ["x#5"]);
  });
});

describe("review reply", () => {
  const refs = ["app#1", "app#2", "app#3"];
  test("keeps valid verdicts and reports bad JSON, unknown verdicts and take-fix without fixes", () => {
    assert.deepEqual(parseReviewReply("I cannot review this.", refs).missing, refs);
    assert.deepEqual(parseReviewReply("[{oops", refs).reviews, []);
    const text = "```json\n" + JSON.stringify([
      { ref: "app#1", verdict: "take-fix", reason: "needs a guard " + "word ".repeat(40), fixes: [{ file: "src/a.rs", change: "check len before indexing" }], duplicate_of: "nonsense", overlaps: ["app#2", "bad"], risks: ["r"] },
      { ref: "app#2", verdict: "merge", reason: "x" },
      { ref: "app#3", verdict: "take-fix", reason: "x", fixes: [] },
      { ref: "other#9", verdict: "take", reason: "not asked" },
    ]) + "\n```";
    const { reviews, missing } = parseReviewReply(text, refs);
    assert.deepEqual(missing, ["app#2", "app#3"]);
    assert.equal(reviews[0]!.reason.split(" ").length, 25);
    assert.equal(reviews[0]!.duplicate_of, null);
    assert.deepEqual(reviews[0]!.overlaps, ["app#2"]);
  });

  test("a close for an unmerged duplicate becomes a hold", () => {
    const r = { ref: "app#1", verdict: "close" as const, reason: "same fix", fixes: [], duplicate_of: "app#2", overlaps: [], risks: [] };
    assert.equal(applyDuplicateRule(r, () => false).verdict, "hold");
    assert.equal(applyDuplicateRule(r, () => true).verdict, "close");
  });

  test("code diff leaves out tests and lockfiles", () => {
    const cd = codeDiff(diffOf(1));
    assert.deepEqual([cd.files, cd.testsOmitted, cd.lockfilesOmitted, cd.codeLines], [["src/lib.rs"], ["tests/t.rs"], ["Cargo.lock"], 2]);
  });
});

describe("checks", () => {
  test("one query per chunk; check states roll up to an overall state", () => {
    assert.equal([...checksQuery([1, 2]).matchAll(/pullRequest\(/g)].length, 2);
    const node = (n: number, ctx: object[]) => ({ number: n, state: "OPEN", isDraft: false, headRefOid: `h${n}`, mergeable: "CONFLICTING", maintainerCanModify: false,
      commits: { nodes: [{ commit: { statusCheckRollup: ctx.length ? { contexts: { nodes: ctx } } : null } }] } });
    const ok = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" };
    const rows = parseChecks("app", {
      pr1: node(1, [ok, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }]),
      pr2: node(2, [ok, { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }]),
      pr3: node(3, [ok, { __typename: "StatusContext", context: "ext", state: "ERROR" }, { __typename: "CheckRun", name: "x", status: "QUEUED" }]),
      pr4: node(4, []),
      pr5: null,
    });
    assert.deepEqual(rows.map((r) => [r.number, r.overall]), [[1, "success"], [2, "pending"], [3, "failure"], [4, "none"]]);
    assert.deepEqual(rows[2]!.checks.map((c) => c.state), ["success", "failure", "pending"]);
    assert.equal(rows[0]!.mergeable, "CONFLICTING");
  });
});
