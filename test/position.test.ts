// Queue position: per-stage numbering in work-rank order, fast-tracked items first, none for steps that are not queued.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { computeStages, queueSlots, slotsOf } from "../src/rank/position.ts";
import { SCRATCH } from "./scratch.ts";

test("places are numbered per stage by rank, fast track first, and only queued steps get one", () => {
  const db = connect(join(SCRATCH, "position.db"));
  db.exec("INSERT INTO repos (name, visibility) VALUES ('app', 'public'), ('other', 'public'), ('off', 'public')");
  db.exec("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', 'x', 1), ('other', 'op', 'x', 1), ('off', 'op', 'x', 0)");
  const next: Record<string, string> = {
    "app#1": "Review", "app#2": "Review", "app#3": "Review", "app#4": "Fix", "app#5": "Decide", "app#6": "Verify: running",
    "app#7": "Merge queue", "other#1": "Review", "off#1": "Review", "off#2": "Review",
  };
  const rank: Record<string, number> = { "app#1": 10, "app#2": 30, "app#3": 20, "app#4": 5, "other#1": 40 };
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES (?, ?, 'pr', 'OPEN', 't')");
  const put = db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES (?, ?, ?, '{}', 'x')");
  for (const k of Object.keys(next)) {
    const [repo, n] = k.split("#");
    item.run(repo!, Number(n));
    put.run(repo!, Number(n), rank[k] ?? 1);
  }
  // A fast-tracked item runs although its repo's pipeline is off, and goes first.
  db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('off', 2, 'op', 'x')").run();
  db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 7, 'op', 'x')").run();

  const stages = computeStages(db, { nextOf: (r) => next[`${r.repo}#${r.number}`]!, entries: [] });
  const slots = slotsOf(stages, ["app", "other", "off"]);
  const at = (k: string) => slots.get(k);
  assert.deepEqual(at("off#2"), { stage: "Review", tab: "review", place: 1 });
  assert.equal(at("other#1")?.place, 2);
  assert.equal(at("app#2")?.place, 3);
  assert.equal(at("app#3")?.place, 4);
  assert.equal(at("app#1")?.place, 5);
  assert.deepEqual(at("app#4"), { stage: "Fix", tab: "fix", place: 1 });
  for (const k of ["app#5", "app#6", "app#7", "off#1"]) assert.equal(at(k), undefined, `${k} has no place`);
  // Places count only the repos the viewer may see.
  assert.equal(slotsOf(stages, ["app"]).get("app#2")?.place, 1);
});

test("a PR with no review is in the Review queue when the next step is read from the stored rows", () => {
  const db = connect(join(SCRATCH, "position-real.db"));
  db.exec("INSERT INTO repos (name, visibility) VALUES ('app', 'public')");
  db.exec("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', 'x', 1)");
  db.exec("INSERT INTO items (repo, number, kind, state, title) VALUES ('app', 1, 'pr', 'OPEN', 't'), ('app', 2, 'pr', 'OPEN', 't')");
  db.exec("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 1, 5, '{}', 'x'), ('app', 2, 9, '{}', 'x')");
  const cls = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '2026-10-01', 'bugfix', '[]', '{\"top\":0.97}')");
  cls.run(1);
  cls.run(2);
  db.exec("INSERT INTO settings (key, value) VALUES ('classify_run', 'r1')");
  const slots = queueSlots(db, ["app"]);
  assert.deepEqual(slots.get("app#2"), { stage: "Review", tab: "review", place: 1 });
  assert.deepEqual(slots.get("app#1"), { stage: "Review", tab: "review", place: 2 });
});
