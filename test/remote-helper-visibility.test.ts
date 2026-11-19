// A helper's last error, slots and busy count are stored from its status and listed; a ready helper with a queued call
// waiting past its tier's limit raises a health warning that names the tier and the wait.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { computeChecks, THRESHOLDS } from "../src/health-checks.ts";
import { listHelpers, parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a helper's last error and busy count are listed, and a starved tier warns", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "helper-vis-")), "t.db"));
  setInferenceMode(db, "user-local", "test");
  db.prepare("INSERT INTO access (login, role) VALUES ('alice', 'maintainer')").run();
  const tokenId = createToken(db, "alice", "laptop", false, true).row.id;
  const now = Date.now();
  const status = parseStatus({ readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 20, weekly: 20 }, slots: 4, busy: 2,
    lastError: { text: "/api/remote/heartbeat: HTTP 502", at: new Date(now - 60_000).toISOString() } });
  storeStatus(db, tokenId, "alice", status, now);
  const [h] = listHelpers(db, "alice", now);
  assert.deepEqual([h!.slots, h!.busy, h!.lastError?.text], [4, 2, "/api/remote/heartbeat: HTTP 502"]);

  const queue = (tier: string, waitedMs: number) => db.prepare(`INSERT INTO remote_calls (step, stage, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, since, seen_at, queued_since, max_attempts, timeout_ms)
    VALUES ('review', 1, 'p', '1', ?, 'high', 'opus', '{}', 'queued', ?, ?, ?, 3, 600000)`).run(tier, now - waitedMs, now, now - waitedMs);
  queue("small", THRESHOLDS.remoteTierWaitMs.small - 60_000);
  queue("top", THRESHOLDS.remoteTierWaitMs.top - 60_000);
  assert.equal(computeChecks(db, now).some((c) => c.id.startsWith("remote-starved-")), false);
  queue("small", THRESHOLDS.remoteTierWaitMs.small + 60_000);
  const warn = computeChecks(db, now).find((c) => c.id === "remote-starved-small");
  assert.equal(warn?.state, "warn");
  assert.match(warn!.text, /small-tier.*6 min/);
});
