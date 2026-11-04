// Haiku is asked about an item when Jev is unsure of the type or of a flag, and has no verdict as new as Jev's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";

const { connect } = await import("../src/db.ts");
const { plannedItems } = await import("../src/core/select-items.ts");
const haikuDue = (d: typeof db, run: string) => plannedItems(d, "classify", { run, bucket: "haiku" }).map((p) => p.facts);

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "haiku-due-"));
const db = connect(join(dir, "h.db"));
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const T = "2026-11-01T00:00:00Z";
db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('off', 0)");
const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, url, embed_hash, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', 't', 'b', 'x', ?, 'h', ?, ?)");
const jev = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r', ?, 'bugfix', '[]', ?)");
const probs = (top: number, security: number, needs_decision: number) => JSON.stringify({ top, security, needs_decision });
const cases: [number, string][] = [
  [1, probs(0.95, 0.05, 0.05)], // sure everywhere
  [2, probs(0.95, 0.5, 0.05)], // sure type, unsure security
  [3, probs(0.95, 0.05, 0.85)], // sure yes needs decision
  [4, probs(0.95, 0.05, 0.5)], // sure type, unsure needs decision
  [5, probs(0.6, 0.05, 0.05)], // unsure type
];
for (const [n, p] of cases) { item.run(n, `https://github.com/storytold/app/issues/${n}`, T, T); jev.run(n, T, p); }

test("a sure type with an unsure flag is due; a sure item is not", () => {
  const due = (haikuDue(db, "r")).map((i) => i.number).sort((a, b) => a - b);
  assert.deepEqual(due, [2, 4, 5]);
});

test("an item with a Haiku verdict as new as Jev's is not due again", () => {
  db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('app', 2, 'haiku', 'r', ?, 'bugfix', '[]')").run("2026-11-02T00:00:00Z");
  const due = (haikuDue(db, "r")).map((i) => i.number).sort((a, b) => a - b);
  assert.deepEqual(due, [4, 5]);
});
