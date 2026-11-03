import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jevFailure, jevOutage, markJevUnavailable } from "../src/agents/jev.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { settledOf } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import { classifyNew } from "../src/runner/classify.ts";
import type { StepContext } from "../src/runner/steps.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

const setup = () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "jevfb-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1); UPDATE tracked_repos SET pipeline = 1");
  useTestAccount(db);
  const ins = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('photocraft', ?, 'issue', 'OPEN', ?, 'b', 'a', '2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z')`);
  ins.run(1, "Crash"); ins.run(2, "Typo");
  db.exec("INSERT INTO settings (key, value) VALUES ('classify_run', 'r1')");
  return db;
};
const ctx = (db: ReturnType<typeof connect>): StepContext => ({
  db, job: { id: 1, requestedBy: "t", startedAt: "" }, params: { limit: 50 }, progress() {}, log() {}, usageRun() {}, handled() {}, acted() {}, cancelled: () => false,
}) as unknown as StepContext;

const runner = (calls: string[], jev: () => { code: number; stdout: string; stderr: string }): Runner => async (cmd, _a, input) => {
  calls.push(cmd);
  if (cmd === "jev") return jev();
  const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
  const result = JSON.stringify(refs.map((ref) => ({ ref, type_label: "bugfix", security: false, needs_decision: false, reason: "r" })));
  return { code: 0, stdout: JSON.stringify({ type: "result", result, usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" };
};
const noCredit = () => ({ code: 1, stdout: "", stderr: "jev: API error status=402 request_id=r1: insufficient credit" });

test("when Jev is out of credit Haiku settles the due items, and they stay settled once Jev returns", async () => {
  const db = setup();
  const calls: string[] = [];
  let restore = setRunner(runner(calls, noCredit));
  try {
    const msg = await classifyNew(ctx(db));
    assert.match(msg, /Jev unavailable: Haiku classified 2/);
    assert.equal(jevOutage(db)?.reason, "out of credit");
    const s = settledOf(db, "photocraft", 1, "r1");
    assert.deepEqual([s.status, s.source, s.label], ["settled", "haiku", "bugfix"]);
    restore();
    // Jev works again and the backoff has passed: the settled items are not sent to Jev.
    db.prepare("DELETE FROM settings WHERE key = 'jev_unavailable'").run();
    const again: string[] = [];
    restore = setRunner(runner(again, () => ({ code: 1, stdout: "", stderr: "unexpected" })));
    await classifyNew(ctx(db));
    assert.equal(again.filter((c) => c === "jev").length, 0);
  } finally { restore(); }
});

test("a pass during the backoff does not call Jev; the first pass after it does", async () => {
  const db = setup();
  markJevUnavailable(db, "account", "out of credit");
  const calls: string[] = [];
  const restore = setRunner(runner(calls, noCredit));
  try {
    await classifyNew(ctx(db));
    assert.equal(calls.filter((c) => c === "jev").length, 0);
    const old = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'jev_unavailable'").get() as { value: string }).value);
    old.at = new Date(Date.now() - 61 * 60_000).toISOString();
    db.prepare("UPDATE settings SET value = ? WHERE key = 'jev_unavailable'").run(JSON.stringify(old));
    db.exec("DELETE FROM classifications");
    await classifyNew(ctx(db));
    assert.ok(calls.filter((c) => c === "jev").length >= 1);
    assert.equal(jevOutage(db)?.since, old.since);
  } finally { restore(); }
});

test("only account failures and a missing command count as Jev unavailable", () => {
  assert.equal(jevFailure({ code: 1, stderr: "jev: API error status=401 request_id=x: unauthorized" })?.reason, "key rejected");
  assert.equal(jevFailure({ code: 1, stderr: "jev: no API key" })?.reason, "key rejected");
  assert.equal(jevFailure({ code: -1, stderr: "Error: spawn jev ENOENT" })?.kind, "missing");
  assert.equal(jevFailure({ code: 1, stderr: "jev: API error status=503 request_id=x: overloaded" }), null);
  assert.equal(jevFailure({ code: null, stderr: "" }), null);
  assert.equal(jevFailure({ code: 1, stderr: "jev: API error status=429 request_id=x: monthly quota reached" }), null);
  assert.equal(jevFailure({ code: 1, stderr: "jev: API error status=503 request_id=x: insufficient capacity" }), null);
  assert.equal(jevFailure({ code: 127, stderr: "/usr/bin/jev: line 2: uv: No such file or directory" })?.kind, "missing");
});

test("a Haiku row that is only a second opinion or an evaluation does not settle an item", () => {
  const db = setup();
  db.exec("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('photocraft', 1, 'haiku', 'eval', '2026-10-01', 'bugfix', '[]')");
  assert.equal(settledOf(db, "photocraft", 1, "eval").status, "unclassified");
  db.exec("UPDATE classifications SET input_hash = 'h'");
  assert.equal(settledOf(db, "photocraft", 1, "eval").status, "settled");
});
