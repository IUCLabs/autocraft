// Area lists and assignment: list versions re-point items, and the settle rule (Jev at 0.9 or more settles,
// else Haiku, Haiku alone without Jev, "none of these" is stored). Model calls go to a fake runner.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assignAreas } from "../src/areas/assign.ts";
import { AreaError, currentList, editAreas, itemAreaOf, unassignedCount } from "../src/areas/store.ts";
import { markJevUnavailable } from "../src/agents/jev.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

const setup = (n = 6) => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "areas-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1); UPDATE tracked_repos SET pipeline = 1");
  useTestAccount(db);
  const ins = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('photocraft', ?, 'issue', 'OPEN', ?, 'b', 'a', '2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z')`);
  for (let i = 1; i <= n; i++) ins.run(i, `Item ${i}`);
  return db;
};

test("a saved version re-points renamed and merged areas, unassigns removed ones and keeps the rest", () => {
  const db = setup(5);
  for (const [name, d] of [["Canvas", "drawing"], ["Export", "saving"], ["Text", "type"], ["Layers", "stacking"]]) editAreas(db, "photocraft", { op: "add", name: name!, description: d! }, "op");
  const v = currentList(db, "photocraft")!.version;
  const put = db.prepare("INSERT INTO item_areas (repo, number, area, source, confidence, list_version, at) VALUES ('photocraft', ?, ?, 'jev', 0.95, ?, 't')");
  put.run(1, "Canvas", v); put.run(2, "Export", v); put.run(3, "Text", v); put.run(4, "Layers", v); put.run(5, null, v);

  editAreas(db, "photocraft", { op: "rename", from: "Canvas", to: "Drawing" }, "op");
  editAreas(db, "photocraft", { op: "merge", from: "Export", into: "Drawing" }, "op");
  const last = editAreas(db, "photocraft", { op: "remove", name: "Text" }, "op");

  const area = (n: number) => itemAreaOf(db, "photocraft", n)!;
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => area(n).area), ["Drawing", "Drawing", null, "Layers", null]);
  assert.equal(last, v + 3);
  assert.deepEqual(currentList(db, "photocraft")!.areas.map((a) => a.name), ["Drawing", "Layers"]);
  // Items that kept an area are on the current version; the unassigned ones stay on the version they were asked against.
  assert.deepEqual([1, 2, 4].map((n) => area(n).listVersion), [last, last, last]);
  assert.deepEqual([3, 5].map((n) => area(n).listVersion), [last - 1, v]);
  assert.equal(unassignedCount(db, "photocraft"), 2);

  assert.throws(() => editAreas(db, "photocraft", { op: "add", name: "none of these", description: "x" }, "op"), AreaError);
  assert.throws(() => editAreas(db, "photocraft", { op: "rename", from: "Layers", to: "drawing" }, "op"), AreaError);
});

// Jev answers per item number: [choice, top probability]; Haiku answers per item number.
const fake = (jev: Record<number, [string, number]>, haiku: Record<number, string>, calls: string[], jevDown = false): Runner => async (cmd, _a, input) => {
  calls.push(cmd);
  if (cmd === "jev") {
    if (jevDown) return { code: 1, stdout: "", stderr: "jev: API error status=402 request_id=r1: insufficient credit" };
    const n = Number(/photocraft#(\d+)/.exec(input)![1]);
    const [choice, top] = jev[n]!;
    return { code: 0, stdout: JSON.stringify({ answers: { area: { choice, probabilities: { [choice]: top } } }, usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" };
  }
  const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
  const result = JSON.stringify(refs.map((ref) => ({ ref, area: haiku[Number(ref.split("#")[1])] ?? "none of these" })));
  return { code: 0, stdout: JSON.stringify({ type: "result", result, usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" };
};

const run = (db: ReturnType<typeof setup>, rescan = false) => assignAreas(db, { limit: 100, rescan, usageRun: "t", paths: async () => null });

test("Jev settles from 0.9, Haiku decides below it or without Jev, and none of these is stored", async () => {
  const db = setup(5);
  editAreas(db, "photocraft", { op: "add", name: "Canvas", description: "drawing surface" }, "op");
  editAreas(db, "photocraft", { op: "add", name: "Text", description: "type" }, "op");
  const calls: string[] = [];
  const restore = setRunner(fake({ 1: ["Canvas", 0.95], 2: ["Canvas", 0.6], 3: ["none of these", 0.95], 4: ["Text", 0.5], 5: ["Canvas", 0.99] }, { 2: "Text", 4: "none of these" }, calls));
  try {
    const r = await run(db);
    const at = (n: number) => itemAreaOf(db, "photocraft", n)!;
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => [at(n).area, at(n).source]), [["Canvas", "jev"], ["Text", "haiku"], [null, "jev"], [null, "haiku"], ["Canvas", "jev"]]);
    assert.equal(at(1).confidence, 0.95);
    assert.equal(at(2).confidence, null);
    assert.equal(r.left, 0);
    // Asked against the current version: a second pass asks nothing; a re-scan asks the two unassigned items again.
    calls.length = 0;
    assert.equal((await run(db)).due, 0);
    assert.equal(calls.length, 0);
    assert.equal((await run(db, true)).due, 2);
  } finally { restore(); }
});

test("Haiku decides alone while Jev is unavailable, and a repo without a list is not asked", async () => {
  const db = setup(2);
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('filmcraft', 1)");
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('filmcraft', 1, 'issue', 'OPEN', 'x', 'b', 'a', '2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run();
  editAreas(db, "photocraft", { op: "add", name: "Canvas", description: "drawing surface" }, "op");
  markJevUnavailable(db, "account", "out of credit");
  const calls: string[] = [];
  const restore = setRunner(fake({}, { 1: "Canvas", 2: "Canvas" }, calls, true));
  try {
    const r = await run(db);
    assert.equal(r.due, 2);
    assert.equal(calls.filter((c) => c === "jev").length, 0);
    assert.deepEqual([1, 2].map((n) => itemAreaOf(db, "photocraft", n)?.source), ["haiku", "haiku"]);
    assert.equal(itemAreaOf(db, "filmcraft", 1), null);
  } finally { restore(); }
});

test("an answer for a list edited during the pass is dropped, a stale name is unassigned and a removed operator choice is asked again", async () => {
  const db = setup(2);
  editAreas(db, "photocraft", { op: "add", name: "Canvas", description: "drawing surface" }, "op");
  editAreas(db, "photocraft", { op: "add", name: "Text", description: "type" }, "op");
  const inner = fake({ 1: ["Canvas", 0.95], 2: ["Canvas", 0.95] }, {}, []);
  // The operator renames Canvas while Jev is answering item 1.
  let edited = false;
  const restore = setRunner(async (cmd, a, input, ...rest) => {
    if (cmd === "jev" && !edited) {
      edited = true;
      editAreas(db, "photocraft", { op: "rename", from: "Canvas", to: "Drawing" }, "op");
    }
    return inner(cmd, a, input, ...rest);
  });
  try {
    await run(db);
  } finally { restore(); }
  // Both answers named a version that is gone; neither is stored, and both are due again.
  assert.deepEqual([1, 2].map((n) => itemAreaOf(db, "photocraft", n)), [null, null]);

  // A name written by an older pass that is not in the new list becomes unassigned; an operator row of a removed area is deleted.
  const v = currentList(db, "photocraft")!.version;
  const put = db.prepare("INSERT INTO item_areas (repo, number, area, source, confidence, list_version, at) VALUES ('photocraft', ?, ?, ?, NULL, ?, 't')");
  put.run(1, "Canvas", "jev", v); put.run(2, "Text", "operator", v);
  editAreas(db, "photocraft", { op: "remove", name: "Text" }, "op");
  assert.equal(itemAreaOf(db, "photocraft", 1)!.area, null);
  assert.equal(itemAreaOf(db, "photocraft", 2), null);
});
