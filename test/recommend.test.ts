// Opus recommendation for scope decisions: the question shape carries none, a reply
// is validated against the decision's options, open decisions are backfilled, and
// the old label-based recommendations are dropped. Model calls go to a fake runner.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { setRunner, setWorkspace } from "../src/classify/run.ts";
import { LABELS } from "../src/classify/rules.ts";
import { settle } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import { buildDecision, shapeOf } from "../src/decide/decision.ts";
import { runDecide } from "../src/decide/index.ts";
import { backfillIds, recommend } from "../src/decide/recommend.ts";
import type { Candidate } from "../src/decide/select.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

const OPTIONS = JSON.stringify([{ key: "take", label: "Wanted in core", hint: "h" }, { key: "plugin", label: "Plug-in candidate", hint: "h" }, { key: "close", label: "Out of scope", hint: "h" }]);
const quiet = () => {};
const noCheckout = async () => null;

function fixture(): { db: DatabaseSync; path: string } {
  const path = join(mkdtempSync(join(SCRATCH, "recommend-test-")), "t.db");
  const db = connect(path);
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
  useTestAccount(db);
  for (const n of [1, 2, 3, 4]) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels) VALUES ('photocraft', ?, 'issue', 'OPEN', ?, 'Body', 'someone', '2026-01-01', '2026-01-01', '[]')`).run(n, `Item ${n}`);
  }
  return { db, path };
}

function decision(db: DatabaseSync, n: number, o: { answer?: string; recommended?: string; by?: string } = {}): string {
  const id = `photocraft#${n}:scope`;
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, summary, answer, recommended, recommended_by) VALUES (?, 'scope', 'photocraft', ?, 'Wanted?', ?, ?, 'A summary of the item.', ?, ?, ?)`)
    .run(id, n, OPTIONS, `2026-10-0${n}`, o.answer ?? null, o.recommended ?? null, o.by ?? null);
  return id;
}

const row = (db: DatabaseSync, id: string) => db.prepare("SELECT recommended, recommended_reason AS reason, recommended_by AS by FROM decisions WHERE id = ?").get(id) as { recommended: string | null; reason: string | null; by: string | null };

/** Answers every recommendation call with `reply` and records the refs asked. */
function fake(reply: unknown, asked: string[] = []) {
  return setRunner(async (_cmd, _args, input) => {
    asked.push(/"ref": "([^"]+)"/.exec(input.split("<decision>")[1] ?? "")?.[1] ?? "?");
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(reply), usage: { input_tokens: 50, output_tokens: 10 } }), stderr: "" };
  });
}

describe("scope recommendation", () => {
  test("the question shape recommends nothing", () => {
    const { db } = fixture();
    const scope = ["missing feature", "small extra", "plugin candidate"];
    const cands: Candidate[] = [
      ...LABELS.map((label): Candidate => ({ repo: "photocraft", number: 1, reason: "needs-decision", settled: settle({ label, top: 0.95, flags: ["needs decision"] }, null) })),
      ...scope.flatMap((a) => scope.filter((b) => b !== a).map((b): Candidate => ({ repo: "photocraft", number: 2, reason: "scope-disagreement", settled: settle({ label: a, top: 0.5, flags: [] }, { label: b, flags: [] }) }))),
    ];
    for (const c of cands) {
      assert.ok(!("recommended" in shapeOf(c)));
      assert.equal(buildDecision(db, c).recommended, null);
    }
  });

  test("a valid reply stores key, reason and model; an invalid key stores no recommendation", async () => {
    const { db } = fixture();
    const a = decision(db, 1), b = decision(db, 2);
    let restore = fake({ recommended: "plugin", reason: "It makes a paid service the default." });
    try {
      assert.equal(await runDecide(db, { checkout: noCheckout, limit: 1 }, quiet).then((r) => r.recommended), 1);
    } finally { restore(); }
    assert.deepEqual({ ...row(db, a) }, { recommended: "plugin", reason: "It makes a paid service the default.", by: "opus" });
    assert.deepEqual({ ...row(db, b) }, { recommended: null, reason: null, by: null }, "limit 1 covers one call");
    const usage = db.prepare("SELECT model, items, input_tokens AS input FROM token_usage WHERE agent LIKE 'recommend-%'").all();
    assert.deepEqual(usage.map((u) => ({ ...u })), [{ model: "opus", items: 1, input: 50 }]);

    restore = fake({ recommended: "backlog", reason: "Not an option here." });
    try { await runDecide(db, { checkout: noCheckout, limit: 5 }, quiet); } finally { restore(); }
    assert.deepEqual({ ...row(db, b) }, { recommended: null, reason: "Not an option here.", by: "opus" });
    assert.equal(row(db, a).recommended, "plugin", "a decision with a model recommendation is not asked again");
  });

  test("backfill fills open pilot decisions only", async () => {
    const { db } = fixture();
    const open = decision(db, 1), answered = decision(db, 2, { answer: "close" }), outside = decision(db, 3), done = decision(db, 4, { recommended: "close", by: "opus" });
    db.prepare("INSERT INTO settings (key, value) VALUES ('pilot_items', ?)").run(JSON.stringify(["photocraft#1", "photocraft#2", "photocraft#4"]));
    const asked: string[] = [];
    const restore = fake({ recommended: "close", reason: "Out of scope." }, asked);
    try { await runDecide(db, { checkout: noCheckout }, quiet); } finally { restore(); }
    assert.deepEqual(asked, ["photocraft#1"]);
    assert.equal(row(db, open).recommended, "close");
    assert.equal(row(db, answered).by, null);
    assert.equal(row(db, outside).by, null);
    assert.equal(row(db, done).by, "opus");
  });

  test("a decision whose recommendation keeps failing waits an hour between tries and stops after three", () => {
    const { db } = fixture();
    const id = decision(db, 1);
    const fail = (at: string) => db.prepare("UPDATE decisions SET recommend_failures = COALESCE(recommend_failures, 0) + 1, recommend_failed_at = ? WHERE id = ?").run(at, id);
    const t = Date.parse("2026-11-03T12:00:00Z");
    assert.deepEqual(backfillIds(db, 5, t), [id]);
    fail("2026-11-03T11:30:00.000Z");
    assert.deepEqual(backfillIds(db, 5, t), [], "within the hour");
    assert.deepEqual(backfillIds(db, 5, t + 31 * 60_000), [id], "after the hour");
    fail("2026-11-03T11:30:00.000Z"); fail("2026-11-03T11:30:00.000Z");
    assert.deepEqual(backfillIds(db, 5, t + 2 * 3600_000), [], "three failures");
  });

  test("recommendations without a model are cleared from open decisions at connect", () => {
    const { db, path } = fixture();
    const old = decision(db, 1, { recommended: "take" }), modelled = decision(db, 2, { recommended: "close", by: "opus" }), answered = decision(db, 3, { answer: "take", recommended: "take" });
    db.close();
    const again = connect(path);
    assert.equal(row(again, old).recommended, null);
    assert.equal(row(again, modelled).recommended, "close");
    assert.equal(row(again, answered).recommended, "take");
  });
});

describe("the workspace", () => {
  test("the recommendation call mounts every repository read-only at /repos and describes it in the prompt", async () => {
    const { db } = fixture();
    const id = decision(db, 1);
    const cfg = join(mkdtempSync(join(SCRATCH, "shared-cfg-")), "x");
    const box = useTestAccount(db);
    mkdirSync(box.configDir + "t", { recursive: true });
    writeFileSync(join(box.configDir + "t", ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 6 * 3600_000 } }));
    process.env.AUTOCRAFT_CLAUDE_BIN = "/usr/bin/true";
    const calls: { cmd: string; args: string[]; input: string }[] = [];
    const restore = setRunner(async (cmd, args, input) => {
      calls.push({ cmd, args, input });
      return { code: 0, stdout: JSON.stringify({ type: "result", result: '{"recommended": "plugin", "reason": "r"}', usage: {} }), stderr: "" };
    });
    const restoreWs = setWorkspace(async () => [{ name: "craft-i18n", dir: "/h/i18n" }, { name: "craft-libs", dir: "/h/libs" }]);
    try {
      const n = await recommend(db, [id], { checkout: async () => cfg, usageRun: "t", log: quiet });
      assert.equal(n, 1);
      const a = calls[0]!.args.join(" ");
      assert.match(a, /--ro-bind \/h\/i18n \/repos\/craft-i18n --ro-bind \/h\/libs \/repos\/craft-libs/);
      assert.match(a, /--ro-bind \S+agents-[0-9a-f]+\.json \/agents\.json/);
      assert.match(a, /--add-dir \/repo --add-dir \/repos --agents \/agents\.json/);
      assert.match(calls[0]!.input, /checkouts of the default branch of every tracked repository are at \/repos\/<name>/);
      assert.match(calls[0]!.input, /use the Agent tool with subagent_type workspace-search/);
    } finally {
      restoreWs();
      restore();
      delete process.env.AUTOCRAFT_CLAUDE_BIN;
    }
  });
});
