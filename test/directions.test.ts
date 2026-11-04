// Owner directions: the reply parse drops unknown ids, and the facts of a PR count only the active directions its reviews named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDirection, activeDirections, retireDirection } from "../src/directions.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { parseDirectionHits } from "../src/review/opus-parse.ts";
import { parsePremerge } from "../src/premerge/parse.ts";
import { world } from "./world-db.ts";

const KNOWN = [{ id: 1, text: "a" }, { id: 2, text: "b" }];

test("a reply's directions keep known ids once and drop the rest", () => {
  const hits = parseDirectionHits([{ id: 2, reason: " why " }, { id: 9, reason: "unknown" }, { id: 2, reason: "again" }, { id: 1 }, "x", { id: "1", reason: "r" }], KNOWN);
  assert.deepEqual(hits, [{ id: 2, reason: "why" }]);
  assert.deepEqual(parseDirectionHits("nope", KNOWN), []);
  const pm = parsePremerge(JSON.stringify({ ref: "app#1", findings: [], searched: "s", directions: [{ id: 1, reason: "r" }, { id: 5, reason: "r" }] }), "app#1", new Set(), KNOWN);
  assert.deepEqual(pm?.directions, [{ id: 1, reason: "r" }]);
});

test("directions of the repo and of every repo are active until retired", () => {
  const w = world();
  const a = addDirection(w.db, "app", "one", "op"), b = addDirection(w.db, "*", "two", "op");
  addDirection(w.db, "other", "three", "op");
  assert.deepEqual(activeDirections(w.db, "app").map((d) => d.id), [a, b]);
  assert.ok(retireDirection(w.db, a));
  assert.deepEqual(activeDirections(w.db, "app").map((d) => d.id), [b]);
});

test("facts list the active directions that the Opus or the pre-merge review at the head named", () => {
  const w = world().repo().pr(1).review(1).premerge(1, "clean");
  const a = addDirection(w.db, "app", "keep language data in the library", "op"), b = addDirection(w.db, "*", "no new dependencies", "op"), c = addDirection(w.db, "app", "retired one", "op");
  retireDirection(w.db, c);
  const touched = () => loadPrFacts(w.db, { refs: ["app#1"] }).find((f) => f.number === 1)!.directionsTouched;
  assert.deepEqual(touched(), []);
  w.db.prepare("UPDATE opus_reviews SET directions = ?").run(JSON.stringify([{ id: a, reason: "adds a table" }, { id: c, reason: "retired" }]));
  assert.deepEqual(touched(), [{ id: a, text: "keep language data in the library", reason: "adds a table" }]);
  w.db.prepare("UPDATE premerge_reviews SET directions = ?").run(JSON.stringify([{ id: b, reason: "adds a crate" }]));
  assert.deepEqual(touched().map((d) => d.id), [a, b]);
});
