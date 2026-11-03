import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { closeCandidates } from "../src/act/index.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { claudeArgs, renderClaude } from "../src/prompts/index.ts";
import { selectOpusCandidates } from "../src/review/opus-candidates.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { parseOpusReply, type OpusPr } from "../src/review/opus-parse.ts";
import { skipReason } from "../src/review/skip.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "opus-review-test-"));
process.env.CRAFT_AUTO_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

const file = (path: string, removed: string[], added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((l) => `-${l}\n`).join("")}${added.map((l) => `+${l}\n`).join("")}`;

describe("skip list", () => {
  test("docs, translations and comments under 20 lines", () => {
    assert.match(skipReason(file("README.md", ["a"], ["b"]), null) ?? "", /docs/);
    assert.match(skipReason(file("locales/de/app.ftl", ["a = x"], ["a = y"]), null) ?? "", /docs/);
    assert.match(skipReason(file("src/lib.rs", ["// old"], ["// new", ""]), null) ?? "", /comments/);
    assert.equal(skipReason(file("src/lib.rs", ["let a = 1;"], ["let a = 2; // note"]), null), null);
    assert.equal(skipReason(file("README.md", [], Array.from({ length: 25 }, (_, i) => `line ${i}`)), null), null);
    // one code line next to docs is not docs only
    assert.equal(skipReason(file("README.md", ["a"], ["b"]) + file("src/lib.rs", ["x"], ["y"]), null), null);
  });

  test("dependency bumps need green CI and nothing but versions", () => {
    const lock = file("Cargo.lock", ["version = \"1.0.0\""], ["version = \"1.0.1\""]);
    const bump = file("Cargo.toml", ['serde = "1.0.1"'], ['serde = "1.0.2"']);
    assert.match(skipReason(lock + bump, "success") ?? "", /dependency/);
    assert.equal(skipReason(lock + bump, "pending"), null);
    assert.equal(skipReason(file("Cargo.toml", ['serde = "1.0.1"'], ['serde = "1.0.2"', 'evil = "0.1.0"']), "success"), null);
    assert.equal(skipReason(file("package.json", ['"build": "tsc"'], ['"build": "rm -rf /"']), "success"), null);
  });

  test("test-only changes", () => {
    assert.equal(skipReason(file("tests/a.rs", ["a"], ["b"]) + file("src/x_test.rs", ["a"], ["b"]), null), "test files only");
    assert.equal(skipReason(file("tests/a.rs", ["a"], ["b"]) + file("src/lib.rs", ["a"], ["b"]), null), null);
    assert.equal(skipReason("", null), null);
  });
});

describe("Opus reply", () => {
  test("keeps a valid object; take-fix needs fixes; sure must be a boolean", () => {
    const ok = { ref: "app#1", verdict: "take-fix", sure: true, reason: "r", fixes: [{ file: "a.rs", change: "x" }], risks: ["y"] };
    assert.equal(parseOpusReply(`here: ${JSON.stringify(ok)}`, "app#1")?.fixes.length, 1);
    assert.equal(parseOpusReply(JSON.stringify([ok]), "app#1")?.verdict, "take-fix");
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, fixes: [] }), "app#1"), null);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, sure: "yes" }), "app#1"), null);
    assert.equal(parseOpusReply(JSON.stringify(ok), "app#2"), null);
    assert.equal(parseOpusReply(JSON.stringify(ok), "app#1")?.public, null);
    const pub = { summary: "Fine.", points: ["a.rs:1: x"] };
    assert.deepEqual(parseOpusReply(JSON.stringify({ ...ok, public: pub }), "app#1")?.public, pub);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, public: { summary: "", points: [] } }), "app#1")?.public, null);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, public: "text" }), "app#1")?.verdict, "take-fix");
    assert.deepEqual(parseOpusReply(JSON.stringify({ ...ok, verdict: "take", fixes: [{ file: "a", change: "b" }] }), "app#1")?.fixes, []);
  });
});

const CODE = file("src/lib.rs", ["let a = 1;"], ["let a = 2;"]);

/** PR 1 take, PR 2 take-fix (both code), PR 3 Sonnet hold, PR 4 take with a docs-only diff, PR 5 take (code). */
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', ?, 'pr', 'OPEN', ?, 'regular', 5, 0, ?, '${T0}', '${T0}')`);
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', ?, ?, 'rv', '${T0}', 'sonnet', 'S', ?, 'sonnet says', ?)`);
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`);
  const SONNET_FIXES = JSON.stringify([{ file: "src/lib.rs", change: "sonnet fix" }]);
  for (const [n, verdict] of [[1, "take"], [2, "take-fix"], [3, "hold"], [4, "take"], [5, "take"]] as const) {
    item.run(n, `PR ${n}`, `sha${n}a`);
    review.run(n, `sha${n}a`, verdict, verdict === "take-fix" ? SONNET_FIXES : null);
    checks.run(n, `sha${n}a`);
  }
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('app', 'op', ?) ON CONFLICT DO NOTHING").run(T0);
  return db;
}

type Call = { args: string[]; input: string };
type Answer = { verdict: string; sure?: boolean; fixes?: { file: string; change: string }[] };

function fakeOpus(calls: Call[], answers: Record<string, Answer>): Runner {
  return async (_cmd, args, input) => {
    calls.push({ args, input });
    const ref = /"ref": "(app#\d+)"/.exec(input)![1]!;
    const a = answers[ref] ?? { verdict: "take" };
    const body = { ref, verdict: a.verdict, sure: a.sure ?? true, reason: `opus ${a.verdict}`, fixes: a.fixes ?? [], risks: [] };
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(body), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
  };
}

const deps = (over: Partial<OpusDeps> = {}): OpusDeps => ({
  fetchDiff: async (_r, n) => ({ ok: true, text: n === 4 ? file("docs/guide.md", ["a"], ["b"]) : CODE }),
  fetchDelta: async () => ({ ok: false, tooLarge: false, error: "no compare" }),
  model: "opus", maxChars: 120_000, ...over,
});

const final = (db: DatabaseSync, n: number) =>
  db.prepare("SELECT verdict, reason, fixes, source, final, skip_reason FROM final_reviews WHERE number = ?").get(n) as { verdict: string; reason: string; fixes: string | null; source: string; final: number; skip_reason: string | null };

describe("Opus review pass", () => {
  test("candidates are Sonnet take and take-fix at the current head", () => {
    assert.deepEqual(selectOpusCandidates(fresh(), "app").map((c) => c.number), [1, 2, 4, 5]);
  });

  test("a take waits for Opus in the queue; a hold is final at once", () => {
    const db = fresh();
    assert.equal(buildQueue(db, { run: null }).find((e) => e.number === 1)!.state, "waiting-opus");
    assert.deepEqual([1, 2, 3, 4].map((n) => final(db, n).final), [0, 0, 1, 0]);
  });

  test("one call per PR with the registered prompt; Opus's verdict and fix list replace Sonnet's; the skip list makes no call", async () => {
    const db = fresh();
    const calls: Call[] = [];
    const restore = setRunner(fakeOpus(calls, { "app#2": { verdict: "take-fix", fixes: [{ file: "src/lib.rs", change: "opus fix" }] }, "app#5": { verdict: "close", sure: false } }));
    try {
      const s = await runOpusReview(db, { repo: "app" }, () => {}, deps());
      assert.deepEqual([s.reviewed, s.skipListed, s.missing.length], [3, 1, 0]);
    } finally {
      restore();
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]!.args, claudeArgs("review.opus", "opus"));
    const input = JSON.parse(calls[0]!.input.split("<pr>\n")[1]!.split("\n</pr>")[0]!) as OpusPr;
    assert.equal(calls[0]!.input, renderClaude("review.opus", [input]));
    assert.deepEqual([input.mode, input.sonnet.verdict, input.earlier_opus], ["full", "take", null]);

    assert.deepEqual([final(db, 1).verdict, final(db, 1).source, final(db, 1).final], ["take", "opus", 1]);
    assert.deepEqual(JSON.parse(final(db, 2).fixes!), [{ file: "src/lib.rs", change: "opus fix" }]);
    assert.deepEqual([final(db, 4).verdict, final(db, 4).source, final(db, 4).final], ["take", "skip-list", 1]);
    assert.match(final(db, 4).skip_reason ?? "", /docs/);
    // Opus close while unsure and disagreeing with Sonnet: a person decides, both reviews in the reason
    const f5 = final(db, 5);
    assert.equal(f5.verdict, "hold");
    assert.match(f5.reason, /Sonnet \(take\).*Opus \(close\)/);
    assert.equal(final(db, 3).source, "sonnet");
    assert.equal(selectOpusCandidates(db, "app").length, 0);
    assert.notEqual(buildQueue(db, { run: null }).find((e) => e.number === 1)!.state, "waiting-opus");

    // Fix-up reads Opus's list, not Sonnet's
    setPushApproval(db, "op", "app", true);
    const fix = selectFixups(db, "app").fix.find((c) => c.number === 2)!;
    assert.deepEqual(fix.fixes, [{ file: "src/lib.rs", change: "opus fix" }]);
  });

  test("a sure Opus close becomes a Close? candidate; a sure disagreement stands without a person", async () => {
    const db = fresh();
    const restore = setRunner(fakeOpus([], { "app#1": { verdict: "close", sure: true }, "app#2": { verdict: "take", sure: true } }));
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, deps());
    } finally {
      restore();
    }
    assert.deepEqual(closeCandidates(db, "app").map((r) => [r.number, r.source]), [[1, "opus"]]);
    assert.deepEqual([final(db, 2).verdict, final(db, 2).fixes], ["take", null]);
  });

  test("after a push Opus reads the delta with its earlier review; without a delta it reads the full diff", async () => {
    const db = fresh();
    let restore = setRunner(fakeOpus([], {}));
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, deps());
    } finally {
      restore();
    }
    const push = (n: number, head: string) => {
      db.prepare("UPDATE pr_checks SET head_oid = ?, fetched_at = '2026-01-03T00:00:00Z' WHERE number = ?").run(head, n);
      db.prepare("UPDATE items SET head_oid = ? WHERE number = ?").run(head, n);
      db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('app', ?, ?, 'rv2', '2026-01-03T00:00:00Z', 'sonnet', 'S', 'take', 'again')`).run(n, head);
    };
    push(1, "sha1b");
    push(2, "sha2b");
    const calls: Call[] = [];
    restore = setRunner(fakeOpus(calls, {}));
    const asked: string[] = [];
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, deps({
        fetchDelta: async (_r, base, head) => {
          asked.push(`${base}..${head}`);
          return base === "sha1a" ? { ok: true, text: file("src/lib.rs", ["let a = 2;"], ["let a = 3;"]) } : { ok: false, tooLarge: false, error: "diverged" };
        },
      }));
    } finally {
      restore();
    }
    assert.deepEqual(asked.sort(), ["sha1a..sha1b", "sha2a..sha2b"]);
    const inputs = calls.map((c) => JSON.parse(c.input.split("<pr>\n")[1]!.split("\n</pr>")[0]!) as OpusPr);
    const one = inputs.find((i) => i.ref === "app#1")!, two = inputs.find((i) => i.ref === "app#2")!;
    assert.equal(one.mode, "delta");
    assert.equal(one.earlier_opus?.head, "sha1a");
    assert.ok(one.diff.includes("let a = 3;") && !one.diff.includes("let a = 1;"));
    assert.deepEqual([two.mode, two.earlier_opus], ["full", null]);
    const row = db.prepare("SELECT mode, base_head FROM opus_reviews WHERE number = 1 AND head_oid = 'sha1b'").get() as { mode: string; base_head: string };
    assert.deepEqual({ ...row }, { mode: "delta", base_head: "sha1a" });
  });
});
