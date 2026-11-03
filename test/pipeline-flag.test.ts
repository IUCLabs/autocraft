// The per-repo pipeline flag: merge jobs skip a repo that is off, and an old whole-repo pilot entry becomes the flag.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";

const { connect } = await import("../src/db.ts");
const { pilotItems, pipelineRepos } = await import("../src/pilot.ts");
const { runMerge } = await import("../src/merge/index.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pipeline-flag-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a manual merge job for a repo with the pipeline off does nothing", async () => {
  const db = connect(join(dir, "m.db"));
  db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('other', 0)");
  const lines: string[] = [];
  const s = await runMerge(db, { repo: "other", dryRun: false }, (l) => lines.push(l));
  assert.deepEqual([s.attempted, s.merged, s.asked], [[], [], []]);
  assert.match(lines.join("\n"), /nothing done/);
  db.close();
});

test("whole-repo pilot entries turn the repo's flag on and leave the item entries", () => {
  const path = join(dir, "mig.db");
  const db = connect(path);
  db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name) VALUES ('designcraft'), ('photocraft')");
  assert.deepEqual([...pipelineRepos(db)], [], "tracked repos start with the pipeline off");
  db.prepare("INSERT INTO settings (key, value) VALUES ('pilot_items', ?)").run(JSON.stringify(["designcraft", "photocraft#3"]));
  db.close();

  const again = connect(path);
  assert.deepEqual([...pipelineRepos(again)], ["designcraft"]);
  assert.deepEqual(pilotItems(again), ["photocraft#3"]);
  again.prepare("UPDATE settings SET value = ? WHERE key = 'pilot_items'").run(JSON.stringify(["photocraft"]));
  again.close();

  const last = connect(path);
  assert.deepEqual([...pipelineRepos(last)].sort(), ["designcraft", "photocraft"]);
  assert.deepEqual(pilotItems(last), [], "a pilot that held only whole repos is gone");
  assert.equal(last.prepare("SELECT 1 FROM settings WHERE key = 'pilot_items'").get(), undefined);
  last.close();
});
