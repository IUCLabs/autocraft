// Issues that need a person are asked or listed, and an issue waiting on a PR names it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { decideItem } from "../src/core/decide-item.ts";
import { issuesWithOpenPr } from "../src/fixissue/candidates.ts";
import { itemFacts } from "./world.ts";

const needsDecision = { classification: { flags: ["needs decision"] }, labels: { existing: ["bugfix", "needs decision"] } };
const attempt = (state: string) => ({ state, textChanged: false, headDone: false, baseDone: true });

test("a labelled issue with the needs-decision flag and no scope decision is asked", () => {
  const p = decideItem(itemFacts({ ...needsDecision, labels: { existing: ["bugfix", "needs decision"], labeledNote: "added: bugfix" } }));
  assert.equal(p.state, "scope-due");
  assert.deepEqual(p.actions.map((a) => a.kind), ["decide"]);
});

test("a draft waits for its scope question and says so", () => {
  const p = decideItem(itemFacts({ ...needsDecision, draft: true }));
  assert.equal(p.wait, "the scope question to be asked");
});

test("a skipped or failed fix attempt waits on a person", () => {
  for (const s of ["skipped", "failed"]) {
    const p = decideItem(itemFacts({ fix: { impact: "P2", attempt: attempt(s) } }));
    assert.equal(p.wait, `a person to retry the ${s} fix`);
    assert.equal(p.waitKind, "person");
  }
});

test("a skipped attempt whose text changed is tried again, not waited on", () => {
  const p = decideItem(itemFacts({ fix: { impact: "P2", attempt: { ...attempt("skipped"), textChanged: true } } }));
  assert.deepEqual(p.actions.map((a) => a.kind), ["fixissue"]);
  assert.equal(p.wait, null);
});

test("an issue whose fix PR is open waits on that PR (system)", () => {
  const p = decideItem(itemFacts({ fix: { impact: "P2", openPr: 84 } }));
  assert.equal(p.wait, "open PR #84");
  assert.equal(p.waitKind, "system");
});

test("only closing references count as an open PR for an issue", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE items (repo TEXT, number INTEGER, kind TEXT, state TEXT, title TEXT, body TEXT, closing_issues TEXT)");
  const add = db.prepare("INSERT INTO items VALUES ('app', ?, 'pr', 'OPEN', ?, ?, ?)");
  add.run(10, "Rework #1", "See also #2. Fixes #3", null);
  add.run(11, "Other", "Resolves: #4", "[5]");
  const m = issuesWithOpenPr(db, "app");
  assert.deepEqual([...m].sort((a, b) => a[0] - b[0]), [[3, 10], [4, 11], [5, 11]]);
});

test("stopped fixes are one group row per repo, listed 25 per page with priority first", async () => {
  const { connect } = await import("../src/db.ts");
  const { needs, fixes, FIXES_PAGE } = await import("../src/dash/api/needs.ts");
  const { fixStoppedWait } = await import("../src/core/decide-item.ts");
  const db = connect(":memory:");
  db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app')").run();
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public') ON CONFLICT (name) DO UPDATE SET visibility = 'public'").run();
  const t = new Date().toISOString();
  for (let n = 1; n <= 30; n++) {
    db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES ('app', ?, 'issue', 'OPEN', ?)").run(n, `Issue ${n}`);
    db.prepare("INSERT INTO item_plans (repo, number, kind, head, state, item_state, actions, wait, reasons, note, view, planned_at) VALUES ('app', ?, 'issue', NULL, 'x', 'classified', '[]', ?, '[]', NULL, '{}', ?)").run(n, fixStoppedWait("skipped"), t);
  }
  db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('app', 7, 'h', 'P1', 90, 'm', ?)").run(t);
  const req = (query: Record<string, string> = {}) => ({
    method: "GET", path: "", params: { repo: "app" }, query: new URLSearchParams(query), form: new URLSearchParams(),
    user: { login: "u", role: "operator", canWrite: async () => true, canRead: async () => true }, csrf: "", nonce: "",
  }) as never;
  const page = await needs(db, req());
  assert.deepEqual(page.stopped.map((s) => [s.id, s.count]), [["fixes:app", 30]]);
  assert.equal(page.counts.stopped, 1);
  const p1 = await fixes(db, req());
  assert.equal(p1.rows.length, FIXES_PAGE);
  assert.equal(p1.rows[0]!.number, 7);
  const p2 = await fixes(db, req({ cursor: p1.nextCursor! }));
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.nextCursor, null);
});
