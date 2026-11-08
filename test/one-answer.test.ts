// One answer per question: a running card locks its decision, a writing card is refused against an answered, unapplied decision,
// a disputed answer is not read by the pipeline, and undo ends once a GitHub write exists for the answer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { clearDispute, openDispute } from "../src/answers/hold.ts";
import { sweepStaleAnswers } from "../src/answers/sweep.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
import { doCard } from "../src/conversations/act.ts";
import { connect } from "../src/db.ts";
import { actionable, ask, getDecision } from "../src/decisions.ts";
import { applyAnswer, canUndo } from "../src/dash/api/decisions.ts";

mkdirSync(SCRATCH, { recursive: true });
const T0 = "2026-01-01T00:00:00Z";
const OPTIONS = [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }];
const querier = { query: async () => { throw new Error("GitHub was called"); }, spent: 0, remaining: null } as never;

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "one-answer-")), "t.db"));
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, labels) VALUES ('app', 1, 'issue', 'OPEN', 'An issue', 'Body', 'someone', '${T0}', '${T0}', '[]')`).run();
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('op2', 'operator')").run();
  ask(db, [{ id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: OPTIONS }]);
  return db;
}

const card = (db: DatabaseSync, params: unknown): number =>
  Number(db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', 1, 'resolution', ?, NULL, 'x')").run(JSON.stringify(params)).lastInsertRowid);

describe("one answer per question", () => {
  test("a card that settles the decision locks it while it runs, and a failed card releases it", async () => {
    const db = fresh();
    const d = getDecision(db, "app#1:scope")!;
    const settle = { kind: "answer", decision: d.id, option: "take", stamp: decisionStamp(db, d) };
    let release!: () => void;
    const gate = new Promise<boolean>((r) => { release = () => r(true); });
    const running = doCard(db, card(db, { kind: "resolution", steps: [], settle }), "op", { querier, canWrite: () => gate });
    assert.throws(() => applyAnswer(db, getDecision(db, d.id)!, "op2", { answer: "close" }, "dashboard"), /op is applying their answer/);
    const second = doCard(db, card(db, { kind: "resolution", steps: [], settle }), "op2", { querier });
    await assert.rejects(second, /op is applying their answer/);
    release();
    assert.equal((await running).card.state, "done");
    assert.equal(getDecision(db, d.id)!.answer, "take");

    const db2 = fresh();
    const d2 = getDecision(db2, "app#1:scope")!;
    const failing = await doCard(db2, card(db2, { kind: "resolution", steps: [], settle: { ...settle, stamp: decisionStamp(db2, d2) } }), "op", { querier, canWrite: async () => false });
    assert.equal(failing.card.state, "failed");
    assert.equal(getDecision(db2, d2.id)!.exec_state, null, "the lock is released");
    applyAnswer(db2, getDecision(db2, d2.id)!, "op2", { answer: "close" }, "dashboard");
  });

  test("a card that closes the item is refused while the item has an answered, unapplied decision", async () => {
    const db = fresh();
    applyAnswer(db, getDecision(db, "app#1:scope")!, "op", { answer: "take" }, "dashboard");
    const id = card(db, { kind: "close", reason: "not_planned", pr: false });
    await assert.rejects(doCard(db, id, "op2", { querier }), /op already answered/);
    assert.equal((db.prepare("SELECT state FROM conversation_cards WHERE id = ?").get(id) as { state: string }).state, "proposed");
  });

  test("a disputed answer is not actionable until kept, and undo ends once a comment exists", () => {
    const db = fresh();
    applyAnswer(db, getDecision(db, "app#1:scope")!, "op", { answer: "close" }, "dashboard");
    assert.equal(actionable(db).length, 1);
    assert.equal(openDispute(db, "app#1:scope", "op", "mine", T0), false, "the answerer does not dispute their own answer");
    assert.equal(openDispute(db, "app#1:scope", "op2", "wrong item", T0), true);
    assert.equal(actionable(db).length, 0);
    assert.equal(canUndo(db, getDecision(db, "app#1:scope")!), true);
    clearDispute(db, "app#1:scope");
    assert.equal(actionable(db).length, 1);
    db.prepare("INSERT INTO actions (decision_id, repo, number, kind, state, comment_url, created_at) VALUES ('app#1:scope', 'app', 1, 'comment-close', 'failed', 'https://x.test/c', ?)").run(T0);
    assert.equal(canUndo(db, getDecision(db, "app#1:scope")!), false);
  });

  test("an answer for an item that closed meanwhile is marked applied with a note", () => {
    const db = fresh();
    applyAnswer(db, getDecision(db, "app#1:scope")!, "op", { answer: "close" }, "dashboard");
    db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 1").run();
    assert.equal(sweepStaleAnswers(db, T0, "app"), 1);
    const d = getDecision(db, "app#1:scope")!;
    assert.deepEqual({ applied: !!d.applied_at, note: d.answer_note }, { applied: true, note: "not applied: the item is closed" });
  });
});
