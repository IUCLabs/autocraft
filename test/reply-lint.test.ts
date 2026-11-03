// Reply lint and the fix turn: problems of a parsed reply go back to the model as one follow-up message on the same
// session; what is still wrong afterwards falls back to leaving the text out. Model and Jev calls are fakes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { setRunner, setWorkspace, type Runner } from "../src/classify/run.ts";
import { answerPending } from "../src/conversations/run.ts";
import { addOperatorMessage, turnsOf } from "../src/conversations/store.ts";
import { connect } from "../src/db.ts";
import { refersToDocumentation, quotesReference, type SemanticDeps } from "../src/reference-lint.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "reply-lint-"));
process.env.AUTOCRAFT_DB = join(dir, "data", "t.db");
process.env.AUTOCRAFT_CLAUDE_BIN = "/bin/true";
process.env.AUTOCRAFT_CHECKOUT_DIR = join(dir, "checkouts");
process.env.AUTOCRAFT_CLAUDE_CWD = join(dir, "cwd");
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
mkdirSync(join(dir, "data", "reference", "app"), { recursive: true });
const REFERENCE_TEXT = "To resize a picture hold the shift key while you drag any corner handle of the picture and release the mouse button when the preview shows the size you want";
writeFileSync(join(dir, "data", "reference", "app", "p0001.txt"), `Chapter one\n${REFERENCE_TEXT}\nMore text here.\n`);
setWorkspace(async () => []);
const T0 = "2026-01-01T00:00:00Z";
const checkout = join(dir, "co");
mkdirSync(checkout);

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  const box = useTestAccount(db);
  mkdirSync(`${box.configDir}t`, { recursive: true });
  writeFileSync(`${box.configDir}t/.credentials.json`, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, additions, deletions, head_oid, created_at, updated_at, labels)
    VALUES ('app', 1, 'pr', 'OPEN', 'PR 1', 'Body', 'regular', 5, 0, 'sha1', '${T0}', '${T0}', '[]')`).run();
  db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 1, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run();
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 1, 'sha1', 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T0}')`).run();
  db.exec("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')");
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  return db;
}

const CODE = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n";
const sessionsLeft = () => (existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions")) : []);

type Call = { args: string[]; input: string; sessionDirExisted: boolean };
/** Answers the k-th call with replies[k]; every result carries a session id. */
function fakeModel(replies: string[], calls: Call[] = []): { calls: Call[]; restore: () => void } {
  const restore = setRunner((async (_cmd, args, input) => {
    const bind = args.indexOf("--bind");
    calls.push({ args, input, sessionDirExisted: bind >= 0 && existsSync(args[bind + 1]!) });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return { code: 0, stdout: `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })}\n${JSON.stringify({ type: "result", session_id: "sess-1", result: text, num_turns: 2, usage: { input_tokens: 100, output_tokens: 10 } })}\n`, stderr: "" };
  }) as Runner);
  return { calls, restore };
}

const review = (over: Record<string, unknown> = {}) => JSON.stringify({
  ref: "app#1", verdict: "take", sure: true, reason: "ok", fixes: [], risks: [], summary: "Fine change.", why: "It is small.",
  public: { summary: "Looks good.", points: ["src/lib.rs:1 changes a to 2.", "Matches /reference/p0003.txt"] }, ...over,
});
const LONG = `First sentence stays. ${Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")}.`;
const opusDeps = (semantic?: SemanticDeps): OpusDeps => ({
  fetchDiff: async () => ({ ok: true, text: CODE }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "no compare" }),
  model: "opus", maxChars: 120_000, checkout: async () => checkout, semantic: semantic ?? { jev: async () => 0.1, haiku: async () => false },
});
const stored = (db: DatabaseSync) => db.prepare("SELECT summary, why, public_review FROM opus_reviews WHERE number = 1").get() as { summary: string | null; why: string | null; public_review: string | null };
const runs = (db: DatabaseSync) => db.prepare("SELECT summary FROM agent_runs WHERE prompt_id = 'review.opus' ORDER BY id").all() as { summary: string }[];

describe("review.opus lint", () => {
  test("a public point that mentions the reference gets one fix turn on the same session; the fixed reply is stored", async () => {
    const db = fresh();
    const m = fakeModel([review(), review({ public: { summary: "Looks good.", points: ["src/lib.rs:1 changes a to 2.", "The change keeps the old size."] } })]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, opusDeps());
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 2);
    const [first, fix] = m.calls as [Call, Call];
    assert.ok(!first.args.includes("--resume") && !first.args.includes("--no-session-persistence"));
    assert.ok(first.sessionDirExisted, "the session store is bound while the call runs");
    assert.deepEqual(fix.args.slice(fix.args.indexOf("--resume"), fix.args.indexOf("--resume") + 2), ["--resume", "sess-1"]);
    assert.deepEqual(fix.args.filter((a) => a !== "--resume" && a !== "sess-1"), first.args, "same arguments and mounts");
    assert.match(fix.input, /^Your reply has these problems:\n- public\.points\[1\]: mentions the reference folder/);
    assert.match(fix.input, /Send the complete reply again in the same format, fixing only these\.$/);
    assert.deepEqual(JSON.parse(stored(db).public_review!).points, ["src/lib.rs:1 changes a to 2.", "The change keeps the old size."]);
    assert.deepEqual(sessionsLeft(), [], "the session store is removed after the call");
    assert.deepEqual(runs(db).map((r) => r.summary), ["answered in 2 turns", "fix turn answered"]);
  });

  test("a fix reply that still leaks falls back to dropping the point, with no third call", async () => {
    const db = fresh();
    const m = fakeModel([review()]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, opusDeps());
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 2);
    assert.deepEqual(JSON.parse(stored(db).public_review!).points, ["src/lib.rs:1 changes a to 2."]);
  });

  test("an over-long summary gets a fix turn, not a second whole call; if it stays long, its first sentence is stored", async () => {
    const db = fresh();
    const m = fakeModel([review({ summary: LONG, public: null }), review({ summary: "Short and fine.", public: null })]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, opusDeps());
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1]!.input, /- summary: has 103 words; at most 80/);
    assert.equal(stored(db).summary, "Short and fine.");

    const db2 = fresh();
    const m2 = fakeModel([review({ summary: LONG, why: `${LONG}`, public: null })]);
    try {
      await runOpusReview(db2, { repo: "app" }, () => {}, opusDeps());
    } finally {
      m2.restore();
    }
    assert.equal(m2.calls.length, 2);
    assert.deepEqual([stored(db2).summary, stored(db2).why], ["First sentence stays.", "First sentence stays."]);
  });

  test("a reply that is not a valid review keeps the whole-call retry and gets no fix turn", async () => {
    const db = fresh();
    const m = fakeModel(["not json", review({ public: null })]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, opusDeps());
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 2);
    assert.ok(!m.calls[1]!.args.includes("--resume"));
  });

  test("a call without the sandbox has no session: the problem goes straight to the fallback", async () => {
    const db = fresh();
    const m = fakeModel([review()]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, { ...opusDeps(), checkout: async () => null });
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 1);
    assert.deepEqual(JSON.parse(stored(db).public_review!).points, ["src/lib.rs:1 changes a to 2."]);
  });

  test("text that the semantic check flags is sent back, and dropped when the fix does not clear it", async () => {
    const db = fresh();
    const bad = "The guide for the other product says to hold shift.";
    const m = fakeModel([review({ public: { summary: "Looks good.", points: ["src/lib.rs:1 changes a to 2.", bad] } })]);
    try {
      await runOpusReview(db, { repo: "app" }, () => {}, opusDeps({ jev: async (t) => (t === bad ? 0.95 : 0.05), haiku: async () => false }));
    } finally {
      m.restore();
    }
    assert.match(m.calls[1]!.input, /public\.points\[1\]: refers to outside documentation; state the behaviour in your own words/);
    assert.deepEqual(JSON.parse(stored(db).public_review!).points, ["src/lib.rs:1 changes a to 2."]);
  });
});

describe("semantic reference check", () => {
  const deps = (jev: number | null, haiku: boolean | null, usable = true) => {
    const calls = { jev: 0, haiku: 0 };
    const d: SemanticDeps = { async jev() { calls.jev++; return jev; }, async haiku() { calls.haiku++; return haiku; }, jevUsable: () => usable };
    return { d, calls };
  };
  test("Jev decides at 0.9 or more (yes) and below 0.3 (no)", async () => {
    const yes = deps(0.95, false), no = deps(0.1, true);
    assert.equal(await refersToDocumentation("t", yes.d), true);
    assert.equal(await refersToDocumentation("t", no.d), false);
    assert.deepEqual([yes.calls.haiku, no.calls.haiku], [0, 0]);
  });
  test("Jev unsure asks Haiku; Jev unavailable or without an answer asks only Haiku", async () => {
    const unsure = deps(0.5, true), off = deps(0.99, true, false), none = deps(null, false);
    assert.equal(await refersToDocumentation("t", unsure.d), true);
    assert.equal(await refersToDocumentation("t", off.d), true);
    assert.equal(await refersToDocumentation("t", none.d), false);
    assert.deepEqual([unsure.calls.haiku, off.calls.jev, off.calls.haiku, none.calls.haiku], [1, 0, 1, 1]);
  });
});

describe("verbatim reference check", () => {
  const ref = join(dir, "data", "reference", "app");
  test("12 or more consecutive words of the reference pages count, whatever the case and spacing", () => {
    const run = REFERENCE_TEXT.split(" ").slice(3, 15).join("  ").toUpperCase();
    assert.equal(quotesReference(`The text says: ${run}, and more.`, ref), true);
    assert.equal(quotesReference(REFERENCE_TEXT.split(" ").slice(3, 14).join(" "), ref), false, "11 words are not enough");
    assert.equal(quotesReference("Hold shift and drag a corner to resize it, then let go of the mouse.", ref), false);
  });
});

describe("conversation.turn lint", () => {
  test("a comment card that mentions the reference gets one fix turn; the fixed card is stored", async () => {
    const db = fresh();
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('other', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels) VALUES ('app', 2, 'issue', 'OPEN', 'Issue 2', 'Body', 'someone', '${T0}', '${T0}', '[]')`).run();
    await addOperatorMessage(db, "app", 2, "op", "Reply to the author?");
    const card = (text: string) => `Draft below.\n\`\`\`actions\n${JSON.stringify([{ kind: "comment", text }])}\n\`\`\``;
    const m = fakeModel([card("Per p0004.txt this differs."), card("This differs from the expected behaviour.")]);
    try {
      assert.equal(await answerPending(db, { checkout: async () => checkout, usageRun: "u", log: () => {}, semantic: { jev: async () => 0.05, haiku: async () => false } }), 1);
    } finally {
      m.restore();
    }
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1]!.input, /- cards\[0\]\.text: mentions the reference folder/);
    const cards = db.prepare("SELECT text FROM conversation_cards WHERE repo = 'app' AND number = 2").all() as { text: string }[];
    assert.deepEqual(cards.map((c) => c.text), ["This differs from the expected behaviour."]);
    assert.ok(turnsOf(db, "app", 2).length >= 2);
  });
});
