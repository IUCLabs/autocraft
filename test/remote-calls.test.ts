// The user-local inference mode: askClaude queues a remote call, a helper claims it, fetches the bundle and submits, and
// askClaude returns the reply. A lease without heartbeats goes back to the queue; the item's authors never get a judging call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { askClaude } from "../src/classify/run.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { noteLine } from "../src/github/note.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { User } from "../src/dash/types.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { bundleOf, claimableCalls, claimCall, CLAIM_RETRY_S, expireLeases, heartbeat, withdrawCall, submitCall, type Caller } from "../src/remote/calls.ts";
import { clearCooloff } from "../src/remote/cooloff.ts";
import * as userSettings from "../src/dash/api/user-settings.ts";
import type { Req } from "../src/dash/types.ts";
import { listHelpers, parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { setAcceptedModels, setInferenceMode } from "../src/remote/mode.ts";
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
  const claim: Claim = { protocol: PROTOCOL_VERSION, helperVersion: "1.1.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } };
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
  const req = (login: string, role: string, json?: unknown) => ({ user: { login, role, canWrite: async () => true }, json }) as unknown as Req;
  const done = (secret: string, text: string) => submitCall(db, secret, { ok: true, text, model: "claude-opus-4-5", usage: { inputTokens: 100, outputTokens: 20 }, modelUsage: { "claude-opus-4-5": { inputTokens: 90, outputTokens: 15 }, "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 } }, costUsd: 0.25,
    tools: [{ name: "mcp__items__item", args: '{"ref":"photocraft#1"}', resultBytes: 300, isError: false, startedAt: "2026-11-19T10:00:00.000Z", endedAt: "2026-11-19T10:00:01.000Z" }], durationMs: 1000 });

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
    assert.equal(r?.model, "claude-opus-4-5", "the stage learns the model that ran");
    assert.equal(noteLine({ by: "model", kind: "review", model: r?.model }), "_AI-generated review (Claude Opus 4.5). Not a maintainer decision._");
    assert.equal(noteLine({ by: "model", kind: "review", model: "gpt-6.2-astra" }), "_AI-generated review (Codex Astra 6.2). Not a maintainer decision._");
    assert.equal(noteLine({ by: "model", kind: "review", model: "opus" }), "_AI-generated review (Opus). Not a maintainer decision._", "a server call names the prompt's model as before");
    assert.equal((db.prepare("SELECT reply FROM remote_calls WHERE id = ?").get(lease.id) as { reply: string | null }).reply, null, "the raw reply is not kept");
    assert.equal(r?.usage.input, 90);
    assert.deepEqual(r?.usage.extra?.map((e) => [e.model, e.usage.input]), [["haiku", 10]]);
    const run = db.prepare("SELECT state, user_login, harness, reported_model, account_id, cost_usd FROM agent_runs WHERE id = (SELECT run_id FROM remote_calls WHERE id = ?)").get(lease.id) as Record<string, unknown>;
    assert.deepEqual({ ...run }, { state: "done", user_login: "bob", harness: "claude", reported_model: "claude-opus-4-5", account_id: null, cost_usd: 0.25 });
    const tool = db.prepare("SELECT seq, tool, args, result_bytes, started_at FROM agent_run_tools WHERE run_id = (SELECT run_id FROM remote_calls WHERE id = ?)").get(lease.id) as Record<string, unknown>;
    assert.deepEqual({ ...tool }, { seq: 1, tool: "mcp__items__item", args: '{"ref":"photocraft#1"}', result_bytes: 300, started_at: "2026-11-19T10:00:00.000Z" });
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

  test("three lost leases within two hours cool a token off for six hours; its next claim says why and until when; an operator clears it", async () => {
    db.prepare("INSERT INTO access (login, role) VALUES ('erin', 'maintainer')").run();
    const erin: Caller = { tokenId: createToken(db, "erin", "helper", false, true).row.id, login: "erin", role: "maintainer" };
    const mine = async () => (await claimCall(db, erin, claim, canWrite)).lease;
    const lose = (id: number, now: number) => {
      db.prepare("UPDATE remote_calls SET heartbeat_at = ? WHERE id = ?").run(now - 3 * 60000, id);
      expireLeases(db, now);
    };
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const t0 = Date.now();
    let lease = null;
    for (let i = 0; i < 200 && !lease; i++) { lease = await mine(); if (!lease) await sleep(5); }
    lose(lease!.id, t0);
    const again = (await mine())!;
    assert.equal(again.id, lease!.id, "a lost lease is not a failed call: the call goes back to the queue");
    lose(again.id, t0 + 1000);
    assert.equal(await ask, null, "the call used its attempts");
    const ask2 = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    let third = null;
    for (let i = 0; i < 200 && !third; i++) { third = await mine(); if (!third) await sleep(5); }
    lose(third!.id, t0 + 2000);
    const reply = await claimCall(db, erin, claim, canWrite, t0 + 3000);
    assert.equal(reply.lease, null);
    assert.equal(reply.lease === null && reply.until, t0 + 2000 + 6 * 3600_000);
    assert.match(reply.lease === null ? reply.reason ?? "" : "", /3 times within 2 hours/);
    assert.equal(clearCooloff(db, "erin", "test"), 1);
    assert.ok((await claimCall(db, erin, claim, canWrite, t0 + 3000)).lease, "the call is back in the queue for the cleared helper");
    withdrawCall(db, (db.prepare("SELECT id FROM remote_calls WHERE state IN ('queued','leased') ORDER BY id DESC LIMIT 1").get() as { id: number }).id, "test over");
    await ask2;
  });

  test("a claim whose declared effort is below a tier's minimum gets nothing, and the refusal names the families and the floor", async () => {
    setAcceptedModels(db, undefined, "test", { top: "high" });
    const claimant = callers.bob!;
    await assert.rejects(claimCall(db, claimant, claim, canWrite), /opus\/astra at effort high or higher/);
    await assert.rejects(claimCall(db, claimant, { ...claim, efforts: { top: "medium" } }, canWrite), /at effort high or higher/);
    assert.equal((await claimCall(db, claimant, { ...claim, efforts: { top: "xhigh" } }, canWrite)).lease, null, "meets the floor; nothing is queued");
    setAcceptedModels(db, undefined, "test", { top: "max" });
    const codex: Claim = { ...claim, harness: "codex", tiers: { top: "gpt-6-astra" }, efforts: { top: "xhigh" } };
    assert.equal((await claimCall(db, claimant, codex, canWrite)).lease, null, "Codex's top level, xhigh, meets a max floor");
    await assert.rejects(claimCall(db, claimant, { ...claim, efforts: { top: "xhigh" } }, canWrite), /effort max/);
    setAcceptedModels(db, undefined, "test", { top: null });
    assert.equal((await claimCall(db, claimant, claim, canWrite)).lease, null, "no floor: any helper");
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
    assert.match((await call(env("bob"), "next_task", { models: { top: "gpt-5" } })).text, /^No call is queued/, "a model outside the accepted families");
    assert.match((await call(env("bob"), "next_task", { models: { top: "claude-opus-4-5" } })).text, /^1 call is queued/);
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

  test("a user sets their own usage reserve, the claim reply carries it, and only a helper that reported ready is room", async () => {
    assert.deepEqual((await userSettings.settings(db, req("bob", "maintainer"))).reserve, { fiveHour: 20, weekly: 20 }, "the default");
    await userSettings.setSettings(db, req("bob", "maintainer", { reserve: { fiveHour: 35, weekly: 10 } }));
    assert.deepEqual((await userSettings.settings(db, req("bob", "maintainer"))).reserve, { fiveHour: 35, weekly: 10 });
    assert.deepEqual((await userSettings.settings(db, req("carol", "maintainer"))).reserve, { fiveHour: 20, weekly: 20 }, "another user's is their own");
    await assert.rejects(userSettings.setSettings(db, req("bob", "maintainer", { reserve: { fiveHour: 95, weekly: 10 } })), /0 to 90/);
    await assert.rejects(userSettings.setSettings(db, req("eve", "viewer", { reserve: { fiveHour: 30, weekly: 30 } })), /viewers/);
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'usage-reserve' AND login = 'bob'").get());
    assert.deepEqual(await claimCall(db, callers.bob!, claim, canWrite), { lease: null, retryAfter: CLAIM_RETRY_S, reserve: { fiveHour: 35, weekly: 10 } });
    assert.equal(remoteRoom(db, 0), 0, "an idle helper that never reported ready");
    const status = { harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 35, weekly: 10 }, usage: { fiveHour: { usedPercent: 70, resetsAt: null }, weekly: null, at: new Date().toISOString() } };
    storeStatus(db, callers.bob!.tokenId, "bob", parseStatus({ ...status, readiness: "ready" }));
    assert.equal(remoteRoom(db, 0), 1);
    storeStatus(db, callers.bob!.tokenId, "bob", parseStatus({ ...status, readiness: "quota-held", until: "2026-11-20T01:30:00.000Z", reason: "5-hour window 70% used" }));
    assert.equal(remoteRoom(db, 0), 0, "held by its plan usage");
    const [h] = listHelpers(db, "bob");
    assert.equal(h?.readiness, "quota-held");
    assert.equal(h?.fresh, true);
    assert.equal(h?.usage?.fiveHour?.usedPercent, 70);
    db.prepare("UPDATE mcp_tokens SET cooloff_until = ? WHERE id = ?").run(Date.now() + 3600_000, callers.bob!.tokenId);
    assert.equal(listHelpers(db, "bob")[0]?.readiness, "cooled-off", "the server's cool-off shows before the helper reports it");
    db.prepare("UPDATE mcp_tokens SET cooloff_until = NULL WHERE id = ?").run(callers.bob!.tokenId);
  });

  test("a user's repo picks limit their claims and next_task; the helper's own list narrows them, never widens them", async () => {
    db.prepare("UPDATE mcp_tokens SET idle_claim_at = NULL, cooloff_until = NULL").run();
    db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1), ('fontcraft', 1), ('gridcraft', 0) ON CONFLICT (name) DO UPDATE SET pipeline = excluded.pipeline").run();
    const pick = (repos: string[]) => userSettings.setSettings(db, req("bob", "maintainer", { repos }));
    const got = await pick(["fontcraft", "gridcraft"]);
    assert.deepEqual([got.repos, got.repoChoices], [["fontcraft", "gridcraft"], ["fontcraft", "photocraft"]], "picks are kept; choices are the pipeline-on repos");
    await assert.rejects(pick(["nosuchrepo"]), /not tracked/);
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    while (!db.prepare("SELECT 1 FROM remote_calls WHERE state = 'queued'").get()) await sleep(5);
    assert.equal((await claimCall(db, callers.bob!, claim, canWrite)).lease, null, "photocraft is not picked");
    assert.equal((db.prepare("SELECT idle_repos FROM mcp_tokens WHERE id = ?").get(callers.bob!.tokenId) as { idle_repos: string }).idle_repos, '["fontcraft","gridcraft"]', "the idle helper records what it takes");
    assert.equal(await claimableCalls(db, callers.bob!, {}, canWrite), 0);
    await pick(["photocraft"]);
    assert.equal(await claimableCalls(db, callers.bob!, {}, canWrite), 1);
    assert.equal((await claimCall(db, callers.bob!, { ...claim, repos: ["fontcraft"] }, canWrite)).lease, null, "the helper's list narrows");
    assert.equal((db.prepare("SELECT idle_repos FROM mcp_tokens WHERE id = ?").get(callers.bob!.tokenId) as { idle_repos: string }).idle_repos, "[]");
    const lease = (await claimCall(db, callers.bob!, { ...claim, repos: ["photocraft", "fontcraft"] }, canWrite)).lease!;
    assert.match(lease.title, /photocraft#1287/);
    done(lease.secret, "picked");
    assert.equal((await ask)?.text, "picked");
    await pick([]);
  });
});
