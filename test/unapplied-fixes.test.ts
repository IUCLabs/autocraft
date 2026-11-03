// A take-fix whose fixes were never applied before the head changed: the next review gets them as unapplied_fixes
// and must keep or explain each (one fix turn when it does neither). Model calls are fakes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { setRunner, setWorkspace, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import type { OpusPr } from "../src/review/opus-parse.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "unapplied-fixes-"));
process.env.AUTOCRAFT_DB = join(dir, "data", "t.db");
process.env.AUTOCRAFT_CLAUDE_BIN = "/bin/true";
process.env.AUTOCRAFT_CHECKOUT_DIR = join(dir, "checkouts");
process.env.AUTOCRAFT_CLAUDE_CWD = join(dir, "cwd");
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
setWorkspace(async () => []);
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-03T00:00:00Z";
const checkout = join(dir, "co");
mkdirSync(checkout);
const CODE = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n";
const FIX = { file: "src/lib.rs", change: "rename a to count" };

/** PR 1: a take-fix at sha1, then our conflict merge made sha2, which has no review yet. */
function atMergedHead(fixup?: string): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  // The fix turn needs a sandboxed call, which needs an account whose token is not near expiry.
  const box = useTestAccount(db);
  mkdirSync(`${box.configDir}t`, { recursive: true });
  writeFileSync(`${box.configDir}t/.credentials.json`, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, additions, deletions, head_oid, created_at, updated_at, labels)
    VALUES ('app', 1, 'pr', 'OPEN', 'PR 1', 'Body', 'regular', 5, 0, 'sha2', '${T0}', '${T2}', '[]')`).run();
  db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 1, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run();
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 1, 'sha2', 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T2}')`).run();
  db.exec("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')");
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, mode, verdict, sure, reason, fixes)
    VALUES ('app', 1, 'sha1', 'rv', '${T1}', 'opus', 'full', 'take-fix', 1, 'small fix', ?)`).run(JSON.stringify([FIX]));
  db.prepare(`INSERT INTO conflict_merges (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'sha1', 'sha2', 'merged', 1, '${T2}')`).run();
  if (fixup) db.prepare(`INSERT INTO fixups (repo, number, from_head, state, attempt, created_at) VALUES ('app', 1, 'sha1', ?, 1, '${T2}')`).run(fixup);
  return db;
}

const reply = (over: Record<string, unknown>) => JSON.stringify({ ref: "app#1", verdict: "take", sure: true, reason: "ok", fixes: [], risks: [], ...over });
type Call = { input: string };
function fakeModel(replies: string[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const restore = setRunner((async (_cmd, _args, input) => {
    calls.push({ input });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return { code: 0, stdout: `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })}\n${JSON.stringify({ type: "result", session_id: "sess-1", result: text, num_turns: 2, usage: { input_tokens: 100, output_tokens: 10 } })}\n`, stderr: "" };
  }) as Runner);
  return { calls, restore };
}
const deps: OpusDeps = {
  fetchDiff: async () => ({ ok: true, text: CODE }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "no compare" }),
  model: "opus", maxChars: 120_000, checkout: async () => checkout,
};
async function review(db: DatabaseSync, replies: string[]) {
  const m = fakeModel(replies);
  try {
    await runOpusReview(db, { repo: "app" }, () => {}, deps);
  } finally {
    m.restore();
  }
  return m.calls;
}
const prOf = (c: Call) => JSON.parse(c.input.split("<pr>\n")[1]!.split("\n</pr>")[0]!) as OpusPr;
const carried = (db: DatabaseSync) => db.prepare("SELECT from_head, file, outcome FROM opus_carried_fixes WHERE number = 1 AND head_oid = 'sha2'").all().map((r) => ({ ...r }));

describe("unapplied fixes of an earlier take-fix", () => {
  test("the review at the merged head is given the earlier fixes", async () => {
    const db = atMergedHead();
    const calls = await review(db, [reply({ verdict: "take-fix", fixes: [FIX] })]);
    assert.deepEqual(prOf(calls[0]!).unapplied_fixes, [{ head: "sha1", ...FIX }]);
  });

  test("fixes that were pushed or posted as a comment are not given again", async () => {
    for (const state of ["pushed", "asked"]) {
      const calls = await review(atMergedHead(state), [reply({})]);
      assert.equal(prOf(calls[0]!).unapplied_fixes, undefined, state);
      assert.equal(calls.length, 1);
    }
  });

  test("a take that ignores them gets one fix turn; a reply that keeps the fix is stored and Fix-up can apply it at the new head", async () => {
    const db = atMergedHead();
    const calls = await review(db, [reply({ reason: "Looks fine." }), reply({ verdict: "take-fix", reason: "Fix still needed.", fixes: [{ file: "src/lib.rs", change: "rename a to count, as asked before" }] })]);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.input, /^Your reply has these problems:\n- unapplied_fixes\[0\]: \(src\/lib\.rs\) is neither in fixes nor explained in reason\n/);
    assert.deepEqual(carried(db), [{ from_head: "sha1", file: "src/lib.rs", outcome: "kept" }]);
    setPushApproval(db, "op", "app", true);
    const fix = selectFixups(db, "app").fix.find((c) => c.number === 1)!;
    assert.deepEqual([fix.head, fix.fixes.length], ["sha2", 1]);
  });

  test("a take whose reason explains each fix is accepted without a fix turn", async () => {
    const db = atMergedHead();
    const calls = await review(db, [reply({ reason: "The src/lib.rs rename is already in the merged code." })]);
    assert.equal(calls.length, 1);
    assert.deepEqual(carried(db), [{ from_head: "sha1", file: "src/lib.rs", outcome: "explained" }]);
    assert.equal((db.prepare("SELECT verdict FROM final_reviews WHERE number = 1 AND head_oid = 'sha2'").get() as { verdict: string }).verdict, "take");
  });

  test("a take that still ignores them after the fix turn is stored unsure, with the reason in its risks", async () => {
    const db = atMergedHead();
    const calls = await review(db, [reply({ reason: "Looks fine." })]);
    assert.equal(calls.length, 2);
    const row = db.prepare("SELECT sure, risks FROM opus_reviews WHERE number = 1 AND head_oid = 'sha2'").get() as { sure: number; risks: string };
    assert.equal(row.sure, 0);
    assert.deepEqual(JSON.parse(row.risks), ["an earlier fix was neither made nor explained"]);
    assert.deepEqual(carried(db), [{ from_head: "sha1", file: "src/lib.rs", outcome: "unaddressed" }]);
  });
});
