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
import { RANK_WEIGHTS, rankOf, sizeOfLines, type RankInput } from "../src/rank/score.ts";
import { bestScore, orderLanes } from "../src/runner/autopilot.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "rank-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const input = (o: Partial<RankInput>): RankInput => ({ priority: 40, label: "bugfix", security: false, size: "M", sizeSource: "lines", ...o });

describe("score", () => {
  test("a small bugfix outranks a large feature at equal priority", () => {
    const bug = rankOf(input({ label: "bugfix", size: "S" })).score;
    const feature = rankOf(input({ label: "missing feature", size: "XL" })).score;
    assert.ok(bug > feature);
    assert.ok(rankOf(input({ size: "S" })).score > rankOf(input({ size: "L" })).score, "smaller ranks higher");
  });

  test("a clearly higher priority still wins over type and size", () => {
    assert.ok(rankOf(input({ priority: 85, label: "small extra", size: "XL" })).score > rankOf(input({ priority: 30, label: "bugfix", size: "S" })).score);
  });

  test("the security flag adds its bonus and shows in the breakdown", () => {
    const plain = rankOf(input({}));
    const sec = rankOf(input({ security: true }));
    assert.equal(sec.score - plain.score, RANK_WEIGHTS.security);
    assert.equal(sec.breakdown.security.points, RANK_WEIGHTS.security);
  });

  test("missing priority, size and label use the defaults", () => {
    const r = rankOf({ priority: null, label: null, security: false, size: null, sizeSource: "default" });
    assert.equal(r.breakdown.priority.points, RANK_WEIGHTS.defaultPriority);
    assert.equal(r.breakdown.size.value, RANK_WEIGHTS.defaultSize);
    assert.equal(r.breakdown.size.source, "default");
    assert.equal(r.breakdown.type.points, RANK_WEIGHTS.unlabelledType);
    assert.equal(r.score, RANK_WEIGHTS.defaultPriority + RANK_WEIGHTS.unlabelledType + RANK_WEIGHTS.size[RANK_WEIGHTS.defaultSize]);
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
    db.exec("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('app', 1, 'h', 'normal', 40, 'jev', 'x')");
    db.exec("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, size, created_at, updated_at) VALUES ('app', 3, 's', 'h', 'retry', 'S', 'x', 'x')");

    const r = runRank(db);
    assert.equal(r.items, 4);
    const one = rankOfItem(db, "app", 1)!;
    assert.equal(one.breakdown.size.value, "S");
    assert.equal(one.breakdown.size.source, "lines");
    const big = rankOfItem(db, "app", 2)!;
    assert.equal(big.breakdown.size.value, "XL");
    assert.equal(big.breakdown.security.value, true);
    assert.equal(big.breakdown.priority.value, null, "unrated: default priority");
    assert.equal(rankOfItem(db, "app", 3)!.breakdown.size.source, "triage");
    assert.equal(rankOfItem(db, "app", 4)!.breakdown.size.source, "default");
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
