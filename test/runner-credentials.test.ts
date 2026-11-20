// MCP Connector and Task Runner credentials: the one-time split of older tokens, and the claim protocols the server accepts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect, splitRunnerTokens } from "../src/db.ts";
import { HttpError } from "../src/dash/server/util.ts";
import { parseClaim } from "../src/remote/calls.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-credentials-"));

test("older tokens a helper used become runners, the others connectors, and can_run follows the kind", () => {
  const db = connect(join(dir, "split.db"));
  const now = new Date().toISOString();
  const token = (label: string, canRun: number) =>
    Number((db.prepare("INSERT INTO mcp_tokens (login, token_hash, label, can_run, created_at, expires_at) VALUES ('alice', ?, ?, ?, ?, ?) RETURNING id")
      .get(`hash-${label}`, label, canRun, now, now) as { id: number }).id);
  const status = token("status", 1), idle = token("idle", 1), leased = token("leased", 1), unused = token("unused", 1), plain = token("plain", 0);
  db.prepare("INSERT INTO remote_helpers (token_id, login, readiness, harness, models, reserve, reported_at) VALUES (?, 'alice', 'ready', 'claude', '{}', '{}', 0)").run(status);
  db.prepare("UPDATE mcp_tokens SET idle_claim_at = 1 WHERE id = ?").run(idle);
  db.prepare(`INSERT INTO remote_calls (step, stage, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, since, seen_at, max_attempts, timeout_ms, token_id)
    VALUES ('review', 0, 'p', '1', 'top', 'high', 'opus', '{}', 'done', 0, 0, 1, 1, ?)`).run(leased);
  db.prepare("DELETE FROM settings WHERE key = 'runner_tokens_split'").run();

  splitRunnerTokens(db);
  splitRunnerTokens(db);

  const rows = db.prepare("SELECT id, kind, can_run FROM mcp_tokens ORDER BY id").all() as { id: number; kind: string; can_run: number }[];
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.can_run]), [[status, "runner", 1], [idle, "runner", 1], [leased, "runner", 1], [unused, "connector", 0], [plain, "connector", 0]]);
  const audits = db.prepare("SELECT login, target, details FROM audit WHERE action = 'runner-migrate' ORDER BY rowid").all() as { login: string; target: string; details: string }[];
  assert.deepEqual(audits.map((a) => [a.login, a.target, JSON.parse(a.details).id, JSON.parse(a.details).kind]),
    [["migration", "alice", status, "runner"], ["migration", "alice", idle, "runner"], ["migration", "alice", leased, "runner"], ["migration", "alice", unused, "connector"]]);
  db.close();
});

test("a claim keeps the helper's protocol; only protocol 4 carries a wait", () => {
  const base = { requestId: "test-claim-0001", helperVersion: "1.3.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } };
  const v3 = parseClaim({ ...base, protocol: 3, wait: 25 });
  assert.equal(v3.protocol, 3);
  assert.equal(v3.wait, undefined);
  const v4 = parseClaim({ ...base, protocol: 4, wait: 25 });
  assert.equal(v4.protocol, 4);
  assert.equal(v4.wait, 25);
  assert.equal(parseClaim({ ...base, protocol: 4 }).wait, undefined);
  assert.throws(() => parseClaim({ ...base, protocol: 4, wait: 31 }), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => parseClaim({ ...base, protocol: 4, wait: 2.5 }), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => parseClaim({ ...base, protocol: 5 }), (e) => e instanceof HttpError && e.status === 409);
});
