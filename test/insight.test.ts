// Classifier agreement, confidence bands and cost totals on a tiny fixture with known answers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { classifiersReport, cost, disagreements } from "../src/dash/api/insight.ts";
import { connect } from "../src/db.ts";
import type { Req } from "../src/dash/types.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "insight-test-"));
const db = connect(join(dir, "t.db"));
const rq = (q: string) => ({ query: new URLSearchParams(q) }) as unknown as Req;

before(() => {
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES ('photocraft', ?, ?, 'OPEN', ?)");
  const cls = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('photocraft', ?, ?, 'r1', '2026-11-01T00:00:00Z', ?, ?, ?)");
  // number, kind, jev label, top, jev flags, haiku label, haiku flags
  const rows: [number, string, string, number, string[], string, string[]][] = [
    [1, "pr", "bugfix", 0.995, ["security"], "bugfix", []],
    [2, "pr", "bugfix", 0.96, ["security"], "bugfix", ["security"]],
    [3, "pr", "bugfix", 0.92, [], "infra", []],
    [4, "issue", "missing feature", 0.85, [], "missing feature", []],
    [5, "issue", "missing feature", 0.6, [], "small extra", []],
    [6, "issue", "infra", 0.3, [], "infra", []],
  ];
  for (const [n, kind, jl, top, jf, hl, hf] of rows) {
    item.run(n, kind, `item ${n}`);
    cls.run(n, "jev", jl, JSON.stringify(jf), JSON.stringify({ top }));
    cls.run(n, "haiku", hl, JSON.stringify(hf), null);
  }
  const tok = db.prepare("INSERT INTO token_usage (run_id, agent, stage, model, repo, items, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at, ended_at, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  tok.run("r1", "a1", "classify", "haiku", "photocraft", 3, 100, 20, 10, 0, "2026-11-01T10:00:00Z", "2026-11-01T10:01:00Z", 0.25);
  tok.run("r1", "a2", "classify", "haiku", "photocraft", 3, 50, 10, 0, 0, "2026-11-01T10:01:00Z", "2026-11-01T10:03:00Z", null);
});
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("insight", () => {
  test("agreement, confusion, confidence bands and flags", () => {
    const r = classifiersReport(db, rq(""));
    assert.deepEqual([r.run, r.a, r.b], ["r1", "jev", "haiku"]);
    assert.deepEqual(r.overall, { n: 6, agree: 4 });
    assert.deepEqual(r.byKind, { pr: { n: 3, agree: 2 }, issue: { n: 3, agree: 2 } });
    assert.deepEqual(r.byLabel.find((l) => l.label === "bugfix"), { label: "bugfix", n: 3, agree: 2 });
    assert.equal(r.confusion[0]![5], 1);
    const b = Object.fromEntries(r.bands.map((x) => [x.band, [x.n, x.agree, x.cumN, x.cumAgree]]));
    assert.deepEqual(b["≥0.99"], [1, 1, 1, 1]);
    assert.deepEqual(b["0.90–0.95"], [1, 0, 3, 2]);
    assert.deepEqual(b["0.50–0.70"], [1, 0, 5, 3]);
    assert.deepEqual(b["<0.50"], [1, 1, 6, 4]);
    assert.deepEqual(r.flags.find((f) => f.flag === "security"), { flag: "security", n: 6, agree: 5, both: 1, onlyA: 1, onlyB: 0 });
  });

  test("disagreements filter by label and band", () => {
    const q = "run=r1&a=jev&b=haiku";
    assert.deepEqual(disagreements(db, rq(q)).rows.map((x) => x.number), [3, 5]);
    const hit = disagreements(db, rq(`${q}&band=${encodeURIComponent("0.90–0.95")}`));
    assert.equal(hit.total, 1);
    assert.deepEqual(hit.rows[0], { repo: "photocraft", number: 3, kind: "pr", title: "item 3", a: { label: "bugfix", prob: 0.92 }, b: { label: "infra", prob: null } });
    assert.equal(disagreements(db, rq(`${q}&label=small%20extra`)).total, 1);
  });

  test("cost totals, wall time and series", () => {
    const c = cost(db, rq("run=r1"));
    assert.deepEqual(c.total, { calls: 2, items: 6, input: 150, output: 30, cacheRead: 10, cacheWrite: 0, usd: 0.25, wallSeconds: 180 });
    assert.equal(c.stages.length, 1);
    assert.deepEqual(c.series, [{ bucket: "2026-11-01T10", tokens: 190, usd: 0.25 }]);
  });
});
