// A PR the GitHub App's bot opened counts as ours on a repo that writes as the app, and not on a legacy repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrFacts } from "../src/core/facts.ts";
import { ownLogins } from "../src/github/identity.ts";
import { world } from "./world-db.ts";

test("the app's bot is ours on app repos only; the box account stays ours on both", () => {
  const w = world().repo().pr(1, { author: "my-app" }).pr(2, { author: "box" }).pr(3, { author: "stranger" });
  w.db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', 'box')").run();
  const mine = () => Object.fromEntries(loadPrFacts(w.db, { appSlug: "my-app" }).map((f) => [f.number, f.authorIsPipeline]));
  assert.deepEqual(mine(), { 1: false, 2: true, 3: false });

  w.db.prepare("INSERT INTO main.settings (key, value) VALUES ('repo_identity:app', 'app')").run();
  assert.deepEqual(mine(), { 1: true, 2: true, 3: false });
  assert.deepEqual([...ownLogins(w.db, "app", "my-app")].sort(), ["box", "my-app", "my-app[bot]"]);
  assert.deepEqual([...ownLogins(w.db, "app", null)], ["box"]);
});
