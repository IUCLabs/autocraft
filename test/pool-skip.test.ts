// A pool asking the user-local room starts later units whose repos have room instead of waiting on the first, and never starts
// a unit no Task Runner may take: once only such units are left, it ends without them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { poolRoom, repoBatches } from "../src/agents/call.ts";
import { pool } from "../src/classify/run.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a pool skips a unit nobody may take and runs the later ones", async () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  setInferenceMode(db, "user-local", "test");
  db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const id = createToken(db, "olga", "helper", { kind: "runner" }).row.id;
  storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  db.prepare("UPDATE mcp_tokens SET idle_claim_at = ? WHERE id = ?").run(Date.now(), id);
  setUserRepos(db, "olga", ["deckcraft"]);

  const repos = ["photocraft", "deckcraft", "deckcraft"];
  const started: number[] = [];
  await pool(repos.map((_, i) => async () => { started.push(i); }), poolRoom(db, (i) => [repos[i]!]), { first: true, pollMs: 5 });
  assert.deepEqual(started, [1, 2], "the deckcraft units ran; the photocraft unit never started and the pool ended");
});

test("batches hold one repo's items, at most the batch size each, in the order of their first item", () => {
  const items = ["deck:1", "photo:1", "deck:2", "deck:3", "photo:2", "deck:4", "design:1"].map((x) => ({ repo: x.split(":")[0]!, id: x }));
  assert.deepEqual(repoBatches(items, 2, (x) => x.repo).map((b) => b.map((x) => x.id)), [["deck:1", "deck:2"], ["photo:1", "photo:2"], ["deck:3", "deck:4"], ["design:1"]]);
});
