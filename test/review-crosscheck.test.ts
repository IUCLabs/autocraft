import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { makeBatches } from "../src/review/batch.ts";
import { reviewCaps, setBatchSize } from "../src/review/batch-size.ts";
import { crosscheckEligible, crosscheckReport, runCrosscheck, type CrosscheckDeps } from "../src/review/crosscheck.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "review-crosscheck-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const CODE = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";

/** PRs 1-3: Sonnet holds from a model call. 4: hold without a call (too large). 5: take. 6: hold at an old head. */
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('shop', ?, 'pr', 'OPEN', ?, 'regular', 1, 1, ?, '${T0}', '${T0}')`);
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('shop', ?, ?, 'rv', '${T0}', ?, 'S', ?, ?)`);
  for (const [n, verdict, model, head] of [[1, "hold", "sonnet", "a"], [2, "hold", "sonnet", "a"], [3, "hold", "sonnet", "a"], [4, "hold", null, "a"], [5, "take", "sonnet", "a"], [6, "hold", "sonnet", "old"]] as const) {
    item.run(n, `PR ${n}`, `sha${n}a`);
    review.run(n, `sha${n}${head}`, model, verdict, `sonnet says ${verdict}`);
  }
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('shop', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  return db;
}

const snapshot = (db: DatabaseSync) => JSON.stringify(["reviews", "opus_reviews", "stages", "final_reviews", "merges"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all()));

const deps: CrosscheckDeps = {
  fetchDiff: async () => ({ ok: true, text: CODE }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "no compare" }),
  model: "opus", sonnetModel: "sonnet", maxChars: 120_000,
};

/** Opus takes PR 1 and holds the rest; single-PR Sonnet takes PR 2. */
const fake = (calls: string[]): Runner => async (_cmd, args, input) => {
  const ref = /"ref": "(shop#\d+)"/.exec(input)![1]!;
  const opus = args.join(" ").includes("opus");
  calls.push(`${opus ? "opus" : "sonnet"} ${ref}`);
  const take = opus ? ref === "shop#1" : ref === "shop#2";
  const body = opus
    ? { ref, verdict: take ? "take" : "hold", sure: true, reason: `opus ${take ? "take" : "hold"}`, fixes: [], risks: [] }
    : [{ ref, verdict: take ? "take" : "hold", reason: `single ${take ? "take" : "hold"}`, fixes: [], duplicate_of: null, overlaps: [], risks: [] }];
  return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(body), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
};

describe("review cross-check", () => {
  test("samples only batch holds at the current head, stores results and leaves the review tables alone", async () => {
    const db = fresh();
    assert.deepEqual(crosscheckEligible(db, "shop").map((c) => c.number), [1, 2, 3]);
    const before = snapshot(db);
    const calls: string[] = [];
    const restore = setRunner(fake(calls));
    let s;
    try {
      s = await runCrosscheck(db, { repo: "shop", sample: 2, single: true, seed: "s1" }, () => {}, deps);
    } finally {
      restore();
    }
    assert.equal(s.picked.length, 2);
    assert.ok(s.picked.every((r) => ["shop#1", "shop#2", "shop#3"].includes(r)));
    assert.equal(calls.length, 4);
    assert.equal(snapshot(db), before);
    const rows = db.prepare("SELECT number, batch_verdict, opus_verdict, single_verdict, seed FROM review_crosschecks WHERE run_id = ? ORDER BY number").all(s.runId) as { number: number; batch_verdict: string; opus_verdict: string; single_verdict: string; seed: string }[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.batch_verdict === "hold" && r.seed === "s1"));
    for (const r of rows) assert.equal(r.opus_verdict, r.number === 1 ? "take" : "hold");
    // the same seed picks the same PRs; a checked head is not drawn again
    const left = crosscheckEligible(db, "shop").map((c) => `shop#${c.number}`);
    assert.equal(left.length, 1);
    assert.ok(!s.picked.includes(left[0]!));
    const report = crosscheckReport(db, s.runId);
    assert.match(report, /Batch hold vs Opus \(2 reviewed\)/);
    assert.match(report, /Batch hold vs single-PR Sonnet/);
    assert.ok(report.includes("opus take") === s.picked.includes("shop#1"));
  });

  test("a batch size of 1 gives one PR per call", () => {
    const db = fresh();
    const prs = [1, 2, 3].map((n) => ({ ref: `shop#${n}`, files: ["src/lib.rs"], area: "src", diffChars: 100 }));
    assert.equal(makeBatches(prs, reviewCaps(db, "shop")).length, 1);
    assert.equal(setBatchSize(db, "op", "shop", 1), true);
    assert.deepEqual(makeBatches(prs, reviewCaps(db, "shop")).map((b) => b.length), [1, 1, 1]);
    assert.throws(() => setBatchSize(db, "op", "shop", 0));
    assert.equal(setBatchSize(db, "op", "shop", null), true);
    assert.equal(reviewCaps(db, "shop").perCall, 15);
  });
});
