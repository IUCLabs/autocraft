// The work score, its recomputation from stored results, the autopilot's choice between the Review and Fix
// lanes and the size field of the Fix triage.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { parseTriage } from "../src/fixissue/parse.ts";
import { rankOfItem, runRank } from "../src/rank/index.ts";
import { rankOf, sizeOfLines, type RankInput } from "../src/rank/score.ts";
import { bestScore, orderLanes } from "../src/runner/autopilot.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "rank-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const input = (o: Partial<RankInput>): RankInput => ({ level: "P2", reach: 40, label: "bugfix", security: false, size: "M", sizeSource: "lines", ...o });
const key = (o: Partial<RankInput>) => rankOf(input(o)).score;

describe("score", () => {
  test("a higher level wins over type, size and reach", () => {
    assert.ok(key({ level: "P1", label: "small extra", size: "XL", reach: 0 }) > key({ level: "P2", label: "bugfix", size: "S", reach: 99 }));
    assert.ok(key({ level: "P0" }) > key({ level: "P1" }));
    assert.ok(key({ level: "P3" }) > key({ level: "P4", label: "bugfix", size: "S", reach: 99 }));
  });

  test("at equal level a bugfix comes before a feature, then smaller before larger, then higher reach", () => {
    assert.ok(key({ label: "bugfix", size: "XL", reach: 0 }) > key({ label: "missing feature", size: "S", reach: 99 }));
    assert.ok(key({ label: "bugfix", size: "S", reach: 0 }) > key({ label: "bugfix", size: "M", reach: 99 }));
    assert.ok(key({ size: "L", reach: 50 }) > key({ size: "L", reach: 10 }));
    assert.ok(key({ label: "plugin candidate" }) > key({ label: null }), "an unsettled type comes last");
  });

  test("the security flag raises the level by one, not above P0", () => {
    const sec = rankOf(input({ level: "P2", security: true }));
    assert.equal(sec.breakdown.level, "P1");
    assert.equal(sec.breakdown.rated, "P2");
    assert.equal(sec.score, key({ level: "P1" }));
    assert.equal(rankOf(input({ level: "P0", security: true })).breakdown.level, "P0");
  });

  test("the key encodes level, type, size and reach as digits", () => {
    assert.equal(key({ level: "P0", label: "bugfix", size: "S", reach: 7 }), 4 * 10000 + 6 * 1000 + 3 * 100 + 7);
    assert.equal(key({ level: "P4", label: null, size: "XL", reach: 0 }), 0);
  });

  test("missing level, size, reach and label use the defaults", () => {
    const r = rankOf({ level: null, reach: null, label: null, security: false, size: null, sizeSource: "default" });
    assert.equal(r.breakdown.level, "P2");
    assert.equal(r.breakdown.rated, null);
    assert.equal(r.breakdown.size, "M");
    assert.equal(r.breakdown.sizeSource, "default");
    assert.equal(r.score, 2 * 10000 + 0 * 1000 + 2 * 100 + 0);
  });

  test("PR size bounds", () => {
    assert.deepEqual([0, 50, 51, 300, 301, 1000, 1001].map(sizeOfLines), ["S", "S", "M", "M", "L", "L", "XL"]);
  });
});

describe("runRank", () => {
  test("ranks open tracked items from stored results; an issue takes the triage size", () => {
    const db = connect(join(dir, "r.db"));
    db.exec("INSERT INTO repos (name, visibility) VALUES ('app', 'public')");
    db.exec("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('app', 'op', 'x')");
    const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, additions, deletions) VALUES ('app', ?, ?, ?, 't', ?, ?)");
    item.run(1, "pr", "OPEN", 10, 5);
    item.run(2, "pr", "OPEN", 900, 400);
    item.run(3, "issue", "OPEN", null, null);
    item.run(4, "issue", "OPEN", null, null);
    item.run(5, "pr", "MERGED", 1, 1);
    const cls = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '2026-10-01', ?, ?, '{"top":0.97}')`);
    cls.run(1, "bugfix", "[]");
    cls.run(2, "missing feature", '["security"]');
    cls.run(3, "bugfix", "[]");
    cls.run(4, "bugfix", "[]");
    db.exec("INSERT INTO settings (key, value) VALUES ('classify_run', 'r1')");
    db.exec("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('app', 1, 'h', 'P1', 40, 'jev', 'x')");
    db.exec("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, size, created_at, updated_at) VALUES ('app', 3, 's', 'h', 'retry', 'S', 'x', 'x')");

    const r = runRank(db);
    assert.equal(r.items, 4);
    const one = rankOfItem(db, "app", 1)!;
    assert.equal(one.breakdown.size, "S");
    assert.equal(one.breakdown.sizeSource, "lines");
    assert.equal(one.breakdown.level, "P1");
    assert.equal(one.breakdown.reach, 40);
    const big = rankOfItem(db, "app", 2)!;
    assert.equal(big.breakdown.size, "XL");
    assert.equal(big.breakdown.security, true);
    assert.equal(big.breakdown.rated, null);
    assert.equal(big.breakdown.level, "P1", "unrated P2 raised by the security flag");
    assert.equal(rankOfItem(db, "app", 3)!.breakdown.sizeSource, "triage");
    assert.equal(rankOfItem(db, "app", 4)!.breakdown.sizeSource, "default");
    assert.ok(rankOfItem(db, "app", 3)!.score > rankOfItem(db, "app", 4)!.score, "a small estimated fix ranks above an unestimated one");
    assert.equal(rankOfItem(db, "app", 5), null, "merged items have no rank");

    assert.equal(runRank(db).changed, 0, "a second pass changes nothing");
    db.exec("UPDATE items SET state = 'CLOSED' WHERE number = 4");
    assert.equal(runRank(db).removed, 1);
    db.close();
  });
});

describe("autopilot lane choice", () => {
  const lanes = [{ name: "classify" }, { name: "review" }, { name: "labels" }, { name: "fixissue" }];
  const names = (l: { name: string }[]) => l.map((x) => x.name);

  test("the lane with the higher top score goes first; other lanes keep their places", () => {
    assert.deepEqual(names(orderLanes(lanes, new Map([["review", 40], ["fixissue", 70]]))), ["classify", "fixissue", "labels", "review"]);
    assert.deepEqual(names(orderLanes(lanes, new Map([["review", 70], ["fixissue", 40]]))), ["classify", "review", "labels", "fixissue"]);
  });

  test("ties keep the pipeline order and a lane without work goes last", () => {
    assert.deepEqual(names(orderLanes(lanes, new Map([["review", 50], ["fixissue", 50]]))), ["classify", "review", "labels", "fixissue"]);
    assert.deepEqual(names(orderLanes(lanes, new Map([["review", null], ["fixissue", 10]]))), ["classify", "fixissue", "labels", "review"]);
  });

  test("bestScore ignores missing scores", () => {
    assert.equal(bestScore([undefined, 12, null, 30]), 30);
    assert.equal(bestScore([undefined, null]), null);
  });
});

describe("triage size", () => {
  const crates = [{ name: "app", dir: "crates/app" }];
  const paths = ["crates/app/src/lib.rs"];
  const reply = (extra: Record<string, unknown>) => JSON.stringify([{ ref: "app#5", fixable: true, reason: "r", crate: "app", files: paths, ...extra }]);

  test("a valid size is kept, a missing one is null, an invalid one is refused", () => {
    const ok = parseTriage(reply({ size: "S" }), "app#5", crates, paths);
    assert.ok(ok.ok && ok.triage.fixable && ok.triage.size === "S");
    const none = parseTriage(reply({}), "app#5", crates, paths);
    assert.ok(none.ok && none.triage.fixable && none.triage.size === null);
    assert.equal(parseTriage(reply({ size: "huge" }), "app#5", crates, paths).ok, false);
  });
});
