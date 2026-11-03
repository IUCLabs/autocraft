import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { activeBatches, admits, batchSizeOf, membersOf, setBatchSize } from "../src/merge/batch-store.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { finalizeReviews } from "./fixture.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "batch-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const MAIN = "a".repeat(40);
const MAIN2 = "b".repeat(40);

function fresh(prs: { n: number; author?: string }[]): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  for (const p of prs) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES ('app', ?, 'pr', 'OPEN', ?, ?, 20, 0, ?, '${T0}', '${T0}')`).run(p.n, `PR ${p.n}`, p.author ?? "regular", `sha${p.n}`);
    db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run(p.n);
    db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'S', 'take', 'ok', NULL)`).run(p.n, `sha${p.n}`);
    db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', ?, ?, 'tests', 'r', 'passed', '${T0}')`).run(p.n, `sha${p.n}`);
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(p.n, `sha${p.n}`);
  }
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO main.settings (key, value) VALUES ('merge_approved:app', ?)").run(JSON.stringify({ by: "op", at: T0 }));
  finalizeReviews(db);
  return db;
}

type World = { log: string[]; conflicts: Set<string>; mainHead: string; ci: "SUCCESS" | "FAILURE" | "PENDING"; mergeExit: number; tip: Map<string, string> };
const world = (): World => ({ log: [], conflicts: new Set(), mainHead: MAIN, ci: "SUCCESS", mergeExit: 0, tip: new Map() });

function deps(w: World, root: string): BatchDeps {
  let commits = 0;
  const querier: Querier = {
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number };
      if (query.includes("viewer")) return { viewer: { login: "bot", id: "U1" } };
      if (query.startsWith("mutation")) return { addAssigneesToAssignable: {} };
      const head = (n: number) => w.tip.get("tip") ?? `sha${n}`;
      if (v.n !== undefined) return { repository: { pullRequest: { id: `PR${v.n}`, headRefOid: head(v.n), state: "OPEN", assignees: { nodes: [] }, commits: { totalCount: 1, nodes: [] } } } };
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { repository: Object.fromEntries(nums.map((x) => [`pr${x}`, {
        number: x, state: "OPEN", isDraft: false, headRefOid: head(x), mergeable: "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: w.ci === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: w.ci === "PENDING" ? null : w.ci }] } } } }] },
      }])) };
    },
  };
  return {
    querier, root, mergeCommand: "safe-merge-test", now: () => new Date(T1),
    mainHead: async () => w.mainHead,
    summarise: async (_db, v) => `summary for ${v.number}`,
    async run(cmd, args) { w.log.push(`${cmd} ${args.join(" ")}`); return { code: w.mergeExit, stdout: "", stderr: w.mergeExit ? "not mergeable" : "" }; },
    async exec(cmd, args, opts) {
      const a = [...args];
      if (cmd === "git") { while (a[0] === "-c") a.splice(0, 2); }
      const key = [cmd, ...a.slice(0, 2)].join(" ");
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd === "git") {
        if (a[0] === "rev-parse" && a[1] === "--git-dir") return ok(".\n");
        if (a[0] === "fetch") return ok();
        if (a[0] === "rev-parse") return ok((a[1] === "refs/batch/main" ? w.mainHead : `sha${a[1]!.split("pr-")[1]}`) + "\n");
        if (a[0] === "merge-tree") {
          const b = a[a.length - 1]!;
          return w.conflicts.has(b) ? { code: 1, stdout: "", stderr: "" } : ok(`tree-${a[a.length - 2]}-${b}\n`);
        }
        if (a[0] === "commit-tree") { const c = `commit${++commits}`; w.log.push(`commit-tree ${a.filter((x) => x.startsWith("sha") || x.startsWith("commit") || /^a+$/.test(x) || /^b+$/.test(x)).join(" ")}`); w.tip.set("tip", c); return ok(`${c}\n`); }
        if (a[0] === "diff") return ok("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        if (a[0] === "push") { w.log.push(`push ${a.slice(-2).join(" ")}`); return ok(); }
      }
      if (cmd === "gh") {
        if (key === "gh api user") return ok(JSON.stringify({ login: "bot", id: 7, node_id: "N7" }));
        if (a[0] === "api") return ok("storytold/app\n");
        if (a[0] === "pr" && a[1] === "create") { w.log.push(`pr create ${opts?.input?.split("\n").filter((l) => l.startsWith("- ")).join(" ")}`); return ok("https://github.com/storytold/app/pull/900\n"); }
        if (a[0] === "pr" && a[1] === "close") { w.log.push(`pr close ${a[2]}`); return ok(); }
      }
      throw new Error(`unexpected ${cmd} ${a.join(" ")}`);
    },
  };
}

const finishTask = (db: DatabaseSync, id: number, failAt?: string) => {
  const t = db.prepare("SELECT plan FROM build_tasks WHERE id = ?").get(id) as { plan: string };
  const plan = JSON.parse(t.plan) as { name: string }[];
  const upto = failAt ? plan.findIndex((s) => s.name === failAt) + 1 : plan.length;
  const results = plan.slice(0, upto).map((s) => ({ step: s.name, exitCode: s.name === failAt ? 1 : 0, timedOut: false, durationMs: 1 }));
  db.prepare("UPDATE build_tasks SET state = ?, results = ? WHERE id = ?").run(failAt ? "failed" : "done", JSON.stringify(results), id);
};
const states = (db: DatabaseSync) => Object.fromEntries(buildQueue(db, { repo: "app" }).map((e) => [e.number, e.state]));
const quiet = () => {};

describe("integration batches", () => {
  test("builds a batch, skips a conflicting PR, publishes, merges with merge commits and grows the size", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    setBatchSize(db, "app", 5);
    const w = world();
    w.conflicts.add("sha3");
    const d = deps(w, join(dir, "r1"));
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.started, ["integration-app-20260102-1"]);
    assert.deepEqual(states(db), { 1: "batch-checking", 2: "batch-checking", 3: "ready", 4: "batch-checking" });
    const b = activeBatches(db, "app")[0]!;
    assert.deepEqual(membersOf(db, b.id).map((m) => m.number), [1, 2, 4]);
    const task = db.prepare("SELECT head_sha, patch, step FROM build_tasks WHERE id = ?").get(b.task_id) as { head_sha: string; patch: string; step: string };
    assert.equal(task.head_sha, MAIN);
    assert.match(task.patch, /^diff --git/);

    // The sandbox task is still running: nothing else starts.
    const again = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual([again.started, again.waiting], [[], ["integration-app-20260102-1"]]);

    finishTask(db, b.task_id!);
    const pub = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(pub.published, [b.branch]);
    assert.ok(w.log.some((l) => l.startsWith("push ") && l.endsWith(`:refs/heads/${b.branch}`)));
    assert.ok(w.log.some((l) => l.startsWith("pr create") && l.includes("[app#1](https://github.com/storytold/app/pull/1)") && l.includes("[app#4]")));
    assert.deepEqual(states(db), { 1: "in-batch", 2: "in-batch", 3: "ready", 4: "in-batch" });

    w.tip.set("tip", activeBatches(db, "app")[0]!.commit_sha);
    const done = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(done.merged, [1, 2, 4]);
    assert.ok(w.log.includes("safe-merge-test storytold/app 900 --merge"));
    const rows = db.prepare("SELECT number, method, outcome FROM merges ORDER BY number").all();
    assert.deepEqual(rows.map((r) => `${r.number}:${r.method}:${r.outcome}`), ["1:merge:merged", "2:merge:merged", "4:merge:merged"]);
    assert.equal(batchSizeOf(db, "app"), 6);
  });

  test("a failed batch splits in half; a single failing PR is held with a summary and the size halves", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const w = world();
    const d = deps(w, join(dir, "r2"));
    await runBatches(db, { repo: "app" }, quiet, d);
    const first = activeBatches(db, "app")[0]!;
    assert.equal(membersOf(db, first.id).length, 3);
    finishTask(db, first.task_id!, "test");
    const split = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(split.split.length, 1);
    assert.equal(batchSizeOf(db, "app"), 5);
    const kids = activeBatches(db, "app");
    assert.deepEqual(kids.map((k) => membersOf(db, k.id).map((m) => m.number)), [[1, 2], [3]]);

    finishTask(db, kids[1]!.task_id!, "test");
    finishTask(db, kids[0]!.task_id!);
    const next = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(next.failed, [3]);
    assert.equal(states(db)[3], "batch-failed");
    assert.equal((db.prepare("SELECT summary FROM merge_batches WHERE id = ?").get(kids[1]!.id) as { summary: string }).summary, "summary for 3");
    assert.equal(batchSizeOf(db, "app"), 2);
    assert.deepEqual(next.published.length, 1);
  });

  test("a moved default branch rebuilds the batch and closes its PR; CI failure on the batch PR splits it", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    const w = world();
    const d = deps(w, join(dir, "r3"));
    await runBatches(db, { repo: "app" }, quiet, d);
    finishTask(db, activeBatches(db, "app")[0]!.task_id!);
    await runBatches(db, { repo: "app" }, quiet, d);
    w.mainHead = MAIN2;
    const moved = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(moved.superseded.length, 1);
    assert.ok(w.log.includes("pr close 900"));
    const rebuilt = activeBatches(db, "app");
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]!.base_sha, MAIN2);
    assert.equal(rebuilt[0]!.state, "checking");

    finishTask(db, rebuilt[0]!.task_id!);
    await runBatches(db, { repo: "app" }, quiet, d);
    w.ci = "FAILURE";
    const failed = await runBatches(db, { repo: "app" }, quiet, d);
    assert.equal(failed.split.length, 1);
    assert.equal(activeBatches(db, "app").length, 2);
  });

  test("needs the repo's merge approval", async () => {
    const db = fresh([{ n: 1 }]);
    db.prepare("DELETE FROM main.settings WHERE key = 'merge_approved:app'").run();
    await assert.rejects(runBatches(db, { repo: "app" }, quiet, deps(world(), join(dir, "r4"))), /not approved/);
  });

  test("batch size rules: count, line cap and L-size alone", () => {
    const c = (size: string, lines: number) => ({ size, lines });
    assert.equal(admits([c("S", 10)], c("S", 10), 2), true);
    assert.equal(admits([c("S", 10), c("S", 10)], c("S", 10), 2), false);
    assert.equal(admits([c("S", 1500)], c("M", 600), 10), false);
    assert.equal(admits([c("S", 10)], c("L", 5), 10), false);
    assert.equal(admits([c("L", 900)], c("S", 5), 10), false);
  });

  test("the pipeline's own Fix PRs count as whitelisted", () => {
    const db = fresh([{ n: 1, author: "pipeline-bot" }, { n: 2, author: "pipeline-bot" }]);
    assert.deepEqual(states(db), { 1: "needs-decision", 2: "needs-decision" });
    db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', 'pipeline-bot')").run();
    db.prepare(`INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 50, 'x', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/1', '${T0}', '${T0}')`).run();
    assert.deepEqual(states(db), { 1: "ready", 2: "needs-decision" });
  });
});
