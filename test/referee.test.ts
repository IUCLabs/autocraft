// The pipeline referee: which disagreements go to Sonnet, how its answer settles an item, and what stays for a person.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { refereeItems } from "../src/classify/referee.ts";
import { refereeCandidates } from "./planned.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { settledLookup, settledTable } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = connect(join(mkdtempSync(join(SCRATCH, "referee-test-")), "t.db"));
useTestAccount(db);
db.prepare("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();

const T = (n: number) => `2026-01-01T00:00:0${n}Z`;
// n: [jev label, haiku label]
const PAIRS: Record<number, [string, string]> = {
  1: ["bugfix", "missing feature"],   // referee candidate, sure answer
  2: ["infra", "bugfix"],             // referee candidate, unsure answer
  3: ["small extra", "plugin candidate"], // scope vs scope: Decide, never the referee
  4: ["bugfix", "bugfix"],            // agree
  5: ["performance", "bugfix"],       // candidate with no answer yet
};
for (const [n, [j, h]] of Object.entries(PAIRS)) {
  db.prepare("INSERT INTO items (repo, number, kind, state, title, body) VALUES ('app', ?, 'issue', 'OPEN', 'Crash on a 16-bit PNG', 'body')").run(Number(n));
  const c = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, ?, 'r1', ?, ?, '[]', ?)");
  c.run(Number(n), "jev", T(1), j, '{"top":0.6}');
  c.run(Number(n), "haiku", T(2), h, null);
}

/** Answers every asked ref: 1 sure, others unsure. */
const fake: Runner = async (_cmd, _args, input) => {
  const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
  const reply = refs.map((ref) => ({ ref, type_label: "bugfix", sure: ref === "app#1", why: "because" }));
  return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(reply), usage: {} }), stderr: "" };
};

describe("pipeline referee", () => {
  test("candidates are non-scope disagreements without a current answer", async () => {
    assert.deepEqual(refereeCandidates(db, "r1").map((i) => i.number).sort(), [1, 2, 5]);
    const restore = setRunner(fake);
    try {
      await refereeItems(db, "r1", refereeCandidates(db, "r1").filter((i) => i.number !== 5), { pipeline: true });
    } finally { restore(); }
    assert.deepEqual(refereeCandidates(db, "r1").map((i) => i.number), [5]);
  });

  test("a sure answer settles the type as sonnet; an unsure one stays with a person, reason attached", () => {
    const get = settledLookup(db, "r1");
    const one = get("app", 1), two = get("app", 2);
    assert.deepEqual([one.status, one.label, one.source], ["settled", "bugfix", "sonnet"]);
    assert.deepEqual([two.status, two.label, two.referee?.sure, two.referee?.reason], ["disagree", null, false, "because"]);
    assert.equal(get("app", 5).referee, null);
    settledTable(db, "r1");
    const rows = db.prepare("SELECT number, status, source, referee_sure FROM temp.item_settled ORDER BY number").all().map((r) => ({ ...r }));
    assert.deepEqual(rows.filter((r) => Number(r.number) <= 2), [
      { number: 1, status: "settled", source: "sonnet", referee_sure: 1 },
      { number: 2, status: "disagree", source: null, referee_sure: 0 },
    ]);
  });

  test("an answer older than a new verdict no longer counts, and evaluation rows never settle", () => {
    db.prepare("UPDATE classifications SET at = ? WHERE number = 1 AND classifier = 'haiku'").run(new Date(Date.now() + 60_000).toISOString());
    assert.equal(settledLookup(db, "r1")("app", 1).status, "disagree");
    assert.ok(refereeCandidates(db, "r1").some((i) => i.number === 1));
    db.prepare("UPDATE classifications SET probs = NULL WHERE classifier = 'sonnet'").run();
    assert.equal(settledLookup(db, "r1")("app", 2).referee, null);
  });
});
