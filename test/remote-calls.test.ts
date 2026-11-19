// The user-local inference mode: askClaude queues a remote call, a helper claims it, fetches the bundle and submits, and
// askClaude returns the reply. A lease without heartbeats goes back to the queue; the item's authors never get a judging call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { askClaude } from "../src/classify/run.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { bundleOf, claimCall, heartbeat, submitCall, type Caller } from "../src/remote/calls.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-calls-"));

describe("user-local remote calls", () => {
  const db = connect(join(dir, "t.db"));
  allocation.pollMs = 10;
  setInferenceMode(db, "user-local", "test");
  const T0 = new Date().toISOString();
  db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES ('photocraft', 1287, 'pr', 'OPEN', 't', 'alice', ?, ?)").run(T0, T0);
  db.prepare("INSERT INTO pr_commits (repo, number, oid, committed_at, author) VALUES ('photocraft', 1287, 'abc', ?, 'carol')").run(T0);
  const callers: Record<string, Caller> = {};
  for (const login of ["alice", "bob", "carol"]) {
    db.prepare("INSERT INTO access (login, role) VALUES (?, 'maintainer')").run(login);
    callers[login] = { tokenId: createToken(db, login, "helper", false, true).row.id, login, role: "maintainer" };
  }
  const claim: Claim = { protocol: PROTOCOL_VERSION, helperVersion: "1.0.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } };
  const canWrite = async () => true;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const leaseFor = async (login: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await claimCall(db, callers[login]!, claim, canWrite);
      if (r.lease) return r.lease;
      if (db.prepare("SELECT 1 FROM remote_calls WHERE state = 'queued'").get()) return null;
      await sleep(5);
    }
    throw new Error("no call was queued");
  };
  const done = (secret: string, text: string) => submitCall(db, secret, { ok: true, text, model: "claude-opus-4-5", usage: { inputTokens: 100, outputTokens: 20 }, modelUsage: { "claude-opus-4-5": { inputTokens: 90, outputTokens: 15 }, "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 } }, durationMs: 1000 });

  test("a helper claims, fetches the bundle and submits; authors and committers of the PR get nothing", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    assert.equal(await leaseFor("alice"), null, "the PR's author");
    assert.equal(await leaseFor("carol"), null, "a committer on the PR");
    const lease = (await leaseFor("bob"))!;
    assert.match(lease.title, /^review\.opus on photocraft#1287/);
    const b = bundleOf(db, lease.secret)!;
    assert.equal(b.tier, "top");
    assert.equal(b.callId, lease.id);
    assert.ok(b.stdin.length > 0 && b.system !== null);
    assert.deepEqual(b.mounts, []);
    assert.ok(b.hints.claude!.args.includes("--model"));
    assert.equal(heartbeat(db, lease.secret, { progress: "reading" }), true);
    assert.deepEqual(done(lease.secret, "the review"), { accepted: true });
    const r = await ask;
    assert.equal(r?.text, "the review");
    assert.equal(r?.usage.input, 90);
    assert.deepEqual(r?.usage.extra?.map((e) => [e.model, e.usage.input]), [["haiku", 10]]);
    const run = db.prepare("SELECT state, user_login, harness, reported_model, account_id FROM agent_runs WHERE id = (SELECT run_id FROM remote_calls WHERE id = ?)").get(lease.id) as Record<string, unknown>;
    assert.deepEqual({ ...run }, { state: "done", user_login: "bob", harness: "claude", reported_model: "opus", account_id: null });
  });

  test("a lease without heartbeats goes back to the queue and the next claim gets it; the old secret is dead", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const first = (await leaseFor("bob"))!;
    db.prepare("UPDATE remote_calls SET heartbeat_at = heartbeat_at - 3 * 60000 WHERE id = ?").run(first.id);
    let second = null;
    for (let i = 0; i < 200 && !second; i++) { second = (await claimCall(db, callers.bob!, claim, canWrite)).lease; if (!second) await sleep(5); }
    assert.equal(second!.id, first.id, "the same call, leased again");
    assert.equal(heartbeat(db, first.secret, {}), false);
    assert.equal(done(first.secret, "stale").accepted, false);
    assert.equal((db.prepare("SELECT attempt FROM remote_calls WHERE id = ?").get(first.id) as { attempt: number }).attempt, 2);
    // A reply from another model family than the claim declared is refused.
    assert.equal(submitCall(db, second!.secret, { ok: true, text: "x", model: "claude-sonnet-4-5", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }).accepted, false);
    assert.equal(await ask, null, "both attempts are used up");
    const runs = db.prepare("SELECT state, error FROM agent_runs WHERE prompt_id = 'review.opus' ORDER BY id DESC LIMIT 2").all() as { state: string; error: string }[];
    assert.deepEqual(runs.map((x) => x.state), ["failed", "failed"]);
    assert.match(runs[1]!.error, /lease expired/);
  });
});
