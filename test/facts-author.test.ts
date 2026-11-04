// The pipeline-author fact: a PR without an author is not the pipeline's own, also when no pipeline login is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "../src/db.ts";
import { loadPrFacts } from "../src/core/facts.ts";

test("authorIsPipeline is false for a null author and a null login, true for the pipeline's own login", () => {
  const db = connect(join(mkdtempSync(join(homedir(), ".cache/arch-scratch/facts-")), "t.db"));
  db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
  const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, author, url, created_at, updated_at) VALUES ('app', ?, 'pr', 'OPEN', 't', ?, 'u', '2026-01-01', '2026-01-01')");
  ins.run(1, null);
  ins.run(2, "bot");
  ins.run(3, "dev");
  const by = () => new Map(loadPrFacts(db).map((f) => [f.number, f.authorIsPipeline]));
  assert.deepEqual([...by()], [[1, false], [2, false], [3, false]]);
  db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
  assert.deepEqual([...by()], [[1, false], [2, true], [3, false]]);
});
