import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { inPilot } from "../src/pilot.ts";
import { refreshOutsideHolds, releaseOutside, setOutsideLimits } from "../src/outside.ts";
import { resumeStage } from "../src/push-outcomes.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function setup() {
  const db = connect(":memory:");
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
  let n = 0;
  const add = (author: string, kind: "pr" | "issue", minAgo: number, assoc = "NONE") =>
    db.prepare("INSERT INTO items (repo, number, kind, state, author, author_association, created_at) VALUES ('app', ?, ?, 'OPEN', ?, ?, ?)").run(++n, kind, author, assoc, ago(minAgo)) && n;
  return { db, add };
}

test("an outside author's 6th PR in 24 hours waits; members and the pipeline's own account do not; Release lets it through", () => {
  const { db, add } = setup();
  const outsider = Array.from({ length: 6 }, (_, k) => add("outsider", "pr", 600 - k * 10));
  const member = Array.from({ length: 8 }, (_, k) => add("regular", "pr", 300 - k, "MEMBER"));
  const own = add("bot", "pr", 5);
  const old = add("outsider", "pr", 30 * 60); // older than 24 hours: outside the window
  refreshOutsideHolds(db, NOW);
  assert.deepEqual(outsider.map((n) => inPilot(db, "app", n)), [true, true, true, true, true, false]);
  assert.ok([...member, own, old].every((n) => inPilot(db, "app", n)));

  releaseOutside(db, "op", "app", outsider[5]!);
  refreshOutsideHolds(db, NOW);
  assert.equal(inPilot(db, "app", outsider[5]!), true, "a released item stays exempt");

  // The oldest items age out of the window: the held one starts by itself.
  const held = add("outsider", "pr", 1);
  refreshOutsideHolds(db, NOW);
  assert.equal(inPilot(db, "app", held), false);
  refreshOutsideHolds(db, NOW + 25 * 3_600_000 - 595 * 60_000);
  assert.equal(inPilot(db, "app", held), true);
});

test("the surge breaker trips on many new outside items, holds only those, and stays until an operator resumes it", () => {
  const { db, add } = setup();
  setOutsideLimits(db, "op", { prsPerDay: 0, issuesPerDay: 0, surgePerHour: 3 });
  const older = add("early", "issue", 120);
  const insider = add("regular", "pr", 10, "COLLABORATOR");
  const surge = [add("a", "pr", 30), add("b", "issue", 20), add("c", "pr", 10), add("d", "pr", 5)];
  refreshOutsideHolds(db, NOW);
  assert.equal((db.prepare("SELECT active FROM stage_trips WHERE stage = 'outside-surge'").get() as { active: number }).active, 1);
  assert.deepEqual(surge.map((n) => inPilot(db, "app", n)), [false, false, false, false]);
  assert.ok(inPilot(db, "app", older) && inPilot(db, "app", insider));

  refreshOutsideHolds(db, NOW + 3 * 3_600_000);
  assert.equal(inPilot(db, "app", surge[0]!), false, "no timer: the hold stays");
  resumeStage(db, "outside-surge", "op");
  refreshOutsideHolds(db, NOW + 3 * 3_600_000);
  assert.ok(surge.every((n) => inPilot(db, "app", n)));
  assert.equal((db.prepare("SELECT active FROM stage_trips WHERE stage = 'outside-surge'").get() as { active: number }).active, 0, "the old items do not trip it again");
});
