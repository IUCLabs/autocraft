// The pre-merge review: reply validation, and the step that reviews the PRs waiting in the merge queue.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setRunner } from "../src/classify/run.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { parseArgs } from "../src/premerge/index.ts";
import { lintPremerge, parsePremerge } from "../src/premerge/parse.ts";
import { candidateOf, premergeCandidates, runPremerge, type PremergeDeps } from "../src/premerge/review.ts";
import { findingsOf, PREMERGE_MAX_TRIES, premergeAt, savePremerge } from "../src/premerge/store.ts";
import { prepareOpusInput } from "../src/review/opus.ts";
import { mergeApprovalOf } from "../src/merge/approval.ts";
import { OPUS_MAX_FIXES } from "../src/review/opus-parse.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { fresh as freshDb } from "./batch-fixture.ts";

const REF = "app#1";
const finding = (extra: Record<string, unknown> = {}) => ({ severity: "defect", file: "src/a.rs", line: 7, title: "off by one", scenario: "an empty list panics", ...extra });
const reply = (findings: unknown[], ref = REF) => JSON.stringify({ ref, findings, searched: "callers of the changed function" });

describe("premerge reply", () => {
  test("a valid reply and an empty list are kept", () => {
    const r = parsePremerge(reply([finding({ fix: { file: "src/a.rs", change: "check the bound" } }), finding({ severity: "minor", title: "naming" })]), REF)!;
    assert.equal(r.findings.length, 2);
    assert.deepEqual(r.findings[0]!.fix, { file: "src/a.rs", change: "check the bound" });
    assert.equal(r.findings[1]!.fix, undefined);
    assert.equal(r.searched, "callers of the changed function");
    assert.deepEqual(parsePremerge(reply([]), REF)!.findings, []);
  });

  test("a wrong ref, a missing findings array and text without an object are no review", () => {
    assert.equal(parsePremerge(reply([finding()], "app#2"), REF), null);
    assert.equal(parsePremerge(JSON.stringify({ ref: REF }), REF), null);
    assert.equal(parsePremerge("no findings today", REF), null);
    assert.equal(lintPremerge(reply([], "app#2"), REF), null);
  });

  test("bad entries are dropped; a bad or leaking fix is dropped from its finding", () => {
    const r = parsePremerge(reply([
      finding({ severity: "blocker" }), finding({ line: "7" }), finding({ file: undefined }), finding({ title: " " }), "text", null,
      finding({ title: "kept", fix: { file: "../etc/passwd", change: "x" } }),
      finding({ title: "kept too", fix: { file: "src/b.rs", change: "see /reference/p0001.txt" } }),
      finding({ title: "mentions p0042.txt" }),
    ]), REF)!;
    assert.deepEqual(r.findings.map((f) => f.title), ["kept", "kept too"]);
    assert.ok(r.findings.every((f) => f.fix === undefined));
    const problems = lintPremerge(reply([finding({ fix: { file: "src/b.rs", change: "see /reference/p0001.txt" } }), finding({ scenario: "see /reference" })]), REF)!;
    assert.deepEqual(problems.map((p) => p.field), ["findings[0].fix.change", "findings[1].scenario"]);
  });

  test("at most the cap of fixes are kept over all findings", () => {
    const many = Array.from({ length: OPUS_MAX_FIXES + 3 }, (_, i) => finding({ title: `f${i}`, fix: { file: "src/a.rs", change: `change ${i}` } }));
    const r = parsePremerge(reply(many), REF)!;
    assert.equal(r.findings.filter((f) => f.fix).length, OPUS_MAX_FIXES);
    assert.ok(r.findings.length > OPUS_MAX_FIXES, "findings past the cap stay without a fix");
  });
});

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
const deps: PremergeDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), model: "opus", maxChars: 120_000 };

/** PR 1 at head `sha1`, reviewed and verified, with CI green and no pre-merge review: the queue holds it in waiting-premerge. */
function world(): DatabaseSync {
  const db = freshDb([{ n: 1 }]);
  useTestAccount(db);
  db.prepare("DELETE FROM premerge_reviews").run();
  return db;
}
const model = (calls: string[], text: string | (() => string)) => setRunner(async (_cmd, _args, input) => {
  calls.push(input);
  return { code: 0, stdout: JSON.stringify({ type: "result", result: typeof text === "string" ? text : text(), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
});
const state = (db: DatabaseSync) => buildQueue(db, { merged: "exclude" }).find((e) => e.number === 1)?.state;

describe("premerge step", () => {





  test("a call without a valid reply records a try, and the head waits an hour before the next", async () => {
    const db = world();
    const restore = model([], "I found nothing to report");
    try { await runPremerge(db, { repo: "app" }, () => {}, deps); } finally { restore(); }
    const row = premergeAt(db, "app", 1, "sha1")!;
    assert.equal(row.tries, 1);
    assert.match(row.error ?? "", /^retry: /);
    assert.equal(state(db), "waiting-premerge");
    assert.deepEqual(premergeCandidates(db, { repo: "app", at: Date.now() }), []);
    assert.deepEqual(premergeCandidates(db, { repo: "app", at: Date.now() + 3_700_000 }).map((e) => e.number), [1]);
    for (let i = row.tries; i < PREMERGE_MAX_TRIES; i++) savePremerge(db, { repo: "app", number: 1, head: "sha1", at: row.at, error: "retry: x" });
    assert.deepEqual(premergeCandidates(db, { repo: "app", at: Date.now() + 7_200_000 }), [], "no tries left");
  });

});
