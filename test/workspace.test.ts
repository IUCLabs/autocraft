// The workspace of Opus calls: one checkout per tracked repository and head,
// rebuilt when the head moves, the previous one mounted while a new one is not
// ready; the exclusion setting; usage of a subagent model.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resultUsage, saveUsage, add } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { WorkspaceCache, setWorkspaceExcluded, workspaceCheckouts, workspaceExcluded, type WorkspaceDeps } from "../src/sandbox/workspace.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "workspace-"));
const quiet = () => {};

function setup(repos: string[]) {
  const db = connect(join(mkdtempSync(join(root, "db-")), "t.db"));
  db.exec("DELETE FROM tracked_repos");
  for (const r of repos) db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(r);
  const heads = new Map<string, string>(repos.map((r) => [r, "a".repeat(40)]));
  let clock = 0;
  const built: string[] = [];
  let hold: Promise<void> | null = null;
  const deps: WorkspaceDeps = {
    headOf: async (r) => heads.get(r) ?? null,
    checkout: async (r, _b, sha) => {
      if (hold) await hold;
      const dir = join(root, r, sha);
      mkdirSync(dir, { recursive: true });
      built.push(`${r}@${sha[0]}`);
      return dir;
    },
    now: () => clock, boundMs: 30, headTtlMs: 1000, keepMs: 5000,
  };
  return { db, heads, deps, built, tick: (ms: number) => { clock += ms; }, holdBuilds: () => { let go!: () => void; hold = new Promise<void>((r) => { go = r; }); return () => { hold = null; go(); }; } };
}

describe("workspace checkouts", () => {
  test("one checkout per tracked repository, reused while its head is unchanged", async () => {
    const t = setup(["beta", "alpha"]);
    const c = new WorkspaceCache();
    const first = await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.deepEqual(first.map((x) => x.name), ["alpha", "beta"]);
    t.tick(2000);
    await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.equal(t.built.length, 2, "same head: nothing rebuilt");
  });

  test("a checkout whose main head moved is replaced and the superseded one is removed after the keep time", async () => {
    const t = setup(["alpha"]);
    const c = new WorkspaceCache();
    const [old] = await workspaceCheckouts(t.db, quiet, t.deps, c);
    t.heads.set("alpha", "b".repeat(40));
    t.tick(2000);
    const [fresh] = await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.notEqual(fresh!.dir, old!.dir);
    assert.ok(fresh!.dir.endsWith("b".repeat(40)));
    assert.ok(existsSync(old!.dir), "a running call may still mount it");
    t.tick(6000);
    t.heads.set("alpha", "c".repeat(40));
    await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.ok(!existsSync(old!.dir), "removed once past the keep time");
  });

  test("a call does not wait for a slow rebuild: it mounts the previous checkout", async () => {
    const t = setup(["alpha"]);
    const c = new WorkspaceCache();
    const [old] = await workspaceCheckouts(t.db, quiet, t.deps, c);
    t.heads.set("alpha", "b".repeat(40));
    t.tick(2000);
    const release = t.holdBuilds();
    const [during] = await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.equal(during!.dir, old!.dir);
    release();
    await new Promise((r) => setTimeout(r, 20));
    t.tick(2000);
    const [after] = await workspaceCheckouts(t.db, quiet, t.deps, c);
    assert.ok(after!.dir.endsWith("b".repeat(40)));
  });

  test("a repository with no checkout yet is left out, and excluded repositories are never mounted", async () => {
    const t = setup(["alpha", "beta", "gamma"]);
    t.heads.delete("gamma");
    assert.deepEqual(workspaceExcluded(t.db), []);
    setWorkspaceExcluded(t.db, ["beta"], "test");
    const got = await workspaceCheckouts(t.db, quiet, t.deps, new WorkspaceCache());
    assert.deepEqual(got.map((x) => x.name), ["alpha"]);
    assert.throws(() => setWorkspaceExcluded(t.db, ["../x"], "test"));
  });
});

describe("usage of a call with a subagent", () => {
  const result = {
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, total_cost_usd: 0.5,
    modelUsage: {
      "claude-opus-4-7": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, costUSD: 0.45 },
      "claude-haiku-4-5": { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05 },
    },
  };

  test("the called model keeps its own tokens; the other model is recorded separately; the run sums both", () => {
    const { usage, all } = resultUsage(result, "opus");
    assert.deepEqual([usage.input, usage.output, usage.cost], [10, 5, 0.45]);
    assert.deepEqual(usage.extra, [{ model: "haiku", usage: { input: 300, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.05 } }]);
    assert.deepEqual(all, { input: 310, output: 45, cacheRead: 100, cacheWrite: 20 });
    const plain = resultUsage({ usage: result.usage, total_cost_usd: 0.5 }, "opus");
    assert.equal(plain.usage.extra, undefined);
    assert.equal(plain.usage.cost, 0.5);
  });

  test("saveUsage writes a row per model with the same run and stage, so cost totals stay whole", () => {
    const db = connect(join(mkdtempSync(join(root, "db-")), "t.db"));
    const u = add(resultUsage(result, "opus").usage, resultUsage(result, "opus").usage);
    saveUsage(db, "run1", "opus-x", "review", "opus", 1, u, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z");
    const rows = db.prepare("SELECT agent, model, stage, input_tokens AS i, cost_usd AS c FROM token_usage WHERE run_id = 'run1' ORDER BY model").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { agent: "opus-x+haiku", model: "haiku", stage: "review", i: 600, c: 0.1 },
      { agent: "opus-x", model: "opus", stage: "review", i: 20, c: 0.9 },
    ]);
  });
});
