// Journeys: a PR or issue goes through the real planner pass, the real executors and the real guard, with GitHub and the
// models faked (test/world-db.ts). Each test asserts outcomes: rows in the database and the writes that reached GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { CLI_BY } from "../src/core/gates.ts";
import { guard, liveOf } from "../src/core/guard.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runCifix, type CifixDeps } from "../src/cifix/index.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import type { Querier } from "../src/mirror.ts";
import { getTask } from "../src/build/tasks.ts";
import { runDecide } from "../src/decide/index.ts";
import { attemptOf, runFixIssue, runFixIssueCollect, type CollectDeps } from "../src/fixissue/index.ts";
import { runAct } from "../src/act/index.ts";
import { runBatches } from "../src/merge/batch.ts";
import { runMerge } from "../src/merge/index.ts";
import { runPremerge, type PremergeDeps } from "../src/premerge/review.ts";
import { CHECK, T1, tmpdir, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("diffs"), "cache");

const quiet = () => {};
let current: World | null = null;
const fresh = (): World => (current = world().repo());
afterEach(() => current?.close());

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
const premergeDeps: PremergeDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), model: "opus", maxChars: 120_000 };
const premergeReply = (n: number) => JSON.stringify({ ref: `app#${n}`, findings: [], searched: "callers" });
const merged = (w: World) => w.rows("SELECT number, head_oid, outcome FROM merges ORDER BY number");

describe("PR journeys", () => {
  test("a whitelisted bugfix PR goes from review to merge, and the merge gets the reviewed head", async () => {
    const w = fresh().pr(1).review(1).verified(1).models(() => premergeReply(1));
    assert.equal(w.prPlan(1).state, "waiting-premerge");
    const s = await runPremerge(w.db, { repo: "app" }, quiet, premergeDeps);
    assert.equal(s.reviewed, 1);
    assert.equal(w.prPlan(1).state, "ready");

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
    assert.deepEqual(merged(w), [{ number: 1, head_oid: "sha1", outcome: "merged" }]);
    assert.equal(w.prPlan(1).state, "merged");
  });

  test("a Hold answer stops a PR the rule would merge", async () => {
    const w = fresh().pr(1).review(1).verified(1).premerge(1, "clean").answer(1, "hold");
    assert.equal(w.prPlan(1).state, "declined");
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
  });

  test("an unsure review asks Merge? and merges after a Merge answer", async () => {
    const w = fresh().pr(1).review(1, { sure: false }).verified(1).premerge(1, "clean");
    assert.equal(w.prPlan(1).state, "needs-decision");
    const first = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(first.merged, []);
    assert.equal(first.asked.length, 1);
    assert.deepEqual(w.gh.writes, []);

    w.answerDecision(first.asked[0]!, "merge");
    assert.equal(w.prPlan(1).state, "decision-answered-merge");
    const second = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(second.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
  });

  test("a head that moves after the plan is refused, by the merge step and by the guard", async () => {
    const w = fresh().pr(1).review(1).verified(1).premerge(1, "clean");
    assert.equal(w.prPlan(1).actions[0]!.kind, "merge");
    w.gh.live(1, { head: "sha1-moved" });

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.equal(w.gh.writesOf("merge").length, 0);

    const g = await guard(w.db, { repo: "app", number: 1 }, { kind: "merge", head: "sha1" }, CLI_BY, liveOf(w.db, w.gh.querier));
    assert.ok("refused" in g && /head moved/.test(g.refused), JSON.stringify(g));
    assert.equal(w.gh.writesOf("merge").length, 0);
  });

  test("with the pipeline switched off the pipeline's own run writes nothing", async () => {
    const w = fresh().pr(1).review(1).verified(1).premerge(1, "clean").pipeline(false);
    const m = await runMerge(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
    assert.deepEqual(merged(w), []);
    // An operator's own run is not stopped by the switch.
    assert.deepEqual((await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps())).merged, ["app#1"]);
  });

  test("a batch of two PRs is built, published as one PR and lands together", async () => {
    const w = fresh().pr(1).review(1).verified(1).premerge(1, "clean").pr(2).review(2).verified(2).premerge(2, "clean");
    const deps = w.gh.batchDeps();
    const built = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.equal(built.published.length, 1);
    assert.deepEqual(w.gh.writesOf("pr").map((x) => x.number), [900]);
    assert.deepEqual(w.prPlan(1).state, "in-batch");
    assert.deepEqual(w.prPlan(2).state, "in-batch");
    assert.ok(!w.prPlan(1).actions.some((a) => a.kind === "merge" && a.params?.singleOnly), "a member is not merged alone");

    const done = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.deepEqual(done.merged, [1, 2]);
    // Only the batch PR was merged, at the tip that was pushed; the members got merge records.
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.number), [900]);
    assert.equal(w.gh.writesOf("merge")[0]!.head, w.gh.writesOf("push")[0]!.head);
    assert.deepEqual(merged(w).map((r) => [r.number, r.head_oid, r.outcome]), [[1, "sha1", "merged"], [2, "sha2", "merged"]]);
  });

  test("the batch PR's runs are approved at the batch tip when its members are fast-tracked in a repo whose pipeline is off", async () => {
    const w = fresh().pr(1).review(1).verified(1).premerge(1, "clean").pr(2).review(2).verified(2).premerge(2, "clean");
    await runBatches(w.db, { repo: "app" }, quiet, w.gh.batchDeps());
    const tip = (w.db.prepare("SELECT commit_sha AS c FROM merge_batches WHERE pr_number = 900").get() as { c: string }).c;
    w.db.prepare("INSERT INTO ci_run_approvals (repo, number, head_oid, runs, approved, reread, failed, checked_at) VALUES ('app', 900, ?, '[]', '[]', 1, '{}', ?)").run(tip, "2026-01-02T00:00:00Z");
    w.db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    w.db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, head_ref, created_at, updated_at)
      VALUES ('app', 900, 'pr', 'OPEN', 'batch', 'bot', 1, 0, 'mirror-lag', 'batch', ?, ?)`).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const plan = () => w.prPlan(900);
    assert.deepEqual(plan().actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
    w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
    assert.equal(plan().state, "out-of-scope");
    for (const n of [1, 2]) w.db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', ?, 'op', ?)").run(n, "2026-01-02T00:00:00Z");
    assert.deepEqual(plan().actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
  });

  test("a take-fix PR is fixed up on the contributor's branch, reviewed again at the new head and merged there", async () => {
    const git = gitWorld(1);
    const w = fresh().pr(1, { head: git.head }).review(1, { verdict: "take-fix" });
    assert.equal(w.prPlan(1).state, "needs-fix-up");
    assert.deepEqual(w.prPlan(1).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["fixup", "fix", git.head]]);

    const s = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, git.deps(w));
    assert.deepEqual(s.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.notEqual(pushed, git.head);
    // The push was for the reviewed head: the lease names it.
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.deepEqual(w.rows("SELECT state, from_head, to_head FROM fixups"), [{ state: "pushed", from_head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("comment").length, 1);

    // Sync sees the new head; it is reviewed, verified and pre-merge reviewed like any head.
    w.synced(1, pushed);
    assert.equal(w.prPlan(1).actions.some((a) => a.kind === "merge"), false);
    w.review(1, { head: pushed }).verified(1).premerge(1, "clean");
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.head), [pushed]);
  });
});

describe("close journey", () => {
  test("a PR the final review says to close is asked about, and an answered Close closes it at the reviewed head", async () => {
    const w = fresh().pr(1).review(1, { verdict: "close", reason: "Does not match the reference app" });
    assert.equal(w.prPlan(1).state, "opus-close");

    const asked = await runAct(w.db, { repo: "app", dryRun: false }, quiet, w.gh.actDeps());
    assert.equal(asked.asked.length, 1);
    assert.equal(w.gh.writes.length, 0, "asking writes nothing to GitHub");

    // Nobody but an operator counts, and the answer is for the head the question was asked at.
    w.answerDecision(asked.asked[0]!, "close");
    const done = await runAct(w.db, { repo: "app", dryRun: false }, quiet, w.gh.actDeps());
    assert.deepEqual(done.done, ["app#1"]);
    assert.deepEqual(w.gh.writes.map((x) => x.kind), ["comment", "close"]);
    assert.deepEqual(w.rows("SELECT state, repo, number FROM actions"), [{ state: "done", repo: "app", number: 1 }]);
    assert.equal(w.rows("SELECT 1 FROM stages WHERE stage = 'closed' AND number = 1").length, 1);
    assert.equal((await runAct(w.db, { repo: "app", dryRun: false }, quiet, w.gh.actDeps())).done.length, 0);
    assert.deepEqual(w.gh.writesOf("close").map((x) => [x.number, x.head]), [[1, "sha1"]]);
  });
});

describe("issue journey", () => {
  test("a classified issue gets a scope decision; once an operator says take, a fix is built, checked and opened as a PR", async () => {
    const lib = "crates/app/src/lib.rs", test = "crates/app/tests/autocraft_regression.rs";
    const fix = `diff --git a/${lib} b/${lib}\n--- a/${lib}\n+++ b/${lib}\n@@ -1,3 +1,3 @@\n pub fn first(v: &[u8]) -> u8 {\n-    v[0]\n+    v.first().copied().unwrap_or(0)\n }\n`;
    const newTest = `diff --git a/${test} b/${test}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${test}\n@@ -0,0 +1,4 @@\n+#[test]\n+fn empty_slice_does_not_panic() {\n+    assert_eq!(app::first(&[]), 0);\n+}\n`;
    const w = fresh().issue(5, { flags: ["needs decision"] }).models((input) => {
      if (input.includes("<decision>")) return JSON.stringify({ recommended: null, reason: "" });
      const refs = [...input.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify(refs.map((ref) => ({ ref, summary: `It reports a panic in ${ref}. The reference app has no such case.` })));
    });
    // Classified and flagged: the planner wants a scope decision and holds the fix back until it is answered.
    const item = () => w.plan().items.find((i) => i.facts.number === 5)!.plan;
    assert.deepEqual(item().actions.map((a) => a.kind).filter((k) => k === "decide" || k === "fixissue"), ["decide"]);
    await runDecide(w.db, {}, quiet);
    const [decision] = w.rows("SELECT id, answer FROM decisions WHERE kind = 'scope'");
    assert.equal(decision!.answer, null);
    assert.equal(item().state, "scope-open");
    assert.equal(item().actions.some((a) => a.kind === "fixissue"), false);

    w.answerDecision(String(decision!.id), "take");
    assert.deepEqual(item().actions.map((a) => a.kind).filter((k) => k === "fixissue"), ["fixissue"]);

    const g = issueWorld(w, { lib, fix: fix + newTest });
    const started = await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, g.deps);
    assert.deepEqual(started.started, ["app#5"]);
    const a = attemptOf(w.db, "app", 5)!;
    // The fix must fail on the base and pass on the head; the sandbox's results are recorded on its tasks.
    endTask(w, a.head_task_id!, "pass");
    endTask(w, a.base_task_id!, "fail-test");
    const collected = await runFixIssueCollect(w.db, {}, quiet, g.deps);
    assert.equal(collected.opened, 1);
    assert.equal(attemptOf(w.db, "app", 5)!.state, "pr-opened");
    assert.deepEqual(g.prs.map((x) => x.head), ["pipeline-bot:autocraft/fix-5-panic-when-the-slice-is-empty"]);
    assert.deepEqual(g.comments, ["A PR for this is in progress: https://github.com/storytold/app/pull/12."]);
  });
});

describe("CI fix journey", () => {
  test("a PR whose CI fails gets a fix pushed to its branch for the reviewed head", async () => {
    const git = gitWorld(1, "fn a() {}\nfn main() { b(); }\n");
    const w = fresh().pr(1, { head: git.head, ci: "failure" }).review(1);
    assert.equal(w.prPlan(1).state, "ci-failed");
    assert.deepEqual(w.prPlan(1).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["cifix", "work", git.head]]);

    const s = await runCifix(w.db, { repo: "app", dryRun: false }, quiet, git.cifixDeps(w));
    assert.deepEqual(s.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.notEqual(pushed, git.head);
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.deepEqual(w.rows("SELECT kind, state, head, to_head FROM ci_fixes"), [{ kind: "code", state: "pushed", head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("merge").length, 0);
  });
});

/** An upstream repo and an empty fork on disk; git runs for real, gh is faked. Records the PRs opened and the issue comments. */
function issueWorld(w: World, o: { lib: string; fix: string }) {
  const root = tmpdir("issue");
  const work = join(root, "work");
  mkdirSync(join(work, "crates/app/src"), { recursive: true });
  sh(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, o.lib), "pub fn first(v: &[u8]) -> u8 {\n    v[0]\n}\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "init");
  const sha = sh(work, "rev-parse", "HEAD");
  const upstream = join(root, "upstream.git"), fork = join(root, "fork.git");
  sh(root, "clone", "-q", "--bare", work, upstream);
  sh(root, "init", "-q", "--bare", fork);
  const prs: { head: string }[] = [], comments: string[] = [];
  let forked = false;
  const out = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });
  const run: Exec = async (cmd, args, opt = {}) => {
    if (cmd === "gh") {
      if (args[0] === "api" && args[1] === "user") return out(JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }));
      if (args[0] === "api" && args[1]!.startsWith("repos/pipeline-bot/")) return out("", forked ? 0 : 1);
      if (args[0] === "api" && args[1]!.includes("/forks")) return out(forked ? "pipeline-bot/app\n" : "");
      if (args[0] === "repo") { forked = true; return out(""); }
      if (args[0] === "pr" && args[1] === "list") return out("");
      if (args[0] === "pr") { prs.push({ head: args[args.indexOf("--head") + 1]! }); w.gh.writes.push({ kind: "pr", number: 12 }); return out("https://github.com/storytold/app/pull/12\n"); }
      if (args[0] === "issue") { comments.push((opt.input ?? "").split("\n\n").at(-1)!); w.gh.writes.push({ kind: "comment", number: 5 }); return out(""); }
      return out("", 1);
    }
    const urlAt = args.findIndex((a) => a.startsWith("https://github.com/"));
    if (urlAt < 0) return exec("git", args, opt);
    const target = args[urlAt]!.includes("/storytold/") ? upstream : fork;
    if (args.includes("push")) w.gh.writes.push({ kind: "push", number: 5 });
    const local = args.map((a, i) => (i === urlAt ? target : a)).filter((a, i, all) => a !== "protocol.file.allow=never" && !(a === "-c" && all[i + 1] === "protocol.file.allow=never"));
    return exec("git", local, opt);
  };
  const deps: CollectDeps = {
    exec: run, now: () => new Date(T1), root: join(root, "cache"), mainHead: async () => sha,
    fetchCrates: async () => ({ ok: true, rust: true, crates: [{ name: "app", dir: "crates/app" }] }),
    fetchPaths: async () => [o.lib, "README.md"],
    ask: async (_db, id) => id === "fixissue.triage"
      ? JSON.stringify([{ ref: "app#5", fixable: true, reason: "panics on an empty slice", crate: "app", files: [o.lib] }])
      : id === "fixissue.check" ? JSON.stringify({ verdict: "approve", reasons: "fixes the cause", problems: [] }) : o.fix,
    summarise: async () => "failed",
  };
  return { deps, prs, comments };
}

/** The sandbox finished a build task: every step passed, or the test step failed. */
function endTask(w: World, id: number, end: "pass" | "fail-test"): void {
  const t = getTask(w.db, id)!;
  const results = [];
  for (const s of t.plan) {
    const bad = end === "fail-test" && s.name === "test";
    results.push({ step: s.name, exitCode: bad ? 101 : 0, durationMs: 1, timedOut: false });
    if (bad) break;
  }
  w.db.prepare("UPDATE build_tasks SET state = ?, results = ?, ended_at = ? WHERE id = ?").run(end === "pass" ? "done" : "failed", JSON.stringify(results), T1, id);
}

const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A contributor's fork on disk (branch fix-<n>) that stands in for both GitHub URLs; git runs for real, gh is faked. */
function gitWorld(n: number, lib = "fn a() {}\nfn main() { a(); }\n") {
  const root = tmpdir("git");
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  sh(work, "init", "-q", "-b", `fix-${n}`);
  writeFileSync(join(work, "src/lib.rs"), lib);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "contributor");
  const head = sh(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  sh(root, "clone", "-q", "--bare", work, fork);
  sh(fork, "update-ref", `refs/pull/${n}/head`, head);
  const pushes: { lease: string; to: string }[] = [];
  const edit = (from: string, to: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n${from}${to}`;
  const patch = lib.includes("main() { a(); }")
    ? edit("-fn a() {}\n-fn main() { a(); }\n", "+fn b() {}\n+fn main() { b(); }\n")
    : edit("-fn a() {}\n-fn main() { b(); }\n", "+fn b() {}\n+fn main() { b(); }\n");
  return {
    head, pushes, fork, patch,
    branchHead: () => sh(fork, "rev-parse", `refs/heads/fix-${n}`),
    deps(w: World): FixupDeps {
      const querier: Querier = {
        ...w.gh.querier,
        query: async (query: string, vars: object) => query.includes("headRefName")
          ? { repository: { pullRequest: { id: `P${n}`, state: "OPEN", isDraft: false, headRefOid: head, headRefName: `fix-${n}`, maintainerCanModify: true, mergeable: "MERGEABLE", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } }
          : w.gh.querier.query(query, vars),
      } as Querier;
      const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
        if (cmd === "gh") {
          if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
          w.gh.writes.push({ kind: "comment", number: n, detail: o.input });
          return { code: 0, stdout: "", stderr: "" };
        }
        // GitHub's URLs point at the fork on disk, which needs the file protocol.
        const toFork = args.map((a) => (a.startsWith("https://github.com/") ? fork : a));
        const local = toFork.filter((a, i) => a !== "protocol.file.allow=never" && !(a === "-c" && toFork[i + 1] === "protocol.file.allow=never"));
        if (args.includes("push")) {
          const lease = args.find((a) => a.startsWith("--force-with-lease="))!.split(":")[1]!;
          const to = args.find((a) => /^[0-9a-f]{40}:/.test(a))!.split(":")[0]!;
          pushes.push({ lease, to });
          w.gh.writes.push({ kind: "push", number: n, head: to });
        }
        return exec("git", local, { ...o });
      };
      return {
        querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
        fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
        ask: async () => patch,
        check: async () => JSON.stringify({ verdict: "approve", reasons: "matches the listed fix", problems: [] }),
      };
    },
    /** The CI fix step's deps: the failed check's log names src/lib.rs. */
    cifixDeps(w: World): CifixDeps {
      const base = this.deps(w);
      const log = "test\tcargo test\t2026-01-01T00:00:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-01-01T00:00:01Z  --> src/lib.rs:2:20\n";
      return {
        ...base,
        ask: base.ask as unknown as CifixDeps["ask"],
        gh: async (args) => {
          if (args[0] === "api" && args[1]!.includes("/pulls/")) return `${"b".repeat(40)}\n`;
          if (args[0] === "api") return JSON.stringify({ check_runs: [{ name: CHECK, status: "completed", conclusion: "failure", completed_at: "2026-01-03T12:00:00Z", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" }] });
          return log;
        },
        check: async () => JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] }),
      };
    },
  };
}
