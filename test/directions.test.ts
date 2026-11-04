// Owner directions: the reply parse drops unknown ids, and the facts of a PR count only the active directions its reviews named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDirection, activeDirections, retireDirection } from "../src/directions.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { parseDirectionHits } from "../src/review/opus-parse.ts";
import { parseProposalReply } from "../src/directions-types.ts";
import { dueNotes, openProposals, saveProposal } from "../src/directions-propose.ts";
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

test("a proposal reply gives a draft, none, or is invalid", () => {
  const ok = (direction: unknown) => parseProposalReply(JSON.stringify({ ref: "app#1", direction }), "app#1");
  assert.deepEqual(ok("  Language data\n belongs in the library "), { draft: "Language data belongs in the library" });
  assert.deepEqual(ok(null), { draft: null });
  assert.deepEqual(ok(""), { draft: null });
  assert.equal(ok(5), undefined);
  assert.equal(parseProposalReply(JSON.stringify({ ref: "app#2", direction: "x" }), "app#1"), undefined);
  assert.equal(parseProposalReply("no json", "app#1"), undefined);
});

test("notes of operators are due once, and only after the since mark", () => {
  const w = world().repo().pr(1);
  w.db.prepare("INSERT INTO access (login, role) VALUES ('boss', 'operator')").run();
  w.db.prepare("UPDATE settings SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'direction_proposals_since'").run();
  const decide = (id: string, by: string, at: string, note: string | null) => w.db.prepare(
    "INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answer_note, answered_by, answered_at) VALUES (?, 'close', 'app', 1, 'q', '[]', ?, 'close', ?, ?, ?)").run(id, at, note, by, at);
  decide("d1", "boss", "2026-02-01T00:00:00.000Z", "Language data belongs in the library, not the app.");
  decide("d2", "boss", "2026-02-01T00:00:00.000Z", "short");
  decide("d3", "someone", "2026-02-01T00:00:00.000Z", "Language data belongs in the library, not the app.");
  decide("d4", "boss", "2025-12-01T00:00:00.000Z", "Language data belongs in the library, not the app.");
  assert.deepEqual(dueNotes(w.db).map((n) => n.source), ["decision:d1"]);
  saveProposal(w.db, dueNotes(w.db)[0]!, "Draft");
  assert.deepEqual(dueNotes(w.db), []);
  assert.equal(openProposals(w.db).length, 1);
});
