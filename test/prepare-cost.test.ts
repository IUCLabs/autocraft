// What makes a decision due for another prepare: head pushes, discussion, and the daily cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareIds } from "../src/decide/prepare.ts";
import { ask } from "../src/decisions.ts";
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
  w.db.prepare("UPDATE decisions SET prepared_at = '2026-11-04T10:00:00.000Z', prepared_head = ?").run(head);
  w.db.prepare("UPDATE decisions SET prepared_head = 'old' WHERE kind = 'scope'").run();
  return { w, head };
}

test("a scope decision stays prepared across a head push; a Merge? decision for an old head is not prepared", () => {
  const { w, head } = setup();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE items SET head_oid = 'newhead' WHERE number = 7").run();
  // The scope decision is untouched; the merge@old decision is about to be withdrawn, so it is not prepared either.
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE id LIKE '%merge@%'").run();
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  // A merge decision at the current head is prepared again after a push.
  w.db.prepare("UPDATE items SET head_oid = ? WHERE number = 7").run(head);
  assert.deepEqual(prepareIds(w.db, undefined, DAY), [`app#7:merge@${head}`]);
});

test("a scope decision is prepared again after a counted comment, not after a bot's", () => {
  const { w } = setup();
  const add = (id: string, at: string, counted: number) => w.db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, counted) VALUES ('app', 7, ?, 'comment', 'x', ?, 'b', ?)").run(id, at, counted);
  add("c1", "2026-11-04T11:00:00.000Z", 0);
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  add("c2", "2026-11-04T11:30:00.000Z", 1);
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});

test("the 4th automatic prepare in a UTC day is held; Re-prepare runs", () => {
  const { w } = setup();
  w.db.prepare("UPDATE decisions SET prepared_at = NULL WHERE kind = 'scope'").run();
  const rec = (at: string, manual = 0) => w.db.prepare("INSERT INTO decision_prepares (decision_id, at, manual) VALUES ('app#7:scope', ?, ?)").run(at, manual);
  rec("2026-11-03T23:00:00.000Z"); rec("2026-11-04T01:00:00.000Z"); rec("2026-11-04T02:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
  rec("2026-11-04T03:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), []);
  w.db.prepare("UPDATE decisions SET prepare_requested_at = ? WHERE id = 'app#7:scope'").run("2026-11-04T11:00:00.000Z");
  assert.deepEqual(prepareIds(w.db, undefined, DAY), ["app#7:scope"]);
});
