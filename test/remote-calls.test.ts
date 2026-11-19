// The user-local inference mode: askClaude queues a remote call, a helper claims it, fetches the bundle and submits, and
// askClaude returns the reply. A lease without heartbeats goes back to the queue; the item's authors never get a judging call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { askClaude } from "../src/classify/run.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { User } from "../src/dash/types.ts";
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
  db.prepare("INSERT INTO pr_commits (repo, number, oid, committed_at, author, co_authors) VALUES ('photocraft', 1287, 'abc', ?, 'carol', ?)").run(T0, JSON.stringify(["carol", "Dave"]));
  const callers: Record<string, Caller> = {};
  for (const login of ["alice", "bob", "carol", "dave"]) {
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
  /** `login`'s helper asked for top-tier work a moment ago and found none; its write permission on the repo is cached. */
  const idle = (login: string) => {
    db.prepare("UPDATE mcp_tokens SET idle_claim_at = ?, idle_tiers = '[\"top\"]', idle_repos = NULL WHERE login = ?").run(Date.now(), login);
    db.prepare("INSERT OR REPLACE INTO repo_permissions (login, repo, permission, checked_at) VALUES (?, 'photocraft', 'write', ?)").run(login, new Date().toISOString());
  };
  const done = (secret: string, text: string) => submitCall(db, secret, { ok: true, text, model: "claude-opus-4-5", usage: { inputTokens: 100, outputTokens: 20 }, modelUsage: { "claude-opus-4-5": { inputTokens: 90, outputTokens: 15 }, "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 } }, costUsd: 0.25, durationMs: 1000 });

  test("a helper claims, fetches the bundle and submits; authors and co-authors give way while another helper is idle", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    idle("bob");
    assert.equal(await leaseFor("alice"), null, "the PR's author");
    assert.equal(await leaseFor("carol"), null, "a committer on the PR");
    assert.equal(await leaseFor("dave"), null, "a co-author of a commit");
    await assert.rejects(claimCall(db, callers.bob!, { ...claim, helperVersion: "0.9.0" }, canWrite), /older than/);
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
    assert.equal((db.prepare("SELECT reply FROM remote_calls WHERE id = ?").get(lease.id) as { reply: string | null }).reply, null, "the raw reply is not kept");
    assert.equal(r?.usage.input, 90);
    assert.deepEqual(r?.usage.extra?.map((e) => [e.model, e.usage.input]), [["haiku", 10]]);
    const run = db.prepare("SELECT state, user_login, harness, reported_model, account_id, cost_usd FROM agent_runs WHERE id = (SELECT run_id FROM remote_calls WHERE id = ?)").get(lease.id) as Record<string, unknown>;
    assert.deepEqual({ ...run }, { state: "done", user_login: "bob", harness: "claude", reported_model: "opus", account_id: null, cost_usd: 0.25 });
  });

  test("with no other helper asking for work, the PR's author gets the review", async () => {
    db.prepare("UPDATE mcp_tokens SET idle_claim_at = NULL").run();
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const lease = (await leaseFor("alice"))!;
    assert.ok(lease, "the author's helper takes it");
    done(lease.secret, "by the author");
    assert.equal((await ask)?.text, "by the author");
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

  test("the session tools count what the login may claim, and show a lease only to its holder", async () => {
    const env = (login: string, run = true): McpEnv => ({
      db, baseUrl: null, limiter: new RateLimiter(10, 60_000), canAnswer: false, expensive: () => 0,
      user: () => ({ login, role: "maintainer" }) as unknown as User,
      ...(run && { run: { tokenId: callers[login]!.tokenId, canWrite } }),
    });
    const call = async (e: McpEnv, name: string, args: unknown = {}) => {
      const r = (await handleMcp(e, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }))!.result as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError === true };
    };
    const names = async (e: McpEnv) => ((await handleMcp(e, { jsonrpc: "2.0", id: 1, method: "tools/list" }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.ok((await names(env("bob"))).includes("next_task"));
    assert.ok(!(await names(env("bob", false))).includes("next_task"), "not offered without can_run in user-local mode");
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    while (!db.prepare("SELECT 1 FROM remote_calls WHERE state = 'queued'").get()) await sleep(5);
    idle("bob");
    assert.match((await call(env("alice"), "next_task")).text, /^No call is queued/, "the PR's author, while bob's helper is idle");
    assert.match((await call(env("bob"), "next_task", { tiers: ["mid"] })).text, /^No call is queued/, "wrong tier");
    const queued = await call(env("bob"), "next_task");
    assert.match(queued.text, /^1 call is queued/);
    assert.match(queued.text, /autocraft-task run --detach/);
    assert.ok(db.prepare("SELECT 1 FROM remote_calls WHERE state = 'queued'").get(), "next_task leases nothing");
    const lease = (await leaseFor("bob"))!;
    assert.match((await call(env("bob"), "task_status", { lease: String(lease.id) })).text, /: leased$/);
    assert.equal((await call(env("alice"), "task_status", { lease: String(lease.id) })).isError, true, "another login's lease");
    assert.match((await call(env("bob"), "my_work")).text, /review\.opus/);
    done(lease.secret, "ok");
    await ask;
  });
});
