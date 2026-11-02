// Claude accounts, allocation, agent-run recording, the agents/accounts/rates API and retention.
// Model calls go to a fake runner; no account directory exists behind the fake box config.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { chooseAccount, claudePauseReason, freeSlots, jevParallel, listAccounts, recordUsageSamples, setJevParallel, updateAccount } from "../src/agents/accounts.ts";
import { allocation, claudeRoom, setCallContext, startClaudeRun } from "../src/agents/call.ts";
import { getRun, listRuns, pruneRuns, rates } from "../src/agents/runs.ts";
import { askClaude, askJev, pool, setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import * as api from "../src/dash/api/agents.ts";
import { pauseReason } from "../src/runner/autopilot.ts";
import { getJob } from "../src/runner/jobs.ts";
import type { Req } from "../src/dash/types.ts";
import { setupBox, writeReading } from "./accounts-fixture.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
const fresh = (ids: string[] = ["a", "b"]) => {
  const box = setupBox(ids);
  const db = connect(join(mkdtempSync(join(SCRATCH, "agents-test-")), "t.db"));
  return { box, db };
};
const enable = (db: ReturnType<typeof connect>, id: string, max = 2) => {
  listAccounts(db);
  db.prepare("UPDATE claude_accounts SET enabled = 1, max_concurrent = ? WHERE id = ?").run(max, id);
};
const idOf = (c: ReturnType<typeof chooseAccount>) => ("account" in c ? c.account.id : "wait" in c ? `wait:${c.wait}` : "none");
const item = { repo: "photocraft", number: 1, kind: "issue" as const, title: "T", body: "B", lines_changed: null, files_changed: null, author_association: null };

describe("allocation", () => {
  test("no enabled account: none; a Claude call fails with a clear message", async () => {
    const { db } = fresh();
    assert.equal(idOf(chooseAccount(db)), "none");
    assert.match(claudePauseReason(db) ?? "", /no Claude account is enabled/);
    await assert.rejects(startClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" }), /no Claude account is enabled/);
  });

  test("prefers the lowest weekly use; skips accounts without headroom, without a free slot or disabled", () => {
    const { db, box } = fresh(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) enable(db, id);
    writeReading(box, "a", { week: 40 });
    writeReading(box, "b", { week: 20 });
    writeReading(box, "c", { week: 10, five: 92 });
    assert.equal(idOf(chooseAccount(db)), "b");
    writeReading(box, "b", { week: 96 });
    assert.equal(idOf(chooseAccount(db)), "a");
    db.prepare("UPDATE claude_accounts SET enabled = 0 WHERE id = 'a'").run();
    assert.match(idOf(chooseAccount(db)), /^wait:.*weekly use 96 %.*5-hour use 92 %/);
    assert.match(claudePauseReason(db) ?? "", /no Claude account has headroom/);
  });

  test("a full account is skipped and a stale reading counts as unknown", () => {
    const { db, box } = fresh(["a", "b"]);
    enable(db, "a", 1);
    enable(db, "b", 1);
    writeReading(box, "a", { week: 10 });
    writeReading(box, "b", { week: 50, five: 99, at: Math.floor(Date.now() / 1000) - 31 * 60 });
    db.prepare("INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, account_id, state, started_at) VALUES ('decide', 3, 'p', 'v', 'claude', 'sonnet', 'a', 'running', ?)").run(new Date().toISOString());
    assert.equal(idOf(chooseAccount(db)), "b");           // b's 99 % reading is 31 minutes old
    assert.equal(claudePauseReason(db), null);
    assert.equal(listAccounts(db).find((a) => a.id === "a")!.running, 1);
  });

  test("waits for a slot, then proceeds; a cancel while waiting stops", async () => {
    const { db } = fresh(["a"]);
    enable(db, "a", 1);
    allocation.pollMs = 10;
    const busy = await startClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" }, () => {});
    let second: number | null = null;
    const waiting = startClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" }, () => {}).then((r) => (second = r.runId));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(second, null);
    db.prepare("UPDATE agent_runs SET state = 'done' WHERE id = ?").run(busy.runId);
    await waiting;
    assert.ok(second);
    let cancel = false;
    setCallContext({ jobId: 1, step: "decide", stage: 3, cancelled: () => cancel });
    try {
      const stuck = startClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" }, () => {});
      cancel = true;
      await assert.rejects(stuck, /cancelled while waiting/);
    } finally {
      setCallContext(null);
    }
  });

  test("free slots add up over enabled accounts with headroom; up to 100 slots per account", () => {
    const { db, box } = fresh(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) enable(db, id, 4);
    updateAccount(db, "a", { maxConcurrent: 100 }, "op");
    writeReading(box, "c", { five: 95 });
    assert.equal(freeSlots(db), 104);
    db.prepare("INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, account_id, state, started_at) VALUES ('decide', 3, 'p', 'v', 'claude', 'sonnet', 'b', 'running', ?)").run(new Date().toISOString());
    assert.equal(freeSlots(db), 103);
    assert.equal(jevParallel(db), 4);
    setJevParallel(db, 12, "op");
    assert.equal(jevParallel(db), 12);
    assert.throws(() => setJevParallel(db, 0, "op"), /1 to 100/);
  });

  test("a pool of model calls follows the free slots, never exceeds them, and starts the first call alone", async () => {
    const { db } = fresh(["a", "b"]);
    enable(db, "a", 3);
    enable(db, "b", 2);
    const input: Parameters<typeof startClaudeRun>[1] = { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" };
    let inFlight = 0, peak = 0, firstDone = false, startedBeforeFirst = 0;
    const job = (n: number) => async () => {
      if (!firstDone) startedBeforeFirst++;
      const c = await startClaudeRun(db, input, () => {});
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      db.prepare("UPDATE agent_runs SET state = 'done' WHERE id = ?").run(c.runId);
      inFlight--;
      if (n === 0) firstDone = true;
      return n;
    };
    allocation.pollMs = 5;
    const out = await pool(Array.from({ length: 12 }, (_, n) => job(n)), () => claudeRoom(db), { first: true, pollMs: 5 });
    assert.deepEqual(out, Array.from({ length: 12 }, (_, n) => n));
    assert.equal(peak, 5);
    assert.equal(startedBeforeFirst, 1);
    // fewer items than slots: only as many calls as items
    peak = 0;
    await pool([job(1), job(2)], () => claudeRoom(db), { pollMs: 5 });
    assert.equal(peak, 2);
  });

  test("a pool with no enabled account still starts a call, which reports the missing account", async () => {
    const { db } = fresh(["a"]);
    const call = () => startClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" }, () => {});
    await assert.rejects(pool([call, call], () => claudeRoom(db), { pollMs: 5 }), /no Claude account is enabled/);
  });

  test("Claude steps pause when no account has headroom; Jev-only and local steps do not", () => {
    const { db, box } = fresh(["a"]);
    assert.match(pauseReason(db, "decide") ?? "", /no Claude account is enabled/);
    assert.match(pauseReason(db, "classify-new") ?? "", /no Claude account is enabled/);
    assert.equal(pauseReason(db, "embed"), null);
    enable(db, "a");
    writeReading(box, "a", { five: 91 });
    assert.match(pauseReason(db, "review-batch") ?? "", /5-hour use 91 % \(pauses at 90 %\)/);
    writeReading(box, "a", { five: 20 });
    assert.equal(pauseReason(db, "review-batch"), null);
  });
});

describe("agent runs", () => {
  const ok = (text: string): Runner => async () => ({ code: 0, stdout: JSON.stringify({ type: "result", result: text, usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }), stderr: "" });

  test("a Claude call is recorded from start to end on the chosen account, with CLAUDE_CONFIG_DIR for that child only", async () => {
    const { db, box } = fresh(["a"]);
    enable(db, "a");
    writeReading(box, "a", {});
    const before = process.env.CLAUDE_CONFIG_DIR;
    let seenEnv: Record<string, string> | undefined, running = -1;
    const restore = setRunner(async (cmd, args, input, cwd, t, env) => {
      seenEnv = env;
      running = (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE state = 'running'").get() as { n: number }).n;
      return ok(JSON.stringify([{ ref: "photocraft#1", type_label: "bugfix" }]))(cmd, args, input, cwd, t, env);
    });
    setCallContext({ jobId: 7, step: "classify-new", stage: 2, cancelled: () => false });
    try {
      const r = await askClaude("classify.haiku", "haiku", [item], db);
      assert.ok(r);
    } finally {
      restore();
      setCallContext(null);
    }
    assert.equal(running, 1);
    assert.equal(seenEnv?.CLAUDE_CONFIG_DIR, `${box.configDir}a`);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
    const run = getRun(db, 1);
    assert.equal(run.state, "done");
    assert.deepEqual([run.jobId, run.step, run.stage, run.provider, run.model, run.accountId], [7, "classify-new", 2, "claude", "haiku", "a"]);
    assert.deepEqual(run.items, [{ repo: "photocraft", number: 1 }]);
    assert.deepEqual([run.inputTokens, run.outputTokens, run.cacheReadTokens, run.cacheWriteTokens], [11, 7, 3, 2]);
    assert.equal(run.summary, "1 of 1 answered: 1 bugfix");
    assert.match(run.prompt ?? "", /You classify GitHub issues/);
    assert.match(run.output ?? "", /bugfix/);
  });

  test("a failed call is recorded as failed; the error never holds the config directory", async () => {
    const { db, box } = fresh(["a"]);
    enable(db, "a");
    const restore = setRunner(async () => ({ code: 1, stdout: "", stderr: `cannot read ${box.configDir}a/credentials` }));
    try {
      assert.equal(await askClaude("classify.haiku", "haiku", [item], db), null);
    } finally {
      restore();
    }
    const run = getRun(db, 1);
    assert.equal(run.state, "failed");
    assert.ok(run.error && !run.error.includes(box.dir));
    assert.match(run.error ?? "", /\[config dir\]/);
  });

  test("a Jev call is recorded without an account", async () => {
    const { db } = fresh(["a"]);
    const restore = setRunner(async () => ({ code: 0, stdout: JSON.stringify({ answers: {}, usage: { input_tokens: 5, output_tokens: 1 } }), stderr: "" }));
    try {
      await askJev("classify.jev", item, db);
    } finally {
      restore();
    }
    const run = getRun(db, 1);
    assert.deepEqual([run.provider, run.model, run.accountId, run.accountLabel, run.state, run.inputTokens], ["jev", "jev", null, null, "done", 5]);
  });
});

describe("API", () => {
  const user = (role: "operator" | "viewer") => ({ login: `${role}-1`, role, canWrite: async () => false, canRead: async () => true });
  const req = (role: "operator" | "viewer", query = "", params: Record<string, string> = {}, json?: unknown): Req =>
    ({ method: "GET", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(), json, user: user(role), csrf: "", nonce: "" });

  test("accounts: labels and ids only, never a path; viewers see enabled ones; changes are audited", () => {
    const { db, box } = fresh(["a", "b"]);
    const out = updateAccount(db, "b", { enabled: true, label: "Main", maxConcurrent: 3 }, "op");
    assert.deepEqual([out.id, out.label, out.enabled, out.maxConcurrent], ["b", "Main", true, 3]);
    assert.ok(!JSON.stringify(api.accounts(db, req("operator"))).includes(box.dir));
    assert.deepEqual(api.accounts(db, req("viewer")).map((a) => a.id), ["b"]);
    assert.deepEqual(api.accounts(db, req("operator")).map((a) => a.id), ["a", "b"]);
    const a = db.prepare("SELECT login, action, target FROM audit").all() as object[];
    assert.deepEqual(a.map((x) => ({ ...x })), [{ login: "op", action: "account-change", target: "account:b" }]);
    for (const bad of [{ label: "me@example.org" }, { label: "" }, { maxConcurrent: 0 }, { maxConcurrent: 101 }, { enabled: "yes" }, { configDir: "/x" }]) {
      assert.throws(() => updateAccount(db, "b", bad, "op"), /./, JSON.stringify(bad));
    }
    assert.throws(() => updateAccount(db, "zzz", {}, "op"), /no such account/);
  });

  test("agents: newest first with a keyset cursor, filters, bounded params", async () => {
    const { db } = fresh(["a"]);
    enable(db, "a");
    const ins = db.prepare("INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, account_id, items, item_count, state, started_at) VALUES (?, 2, 'p', 'v', 'claude', 'haiku', ?, ?, 1, ?, ?)");
    const link = db.prepare("INSERT INTO agent_run_items (run_id, repo, number) VALUES (?, ?, ?)");
    for (let i = 1; i <= 25; i++) {
      const repo = i % 5 === 0 ? "filmcraft" : "photocraft";
      const id = Number(ins.run(i % 2 ? "decide" : "classify-new", i % 3 ? "a" : null, JSON.stringify([{ repo, number: i }]), i === 25 ? "running" : i % 4 ? "done" : "failed", `2026-11-01T00:00:${String(i).padStart(2, "0")}.000Z`).lastInsertRowid);
      link.run(id, repo, i);
    }
    const first = listRuns(db, { limit: 10 });
    assert.deepEqual(first.runs.map((r) => r.id), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    const second = listRuns(db, { limit: 10, cursor: first.nextCursor! });
    assert.deepEqual(second.runs.map((r) => r.id), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    assert.equal(listRuns(db, { limit: 10, cursor: listRuns(db, { limit: 10, cursor: second.nextCursor! }).runs.at(-1)!.id.toString() }).nextCursor, null);
    assert.deepEqual(listRuns(db, { state: "running" }).runs.map((r) => r.id), [25]);
    assert.deepEqual(listRuns(db, { repo: "filmcraft", limit: 3 }).runs.map((r) => r.id), [25, 20, 15]);
    assert.deepEqual(listRuns(db, { repo: "filmcraft", state: "failed" }).runs.map((r) => r.id), [20]);
    assert.ok(listRuns(db, { step: "decide" }).runs.every((r) => r.step === "decide"));
    assert.ok(listRuns(db, { account: "a" }).runs.every((r) => r.accountLabel === "a"));
    assert.deepEqual(await api.list(db, req("viewer", "state=done&limit=2")), listRuns(db, { state: "done", limit: 2 }));
    for (const q of ["state=x", "limit=0", "limit=201", "limit=a", "cursor=1;drop", "step=A%20B", "repo=a/b", "account=../x"]) {
      await assert.rejects(api.list(db, req("viewer", q)), /./, q);
    }
    await assert.rejects(api.detail(db, req("viewer", "", { id: "99999" })), /no agent run/);
  });

  test("rates: items per stage by hour, usage samples for enabled accounts; jobs list the models and accounts", async () => {
    const { db, box } = fresh(["a"]);
    enable(db, "a");
    const now = Date.parse("2026-11-02T10:30:00Z");
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, items) VALUES ('decide', '{}', 'op', ?, 'done', '2026-11-02T10:05:00.000Z', 12)").run("2026-11-02T10:00:00Z");
    db.prepare("INSERT INTO agent_runs (job_id, step, stage, prompt_id, prompt_version, provider, model, account_id, state, started_at) VALUES (1, 'decide', 3, 'p', 'v', 'claude', 'sonnet', 'a', 'failed', '2026-11-02T10:06:00.000Z')").run();
    writeReading(box, "a", { at: Math.floor(now / 1000) - 600, five: 33, week: 12 });
    assert.equal(recordUsageSamples(db, now), 1);
    assert.equal(recordUsageSamples(db, now), 0);
    const r = await rates(db, "24h", now);
    const decide = r.stages.find((s) => s.step === "decide")!;
    assert.equal(decide.buckets.length, 24);
    assert.deepEqual(decide.buckets.at(-1), { t: "2026-11-02T10:00:00.000Z", items: 12, runs: 1, failed: 1 });
    assert.deepEqual(r.accounts[0]!.samples.map((x) => ({ ...x })), [{ t: "2026-11-02T10:00:00.000Z", fiveHourPct: 33, weeklyPct: 12 }]);
    assert.equal((await rates(db, "7d", now)).stages[0]!.buckets.length, 7);
    await assert.rejects(rates(db, "30d", now), /window/);
    const job = getJob(db, 1);
    assert.deepEqual([job.models, job.accounts], [["sonnet"], ["a"]]);
  });

  test("retention: texts go after 14 days, runs after 90", () => {
    const { db } = fresh(["a"]);
    const day = 86_400_000, now = Date.now();
    const ins = db.prepare("INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, state, started_at) VALUES ('decide', 3, 'p', 'v', 'claude', 'sonnet', 'done', ?)");
    for (const age of [100, 20, 1]) {
      const id = Number(ins.run(new Date(now - age * day).toISOString()).lastInsertRowid);
      db.prepare("INSERT INTO agent_run_texts (run_id, prompt, output) VALUES (?, 'p', 'o')").run(id);
      db.prepare("INSERT INTO agent_run_items (run_id, repo, number) VALUES (?, 'r', 1)").run(id);
    }
    assert.deepEqual(pruneRuns(db, now), { texts: 2, runs: 1 });
    assert.equal(getRun(db, 2).prompt, null);
    assert.equal(getRun(db, 3).prompt, "p");
    assert.equal(getRun(db, 2).state, "done");
    assert.throws(() => getRun(db, 1), /no agent run/);
  });
});
