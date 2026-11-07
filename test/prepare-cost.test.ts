// What makes a decision due for another prepare: head pushes, discussion, reviews and the daily cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareIds } from "../src/decide/prepare.ts";
import { preparedEarlier, preparing } from "../src/decide/prepared.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { dependsOnCode } from "../src/conversations/cards.ts";
import { world } from "./world-db.ts";

const DAY = Date.parse("2026-11-04T12:00:00.000Z");
const opts = [{ key: "take", label: "Take" }, { key: "close", label: "Close" }];

function setup() {
  const w = world().repo().pr(7);
  const head = w.db.prepare("SELECT head_oid FROM items WHERE number = 7").get()!.head_oid as string;
  ask(w.db, [
    { id: "app#7:scope", kind: "scope", repo: "app", number: 7, question: "In scope?", options: opts },
    { id: `app#7:merge@${head}`, kind: "merge", repo: "app", number: 7, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "no", label: "No" }] },
  ]);
  w.db.prepare("UPDATE decisions SET prepared_at = '2026-11-04T10:00:00.000Z', prepared_head = ?, prepared_discussion = ''").run(head);
  return { w, head };
}
const comment = (w: ReturnType<typeof setup>["w"], id: string, at: string, o: { counted?: number; author?: string; body?: string } = {}) =>
  w.db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, counted) VALUES ('app', 7, ?, 'comment', ?, ?, ?, ?)").run(id, o.author ?? "maint", at, o.body ?? "b", o.counted ?? 1);

test("a scope decision stays prepared across a head push; a Merge? decision for an old head is not prepared", () => {
  const { w, head } = setup();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE items SET head_oid = 'newhead' WHERE number = 7").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE id LIKE '%merge@%'").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE items SET head_oid = ? WHERE number = 7").run(head);
  assert.deepEqual(prepareIds(w.db, undefined, DAY), [`app#7:merge@${head}`]);
});

test("a scope decision is prepared again after a counted person's comment, a review at the head or not after other posts", () => {
  const { w } = setup();
  comment(w, "bot", "2026-11-04T11:00:00.000Z", { counted: 0 });
  comment(w, "own", "2026-11-04T11:10:00.000Z", { body: "_AI-generated review of the PR_" });
  w.db.prepare("INSERT INTO conversation_turns (repo, number, kind, login, at, body, block) VALUES ('app', 7, 'operator', 'op', '2026-11-04T11:20:00.000Z', 'hi', 'hi')").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  comment(w, "c2", "2026-11-04T11:30:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  // A prepare that read c2 covers it.
  w.db.prepare("UPDATE decisions SET prepared_discussion = 'c2' WHERE id = 'app#7:scope'").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict) VALUES ('app', 7, (SELECT head_oid FROM items WHERE number = 7), '2026-11-04T11:40:00.000Z', 'full', 'take')").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("the 4th automatic prepare in a UTC day is held and the decision is not preparing; Re-prepare runs", () => {
  const { w } = setup();
  w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE kind = 'scope'").run();
  const rec = (at: string) => w.db.prepare("INSERT INTO decision_prepares (decision_id, at, manual) VALUES ('app#7:scope', ?, 0)").run(at);
  rec("2026-11-03T23:00:00.000Z"); rec("2026-11-04T01:00:00.000Z"); rec("2026-11-04T02:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  rec("2026-11-04T03:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  const today = new Date().toISOString().slice(0, 10);
  w.db.prepare("UPDATE decision_prepares SET at = ?").run(`${today}T00:00:01.000Z`);
  assert.equal(preparing(w.db, getDecision(w.db, "app#7:scope")!), false);
  // With earlier choices it shows them as prepared earlier.
  w.db.prepare("UPDATE decisions SET prepared_at = '2026-11-04T10:00:00.000Z', prepared_discussion = 'zzz' WHERE id = 'app#7:scope'").run();
  assert.equal(preparedEarlier(w.db, getDecision(w.db, "app#7:scope")!), true);
  w.db.prepare("UPDATE decisions SET prepare_requested_at = ?, prepared_at = NULL WHERE id = 'app#7:scope'").run("2026-11-04T11:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("cards that rest on the code are told apart from those that do not", () => {
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "comment" }, { kind: "label", label: "x" }], settle: null }, "Thanks"), true);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "fixup", instructions: "do", merge: false }], settle: null }, null), true);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "label", label: "x" }], settle: { kind: "backlog", decision: "d", stamp: "s" } }, null), false);
  assert.equal(dependsOnCode({ kind: "resolution", steps: [{ kind: "close", reason: "not_planned" as never, pr: true }], settle: null }, null), false);
});
