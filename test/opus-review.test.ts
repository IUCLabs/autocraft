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
import { selectCandidates as verifyCandidates } from "../src/verify/select.ts";
import { claudeArgs, claudeParts, renderClaude } from "../src/prompts/index.ts";
import { selectOpusCandidates } from "../src/review/opus-candidates.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { parseOpusReply, type OpusPr } from "../src/review/opus-parse.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "opus-review-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

const file = (path: string, removed: string[], added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((l) => `-${l}\n`).join("")}${added.map((l) => `+${l}\n`).join("")}`;

describe("Opus reply", () => {
  test("keeps a valid object; take-fix needs fixes; sure must be a boolean", () => {
    const ok = { ref: "app#1", verdict: "take-fix", sure: true, reason: "r", fixes: [{ file: "a.rs", change: "x" }], risks: ["y"] };
    assert.equal(parseOpusReply(`here: ${JSON.stringify(ok)}`, "app#1")?.fixes.length, 1);
    assert.equal(parseOpusReply(JSON.stringify([ok]), "app#1")?.verdict, "take-fix");
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, fixes: [] }), "app#1"), null);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, sure: "yes" }), "app#1"), null);
    assert.equal(parseOpusReply(JSON.stringify(ok), "app#2"), null);
    // A summary over the cap fails the reply until the last attempt, which keeps its first sentence; code never cuts mid-sentence.
    const long = `Short first sentence. ${Array.from({ length: 90 }, (_, i) => `w${i}`).join(" ")}.`;
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, summary: long }), "app#1", false), null);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, summary: long }), "app#1", true)?.summary, "Short first sentence.");
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, why: long }), "app#1", false), null);
    const withText = parseOpusReply(JSON.stringify({ ...ok, summary: "Does X.  Take it.", why: "It is small." }), "app#1");
    assert.deepEqual([withText?.summary, withText?.why, parseOpusReply(JSON.stringify(ok), "app#1")?.summary], ["Does X. Take it.", "It is small.", null]);
    assert.equal(parseOpusReply(JSON.stringify(ok), "app#1")?.public, null);
    const pub = { summary: "Fine.", points: ["a.rs:1: x"] };
    assert.deepEqual(parseOpusReply(JSON.stringify({ ...ok, public: pub }), "app#1")?.public, pub);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, public: { summary: "", points: [] } }), "app#1")?.public, null);
    assert.equal(parseOpusReply(JSON.stringify({ ...ok, public: "text" }), "app#1")?.verdict, "take-fix");
    assert.deepEqual(parseOpusReply(JSON.stringify({ ...ok, verdict: "take", fixes: [{ file: "a", change: "b" }] }), "app#1")?.fixes, []);
  });
});

const CODE = file("src/lib.rs", ["let a = 1;"], ["let a = 2;"]);

/** Five wanted PRs without a review (PR 4 changes only docs), and PR 6, whose label is not reviewed. */
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', ?, 'pr', 'OPEN', ?, 'regular', 5, 0, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', ?, '[]', '{"top":0.95}')`);
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    item.run(n, `PR ${n}`, `sha${n}a`);
    jev.run(n, n === 6 ? "plugin candidate" : "bugfix");
    checks.run(n, `sha${n}a`);
  }
  db.exec("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')");
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
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
  db.prepare("SELECT verdict, sure, reason, fixes FROM final_reviews WHERE number = ?").get(n) as { verdict: string; sure: number; reason: string; fixes: string | null };

describe("Opus review pass", () => {
  test("every wanted PR with no review is a candidate, docs-only ones too", () => {
    assert.deepEqual(selectOpusCandidates(fresh(), "app").map((c) => c.number), [1, 2, 3, 4, 5]);
  });

  test("a PR without a review has no queue state", () => {
    assert.equal(buildQueue(fresh(), { run: null }).length, 0);
    assert.equal(final(fresh(), 1), undefined);
  });

  test("one call per PR with the registered prompt; Opus's verdict and fix list are the final review; the Opus take reaches Verify", async () => {
    const db = fresh();
    const calls: Call[] = [];
    const restore = setRunner(fakeOpus(calls, { "app#2": { verdict: "take-fix", fixes: [{ file: "src/lib.rs", change: "opus fix" }] }, "app#3": { verdict: "hold" } }));
    try {
      const s = await runOpusReview(db, { repo: "app" }, () => {}, deps());
      assert.deepEqual([s.reviewed, s.missing.length], [5, 0]);
    } finally {
      restore();
    }
    assert.equal(calls.length, 5);
    const input = JSON.parse(calls[0]!.input.split("<pr>\n")[1]!.split("\n</pr>")[0]!) as OpusPr;
    const parts = claudeParts("review.opus", [input], false);
    assert.equal(calls[0]!.input, parts.stdin);
    assert.deepEqual(calls[0]!.args, claudeArgs("review.opus", "opus", false, undefined, parts.system));
    assert.deepEqual([input.mode, input.earlier_opus], ["full", null]);
    assert.ok(!("sonnet" in input));

    assert.equal(final(db, 1).verdict, "take");
    assert.equal(final(db, 4).verdict, "take");
    assert.equal(final(db, 3).verdict, "hold");
    assert.deepEqual(JSON.parse(final(db, 2).fixes!), [{ file: "src/lib.rs", change: "opus fix" }]);
    assert.equal(selectOpusCandidates(db, "app").length, 0);
    assert.deepEqual(verifyCandidates(db, "app", null, () => null).map((c) => c.number), [1, 4, 5]);

    // Fix-up reads Opus's list
    setPushApproval(db, "op", "app", true);
    assert.deepEqual(selectFixups(db, "app").fix.find((c) => c.number === 2)!.fixes, [{ file: "src/lib.rs", change: "opus fix" }]);
  });

  test("a sure Opus close becomes a Close? candidate", async () => {
    const db = fresh();
    const restore = setRunner(fakeOpus([], { "app#1": { verdict: "close", sure: true } }));
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, deps());
    } finally {
      restore();
    }
    assert.deepEqual(closeCandidates(db, "app").map((r) => r.number), [1]);
  });

  test("a second review of the same head counts against the daily cap", async () => {
    const db = fresh();
    for (let i = 0; i < 2; i++) {
      const restore = setRunner(fakeOpus([], {}));
      try {
        await runOpusReview(db, { repo: "app", limit: 1 }, () => {}, deps());
        db.prepare("DELETE FROM opus_reviews WHERE number <> 1").run();
        db.prepare("UPDATE opus_reviews SET seen_at = '2020-01-01T00:00:00Z', disc_hash = 'x' WHERE number = 1").run();
        db.prepare("INSERT INTO comments (id, repo, number, kind, author, author_association, body, created_at, counted) VALUES (?, 'app', 1, 'comment', 'rabbit', 'CONTRIBUTOR', 'new finding', '2026-02-01T00:00:00Z', 1)").run(`c${i}`);
      } finally {
        restore();
      }
    }
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(`review_rerun:app#1:${day}`)?.value, "1");
  });

  test("a too-large PR stays too large after a small push; its hold is not the base of a delta", async () => {
    const db = fresh();
    process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs-large");
    const big = file("src/a.rs", ["x"], ["y".repeat(300)]);
    const calls: Call[] = [];
    const asked: string[] = [];
    const restore = setRunner(fakeOpus(calls, {}));
    const d = deps({
      maxChars: 200, fetchDiff: async () => ({ ok: true, text: big }),
      fetchDelta: async (_r, base, head) => { asked.push(`${base}..${head}`); return { ok: true, text: file("src/a.rs", ["a"], ["b"]) }; },
    });
    try {
      await runOpusReview(db, { repo: "app", limit: 1 }, () => {}, d);
      assert.equal(final(db, 1).verdict, "hold");
      db.prepare("UPDATE pr_checks SET head_oid = 'sha1b', fetched_at = '2026-01-03T00:00:00Z' WHERE number = 1").run();
      db.prepare("UPDATE items SET head_oid = 'sha1b' WHERE number = 1").run();
      await runOpusReview(db, { repo: "app", limit: 1 }, () => {}, d);
    } finally {
      restore();
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(asked, []);
    const row = db.prepare("SELECT verdict, model FROM opus_reviews WHERE number = 1 AND head_oid = 'sha1b'").get() as { verdict: string; model: string | null };
    assert.deepEqual({ ...row }, { verdict: "hold", model: null });
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
