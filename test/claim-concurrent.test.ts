// Slot accounting across job processes: several processes claim slots on one
// database file at the same moment and never take more than the account allows.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listAccounts } from "../src/agents/accounts.ts";
import { connect } from "../src/db.ts";
import { setupBox, writeReading } from "./accounts-fixture.ts";

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL("./claim-worker.ts", import.meta.url));

test("two processes claiming at once never exceed an account's slots", async () => {
  const box = setupBox(["a", "b"]);
  const file = join(mkdtempSync(join(homedir(), ".cache/craft-automation-scratch/claim-")), "t.db");
  const db = connect(file);
  listAccounts(db);
  db.prepare("UPDATE claude_accounts SET enabled = 1, max_concurrent = CASE id WHEN 'a' THEN 7 ELSE 5 END").run();
  writeReading(box, "a", {});
  writeReading(box, "b", {});
  const startAt = String(Date.now() + 1500);
  const env = { ...process.env, CRAFT_AUTO_DB: file };
  const outs = await Promise.all([0, 1, 2].map(() => run(process.execPath, [WORKER, file, startAt, "20"], { env })));
  const got = outs.map((o) => Number(o.stdout.trim()));
  assert.equal(got.reduce((a, b) => a + b, 0), 12, `claims: ${got}`);
  const per = Object.fromEntries((db.prepare("SELECT account_id AS id, COUNT(*) AS n FROM agent_runs WHERE state = 'running' GROUP BY account_id").all() as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  assert.deepEqual(per, { a: 7, b: 5 });
});
