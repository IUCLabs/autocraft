// Decide stage: which items become scope decisions, their shape, the summary
// prompt, and re-runs. Model calls go to a fake runner.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { LABELS } from "../src/classify/rules.ts";
import { connect } from "../src/db.ts";
import { buildDecision } from "../src/decide/decision.ts";
import { loadSummaryItems, runDecide } from "../src/decide/index.ts";
import { settle } from "../src/classify/settled.ts";
import type { Candidate } from "../src/decide/select.ts";
import { validateAsk, type DecisionRow } from "../src/decisions.ts";
import { claudeArgs, renderClaude } from "../src/prompts/index.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });

type V = { label: string; top?: number; flags?: string[] };
type Spec = { repo: string; n: number; kind?: "pr" | "issue"; state?: string; draft?: boolean; jev: V; haiku?: V };

// Tracked repos come from the schema's seed list (photocraft, filmcraft, ...).
const SPECS: Spec[] = [
  { repo: "photocraft", n: 1, jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },          // asked: settled by Jev
  { repo: "photocraft", n: 2, kind: "pr", jev: { label: "small extra", top: 0.6 }, haiku: { label: "plugin candidate" } }, // asked: scope disagreement
  { repo: "photocraft", n: 3, jev: { label: "bugfix", top: 0.6 }, haiku: { label: "missing feature" } },          // not a scope disagreement
  { repo: "photocraft", n: 4, state: "CLOSED", jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },
  { repo: "photocraft", n: 5, kind: "pr", draft: true, jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },
  { repo: "photocraft", n: 6, jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },          // has an open decision
  { repo: "photocraft", n: 7, jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },          // stage: take
  { repo: "photocraft", n: 8, jev: { label: "missing feature", top: 0.6, flags: ["needs decision"] } },           // waiting for Haiku
  { repo: "photocraft", n: 9, jev: { label: "missing feature", top: 0.95 } },                                     // no flag
  { repo: "not-tracked", n: 1, jev: { label: "missing feature", top: 0.95, flags: ["needs decision"] } },
  { repo: "filmcraft", n: 10, jev: { label: "plugin candidate", top: 0.7 }, haiku: { label: "plugin candidate", flags: ["needs decision"] } }, // asked: settled by Haiku
];
const ASKED = ["photocraft#1", "photocraft#2", "filmcraft#10"];

function fixture(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "decide-test-")), "t.db"));
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, is_draft, labels, additions, deletions, changed_files, comments_count)
    VALUES (?, ?, ?, ?, ?, ?, 'someone', ?, ?, ?, '["enhancement"]', 10, 2, 1, 2)`);
  const cls = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, ?, 'r1', '2026-10-01T00:00:00Z', ?, ?, ?)`);
  for (const s of SPECS) {
    const created = `2026-01-${String(s.n).padStart(2, "0")}T00:00:00Z`;
    item.run(s.repo, s.n, s.kind ?? "issue", s.state ?? "OPEN", `Item ${s.n}`, `Body of ${s.repo}#${s.n}`, created, created, s.draft ? 1 : 0);
    cls.run(s.repo, s.n, "jev", s.jev.label, JSON.stringify(s.jev.flags ?? []), JSON.stringify({ top: s.jev.top }));
    if (s.haiku) cls.run(s.repo, s.n, "haiku", s.haiku.label, JSON.stringify(s.haiku.flags ?? []), null);
  }
  db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('x', 'duplicate', 'photocraft', 6, 'Dup?', '[]', '2026-10-01')`).run();
  db.prepare(`INSERT INTO stages (repo, number, stage, at) VALUES ('photocraft', 7, 'take', '2026-10-01')`).run();
  const com = db.prepare(`INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 1, ?, 'comment', ?, ?, ?)`);
  com.run("c1", "ci-helper[bot]", "2026-01-02", "Build passed");
  com.run("c2", "user-b", "2026-01-03", "I need this too");
  return db;
}

type Call = { cmd: string; args: string[]; input: string };

/** Answers each asked ref with a summary, except refs in `silent`. */
function fake(calls: Call[], silent: string[] = []): Runner {
  return async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!).filter((r) => !silent.includes(r));
    const reply = refs.map((ref) => ({ ref, summary: `It asks for something about ${ref}. Whether the reference application has it is unclear.` }));
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(reply), usage: { input_tokens: 100, output_tokens: 20 } }), stderr: "" };
  };
}

const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM decisions WHERE kind = 'scope' ORDER BY id").all() as DecisionRow[];
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const quiet = () => {};

describe("decide", () => {
  test("dry run counts the right items and writes nothing", async () => {
    const db = fixture();
    const calls: Call[] = [];
    const restore = setRunner(fake(calls));
    try {
      const r = await runDecide(db, { dryRun: true }, quiet);
      assert.deepEqual(r.byRepo, {
        photocraft: { candidates: 2, needsDecision: 1, scopeDisagreement: 1, asked: 0, noSummary: 0 },
        filmcraft: { candidates: 1, needsDecision: 1, scopeDisagreement: 0, asked: 0, noSummary: 0 },
      });
    } finally { restore(); }
    assert.equal(calls.length, 0);
    assert.equal(rows(db).length, 0);
    assert.equal(count(db, "stages"), 1);
    assert.equal(count(db, "token_usage"), 0);
  });

  test("asks one valid decision per item through the registered prompt; a re-run asks nothing", async () => {
    const db = fixture();
    const calls: Call[] = [];
    const restore = setRunner(fake(calls));
    try {
      const r = await runDecide(db, {}, quiet);
      assert.equal(r.asked, 3);
      // One call per repo batch, each exactly what the registry renders.
      const want = [["photocraft#2", "photocraft#1"], ["filmcraft#10"]] /* pull requests before issues */.map((refs) => ({
        cmd: "claude", args: claudeArgs("decide.summary", "sonnet"),
        input: renderClaude("decide.summary", loadSummaryItems(db, refs.map((x) => ({ repo: x.split("#")[0]!, number: Number(x.split("#")[1]) })))),
      }));
      assert.deepEqual(calls.toSorted((a, b) => a.input.localeCompare(b.input)), want.toSorted((a, b) => a.input.localeCompare(b.input)));
      assert.ok(calls.some((c) => c.input.includes("I need this too")) && !calls.some((c) => c.input.includes("Build passed")), "non-bot comments only");

      const ds = rows(db);
      assert.deepEqual(ds.map((d) => `${d.repo}#${d.number}`).sort(), [...ASKED].sort());
      for (const d of ds) {
        assert.equal(d.summary_by, "sonnet");
        assert.match(d.summary!, /reference application/);
        assert.ok(JSON.parse(d.facts!).length <= 5);
      }
      const pr = ds.find((d) => d.number === 2)!;
      assert.equal(pr.recommended, "plugin");
      assert.ok(JSON.parse(pr.facts!)[0].includes("+10 −2 in 1 file"));
      const stages = db.prepare("SELECT repo || '#' || number AS ref FROM stages WHERE stage = 'needs-decision' ORDER BY ref").all() as { ref: string }[];
      assert.deepEqual(stages.map((s) => s.ref), [...ASKED].sort());
      const used = db.prepare("SELECT sum(items) AS items, sum(input_tokens) AS input FROM token_usage WHERE stage = 'decide'").get() as { items: number; input: number };
      assert.deepEqual({ ...used }, { items: 3, input: 200 });

      calls.length = 0;
      const again = await runDecide(db, {}, quiet);
      assert.equal(again.asked, 0);
      assert.equal(calls.length, 0);
      assert.equal(rows(db).length, 3);
    } finally { restore(); }
  });

  test("an item without a valid summary is retried once, skipped, and asked by the next run", async () => {
    const db = fixture();
    const calls: Call[] = [];
    let restore = setRunner(fake(calls, ["photocraft#2"]));
    try {
      const r = await runDecide(db, { repos: ["photocraft"] }, quiet);
      assert.deepEqual({ asked: r.asked, noSummary: r.noSummary, calls: calls.length }, { asked: 1, noSummary: 1, calls: 2 });
      restore();
      restore = setRunner(fake(calls));
      const next = await runDecide(db, { repos: ["photocraft"], limit: 5 }, quiet);
      assert.equal(next.asked, 1);
      assert.deepEqual(rows(db).map((d) => d.number), [1, 2]);
    } finally { restore(); }
  });

  test("every question shape passes the CLI's validation", () => {
    const db = fixture();
    const scope = ["missing feature", "small extra", "plugin candidate"];
    const cands: Candidate[] = [
      ...LABELS.map((label): Candidate => ({ repo: "photocraft", number: 1, reason: "needs-decision", settled: settle({ label, top: 0.95, flags: ["needs decision"] }, null) })),
      ...scope.flatMap((a) => scope.filter((b) => b !== a).map((b): Candidate => ({ repo: "photocraft", number: 2, reason: "scope-disagreement", settled: settle({ label: a, top: 0.5, flags: [] }, { label: b, flags: [] }) }))),
    ];
    for (const c of cands) assert.doesNotThrow(() => validateAsk(buildDecision(db, c)), `${c.settled.jevLabel}/${c.settled.haikuLabel}`);
  });

  test("refuses repos that are not tracked", async () => {
    await assert.rejects(runDecide(fixture(), { repos: ["not-tracked"], dryRun: true }, quiet), /not tracked/);
  });
});
