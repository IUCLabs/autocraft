import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { checksOf } from "../src/patchcheck/index.ts";
import { getTask } from "../src/build/tasks.ts";
import { connect } from "../src/db.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { fixIssueApprovalOf, setFixIssueApproval } from "../src/fixissue/approval.ts";
import { attemptOf, warmKeyOf, runFixIssue, runFixIssueCollect, type CollectDeps } from "../src/fixissue/index.ts";
import { selectIssues } from "./planned.ts";
import { parseTriage, validateFixPatch } from "../src/fixissue/parse.ts";
import { branchName, commentText, prBody, prTitle } from "../src/fixissue/template.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import type { Querier } from "../src/mirror.ts";
import { CLAIM_COMMENT_TEMPLATE } from "../src/fixissue/template.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixissue-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const LOGIN = "pipeline-bot";
const LIB = "crates/app/src/lib.rs";
const TEST = "crates/app/tests/autocraft_regression.rs";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const FIX = `diff --git a/${LIB} b/${LIB}
--- a/${LIB}
+++ b/${LIB}
@@ -1,3 +1,3 @@
 pub fn first(v: &[u8]) -> u8 {
-    v[0]
+    v.first().copied().unwrap_or(0)
 }
`;
const NEWTEST = `diff --git a/${TEST} b/${TEST}
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/${TEST}
@@ -0,0 +1,4 @@
+#[test]
+fn empty_slice_does_not_panic() {
+    assert_eq!(app::first(&[]), 0);
+}
`;
const GOOD = FIX + NEWTEST;
const TRIAGE_OK = (files = [LIB]) => JSON.stringify([{ ref: "app#5", fixable: true, reason: "panics on an empty slice", crate: "app", files }]);

type Opts = { existingPr?: string; approved?: boolean; label?: string; flags?: string[]; needsDecision?: number; score?: number; level?: string };

function fresh(o: Opts = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')").run();
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  issue(db, 5, "Panic when the slice is empty", "first() indexes element 0.", o);
  if (o.approved !== false) setFixIssueApproval(db, "op", "app", true);
  return db;
}

function issue(db: DatabaseSync, n: number, title: string, body: string, o: Opts = {}): void {
  db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', ?, ?, 'someone', ?, ?)").run(n, title, body, T0, T0);
  db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', ?, ?, ?, ?)`)
    .run(n, T0, o.label ?? "bugfix", JSON.stringify(o.flags ?? []), JSON.stringify({ top: 0.97, ...(o.flags?.includes("needs decision") ? { needs_decision: o.needsDecision ?? 0.9 } : {}) }));
  if (o.level !== undefined) db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('app', ?, 'h', ?, 0, 'jev', ?)").run(n, o.level, T0);
  if (o.score !== undefined) db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', ?, ?, '{}', ?)").run(n, o.score, T0);
}

describe("candidates", () => {
  test("an approved repo's settled bugfix issue is a candidate", () => {
    assert.deepEqual(selectIssues(fresh(), "app").map((c) => c.number), [5]);
  });

  test("a P4 (backlog) issue is not a candidate; a security flag raises it to P3, which is", () => {
    assert.equal(selectIssues(fresh({ level: "P4" }), "app").length, 0);
    assert.deepEqual(selectIssues(fresh({ level: "P3" }), "app").map((c) => c.number), [5]);
    assert.deepEqual(selectIssues(fresh({ level: "P4", flags: ["security"] }), "app").map((c) => c.number), [5]);
  });

  test("other labels, missing approval, a pending scope decision and Rust-less repos keep it out", () => {
    assert.equal(selectIssues(fresh({ label: "missing feature" }), "app").length, 0);
    assert.equal(selectIssues(fresh({ approved: false }), "app").length, 0);
    assert.equal(selectIssues(fresh({ flags: ["needs decision"] }), "app").length, 0);
    const db = fresh();
    db.prepare("INSERT INTO settings (key, value) VALUES ('fixissue_not_rust:app', 'x')").run();
    assert.equal(selectIssues(db, "app").length, 0);
  });

  test("a weak needs-decision flag on a bugfix, which Decide does not ask about, does not hold the issue", () => {
    assert.deepEqual(selectIssues(fresh({ flags: ["needs decision"], needsDecision: 0.4 }), "app").map((c) => c.number), [5]);
  });

  test("a scope decision answered take by an operator lets a needs-decision issue through; other answers do not", () => {
    const db = fresh({ flags: ["needs decision"] });
    db.prepare("INSERT INTO access (login, role) VALUES ('boss', 'operator')").run();
    const dec = (answer: string | null, by: string) => db.prepare("INSERT OR REPLACE INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by) VALUES ('d1', 'scope', 'app', 5, 'q', '[]', ?, ?, ?)").run(T0, answer, by);
    dec(null, "boss");
    assert.equal(selectIssues(db, "app").length, 0);
    dec("close", "boss");
    assert.equal(selectIssues(db, "app").length, 0);
    dec("take", "stranger");
    assert.equal(selectIssues(db, "app").length, 0);
    dec("take", "boss");
    assert.equal(selectIssues(db, "app").length, 1);
  });

  test("an open PR that closes or mentions the issue excludes it; a closed one does not", () => {
    const db = fresh();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, body, closing_issues, created_at, updated_at) VALUES ('app', 9, 'pr', 'OPEN', 'x', 'y', '[5]', ?, ?)").run(T0, T0);
    assert.equal(selectIssues(db, "app").length, 0);
    db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 9").run();
    assert.equal(selectIssues(db, "app").length, 1);
    db.prepare("INSERT INTO items (repo, number, kind, state, title, body, created_at, updated_at) VALUES ('app', 10, 'pr', 'OPEN', 'x', 'See #5 for context', ?, ?)").run(T0, T0);
    assert.equal(selectIssues(db, "app").length, 0);
  });

  test("ordered by priority score, highest first, and an existing attempt excludes the issue", () => {
    const db = fresh({ score: 40 });
    issue(db, 6, "Another bug", "b", { score: 80 });
    issue(db, 7, "Third bug", "b");
    assert.deepEqual(selectIssues(db, "app").map((c) => c.number), [6, 5, 7]);
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, created_at, updated_at) VALUES ('app', 6, 'm', 'h', 'failed', ?, ?)").run(T0, T0);
    assert.deepEqual(selectIssues(db, "app").map((c) => c.number), [5, 7]);
  });

  test("a skipped issue returns only when its text changed", () => {
    const db = fresh();
    const hash = selectIssues(db, "app")[0]!.hash;
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, created_at, updated_at) VALUES ('app', 5, 'm', ?, 'skipped', ?, ?)").run(hash, T0, T0);
    assert.equal(selectIssues(db, "app").length, 0);
    db.prepare("UPDATE items SET body = 'now with a stack trace' WHERE number = 5").run();
    assert.equal(selectIssues(db, "app").length, 1);
  });
});

describe("approval", () => {
  test("per repo, audited, tracked repos only", () => {
    const db = fresh({ approved: false });
    assert.equal(fixIssueApprovalOf(db, "app"), null);
    assert.equal(setFixIssueApproval(db, "op", "app", true), true);
    assert.equal(setFixIssueApproval(db, "op", "app", true), false);
    assert.throws(() => setFixIssueApproval(db, "op", "other", true), /not tracked/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'fixissue-approve'").get() as { n: number }).n, 1);
  });
});

describe("patch validation", () => {
  const ok = (text: string) => validateFixPatch(text, [LIB], TEST, "crates/app");
  const reason = (text: string) => (ok(text) as { reason: string }).reason;

  test("accepts the fix and the test file, also inside a fence, and builds a test-only patch", () => {
    const r = ok("```diff\n" + GOOD + "```");
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.files, [LIB]);
      assert.equal(r.testPatch.split("\n")[0], `diff --git a/${TEST} b/${TEST}`);
      assert.ok(r.patch.startsWith(`diff --git a/${LIB}`) && r.patch.endsWith(r.testPatch));
      assert.ok(!r.testPatch.includes("index "));
    }
  });

  test("refuses a path outside the list, an extra file, a missing test and a missing fix", () => {
    assert.match(reason(FIX.replaceAll(LIB, "crates/app/src/other.rs") + NEWTEST), /not a file named/);
    const extra = NEWTEST.replaceAll(TEST, "crates/app/tests/other.rs");
    assert.match(reason(GOOD + extra), /not a file named/);
    assert.match(reason(FIX), /does not add/);
    assert.match(reason(NEWTEST), /no source file/);
    assert.match(reason(FIX + NEWTEST.replace("new file mode 100644", "new file mode 100755")), /test file/);
  });

  test("refuses more than 300 changed lines", () => {
    const body = Array.from({ length: 151 }, (_, i) => `-o${i}\n+n${i}\n`).join("");
    const big = `diff --git a/${LIB} b/${LIB}\n--- a/${LIB}\n+++ b/${LIB}\n@@ -1,151 +1,151 @@\n${body}`;
    assert.match(reason(big + NEWTEST), /changed lines/);
  });

  test("refuses text that is not a diff", () => {
    assert.match(reason("I fixed it."), /not a unified diff/);
  });

  test("triage must name a workspace crate and listed editable Rust files", () => {
    const crates = [{ name: "app", dir: "crates/app" }];
    const paths = [LIB, "build.rs"];
    assert.ok(parseTriage(TRIAGE_OK(), "app#5", crates, paths).ok);
    assert.equal(parseTriage(TRIAGE_OK(["build.rs"]), "app#5", crates, paths).ok, false);
    assert.equal(parseTriage(TRIAGE_OK(["crates/app/src/x.rs"]), "app#5", crates, paths).ok, false);
    assert.equal(parseTriage(TRIAGE_OK().replace('"crate":"app"', '"crate":"nope"'), "app#5", crates, paths).ok, false);
  });
});

describe("texts", () => {
  test("branch name has no username and a slug from the title", () => {
    assert.equal(branchName(5, "Panic when the slice is empty!", LOGIN), "autocraft/fix-5-panic-when-the-slice-is-empty");
    assert.ok(!branchName(5, `${LOGIN} found a crash`, LOGIN).includes(LOGIN));
  });

  test("PR title, body and comment", () => {
    assert.equal(prTitle("Fix: Panic when the slice is empty."), "Fix panic when the slice is empty");
    const b = prBody(5, [LIB], TEST);
    assert.ok(b.startsWith("Fixes #5.\n"));
    assert.equal(b.trim().split("\n\n").length, 3);
    assert.equal(commentText("https://github.com/storytold/app/pull/12"), "A PR for this is in progress: https://github.com/storytold/app/pull/12.");
  });
});

// ---- the whole step against real git, with GitHub and the models faked ----------

type World = { db: DatabaseSync; deps: CollectDeps; log: string[]; calls: string[]; sha: string; replies: (string | null)[]; fork: string; asked: string[] };

const APPROVE = JSON.stringify({ verdict: "approve", reasons: "fixes the cause", problems: [] });

function world(o: Opts & { check?: string | null; triage?: string; patches?: (string | null)[]; title?: string } = {}): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(join(work, "crates/app/src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, LIB), "pub fn first(v: &[u8]) -> u8 {\n    v[0]\n}\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  const sha = git(work, "rev-parse", "HEAD");
  const upstream = join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", work, upstream);
  const fork = join(root, "fork.git");
  git(root, "init", "-q", "--bare", fork);
  const db = fresh(o);
  if (o.title) db.prepare("UPDATE items SET title = ? WHERE number = 5").run(o.title);
  const log: string[] = [], calls: string[] = [], asked: string[] = [];
  const replies = [...(o.patches ?? [GOOD])];
  let forked = false;
  const run: Exec = async (cmd, args, opt = {}): Promise<ExecResult> => {
    const out = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });
    if (cmd === "gh") {
      calls.push(`gh ${args.slice(0, 2).join(" ")}`);
      if (args[0] === "api" && args[1] === "user") return out(JSON.stringify({ login: LOGIN, id: 42, node_id: "U42" }));
      if (args[0] === "api" && args[1]!.startsWith(`repos/${LOGIN}/`)) return out("", forked ? 0 : 1);
      if (args[0] === "api" && args[1]!.includes("/forks")) return out(forked ? `${LOGIN}/app\n` : "");
      if (args[0] === "repo") { forked = true; return out(""); }
      if (args[0] === "pr" && args[1] === "list") return out(o.existingPr ? `${o.existingPr}\n` : "");
      if (args[0] === "pr") { log.push(`pr ${args.join(" ")} :: ${opt.input}`); return out("https://github.com/storytold/app/pull/12\n"); }
      if (args[0] === "issue") { log.push(`comment ${opt.input}`); return out(""); }
      return out("", 1);
    }
    const urlAt = args.findIndex((a) => a.startsWith("https://github.com/"));
    if (urlAt >= 0) {
      const target = args[urlAt]!.includes("/storytold/") ? upstream : fork;
      if (args.includes("push")) log.push(`push ${args.filter((a) => a.startsWith("--")).join(" ")} ${args.at(-1)}`);
      const a2 = args.map((a, i) => (i === urlAt ? target : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
      return exec("git", a2, opt);
    }
    return exec("git", args, opt);
  };
  const deps: CollectDeps = {
    exec: run, now: () => new Date("2026-01-02T00:00:00Z"), root: join(root, "cache"),
    mainHead: async () => sha,
    fetchCrates: async () => ({ ok: true, rust: true, crates: [{ name: "app", dir: "crates/app" }] }),
    fetchPaths: async () => [LIB, "README.md", "build.rs"],
    ask: async (_db, id, input) => {
      asked.push(`${id}:${JSON.stringify(input)}`);
      if (id === "fixissue.triage") return o.triage ?? TRIAGE_OK();
      if (id === "fixissue.check") return o.check === undefined ? APPROVE : o.check;
      return replies.length > 1 ? replies.shift()! : (replies[0] ?? null);
    },
    summarise: async (_db, _r, _n, _id, step) => `step ${step} failed: assertion left 0 right 1`,
  };
  return { db, deps, log, calls, sha, replies, fork, asked };
}

type End = "pass" | "fail-test" | "fail-build";
function finish(db: DatabaseSync, id: number, end: End): void {
  const t = getTask(db, id)!;
  const failAt = end === "pass" ? null : end === "fail-test" ? "test" : "build";
  const results = [];
  for (const s of t.plan) {
    const bad = s.name === failAt;
    results.push({ step: s.name, exitCode: bad ? 101 : 0, durationMs: 1, timedOut: false });
    if (bad) break;
  }
  db.prepare("UPDATE build_tasks SET state = ?, results = ?, ended_at = ? WHERE id = ?").run(end === "pass" ? "done" : "failed", JSON.stringify(results), T0, id);
}
const finishBoth = (db: DatabaseSync, head: End, base: End) => {
  const a = attemptOf(db, "app", 5)!;
  finish(db, a.head_task_id!, head);
  finish(db, a.base_task_id!, base);
};
const quiet = () => {};

describe("fix step", () => {
  test("triage says not fixable: skipped with a hold stage, never asked again for that text", async () => {
    const w = world({ triage: JSON.stringify([{ ref: "app#5", fixable: false, reason: "needs a design decision" }]) });
    const s = await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(s.skipped, ["app#5"]);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "skipped");
    assert.equal(a.reason, "needs a design decision");
    const st = w.db.prepare("SELECT stage, note FROM stages WHERE repo = 'app' AND number = 5 AND actor = 'fixissue'").get() as { stage: string; note: string };
    assert.deepEqual({ ...st }, { stage: "hold", note: "not a clear fix: needs a design decision" });
    const asked = w.asked.length;
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.equal(w.asked.length, asked);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
  });

  test("dry run touches nothing", async () => {
    const w = world();
    const s = await runFixIssue(w.db, { repo: "app" }, quiet, w.deps);
    assert.equal(s.started.length, 0);
    assert.equal(w.asked.length, 0);
    assert.equal(w.calls.length, 0);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM fix_attempts").get() as { n: number }).n, 0);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
    assert.equal((await runFixIssueCollect(w.db, { dryRun: true }, quiet, w.deps)).looked, 0);
  });

  test("an unapproved repo is refused", async () => {
    const w = world({ approved: false });
    await assert.rejects(runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps), /not approved/);
  });

  test("a passing fix: head and base tasks, then commit, push to the fork, PR, one comment", async () => {
    const w = world();
    const s = await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(s.started, ["app#5"]);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "testing");
    assert.equal(a.round, 1);
    const head = getTask(w.db, a.head_task_id!)!, base = getTask(w.db, a.base_task_id!)!;
    assert.equal(head.headSha, w.sha);
    assert.equal(base.headSha, w.sha);
    assert.ok(head.plan.some((p) => p.name === "regression" && p.cmd.includes("autocraft_regression")));
    assert.ok(base.plan.find((p) => p.name === "test")!.cmd.includes("autocraft_regression"));
    assert.deepEqual([head.step, head.number], ["fixissue", 5]);

    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(attemptOf(w.db, "app", 5)!.state, "testing");

    finishBoth(w.db, "pass", "fail-test");
    const c = await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(c.opened, 1);
    const done = attemptOf(w.db, "app", 5)!;
    assert.equal(done.state, "pr-opened");
    assert.equal(done.pr_url, "https://github.com/storytold/app/pull/12");

    const branch = "autocraft/fix-5-panic-when-the-slice-is-empty";
    assert.ok(!branch.includes(LOGIN));
    const pushed = git(w.fork, "rev-parse", `refs/heads/${branch}`);
    assert.match(git(w.fork, "log", "-1", "--format=%an <%ae>", pushed), new RegExp(`^${LOGIN} <42\\+${LOGIN}@`));
    assert.equal(git(w.fork, "rev-parse", `${pushed}^`), w.sha);
    assert.deepEqual(git(w.fork, "diff", "--name-only", w.sha, pushed).split("\n").sort(), [LIB, TEST]);
    assert.ok(!git(w.fork, "log", "-1", "--format=%B", pushed).match(/claude|anthropic|\bai\b/i));

    const pr = w.log.find((l) => l.startsWith("pr "))!;
    assert.ok(pr.includes("--repo storytold/app") && pr.includes(`--head ${LOGIN}:${branch}`) && pr.includes("--title Fix panic when the slice is empty"));
    assert.ok(pr.endsWith(`:: _AI-generated pull request (Sonnet). Not a maintainer decision._\n\n${prBody(5, [LIB], TEST)}`));
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), ["comment _AI-generated comment (Sonnet). Not a maintainer decision._\n\nA PR for this is in progress: https://github.com/storytold/app/pull/12."]);
    assert.equal(w.log.filter((l) => l.startsWith("push")).length, 1);

    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(w.log.filter((l) => l.startsWith("comment")).length, 1);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('fixissue-pr', 'fixissue-comment')").get() as { n: number }).n, 2);
  });

  test("Opus rejects a passing fix: nothing is pushed and round 2 gets the reasons", async () => {
    const reject = JSON.stringify({ verdict: "reject", reasons: "the test asserts nothing about the panic", problems: ["no assertion"] });
    const w = world({ check: reject });
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    finishBoth(w.db, "pass", "fail-test");
    const c = await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(c.opened, 0);
    assert.equal(c.failedRounds, 1);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "retry");
    assert.match(a.summary!, /Opus rejected the patch: the test asserts nothing about the panic; no assertion/);
    assert.ok(!w.calls.some((x) => x.startsWith("gh pr")));
    const checks = checksOf(w.db, "app", 5);
    assert.deepEqual(checks.map((x) => [x.kind, x.verdict, x.round, x.subject]), [["fixissue", "reject", 1, w.sha]]);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    const second = JSON.parse(w.asked.filter((x) => x.startsWith("fixissue.patch:")).at(-1)!.slice("fixissue.patch:".length));
    assert.match(second.previous.failure, /the test asserts nothing about the panic/);
    const seen = JSON.parse(w.asked.find((x) => x.startsWith("fixissue.check:"))!.slice("fixissue.check:".length));
    assert.ok(seen.patch.includes(TEST));
    assert.equal(seen.ref, "app#5");
  });

  test("Opus approves a passing fix: the check is recorded and the PR opens", async () => {
    const w = world();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    finishBoth(w.db, "pass", "fail-test");
    assert.equal((await runFixIssueCollect(w.db, {}, quiet, w.deps)).opened, 1);
    assert.deepEqual(checksOf(w.db, "app", 5).map((x) => x.verdict), ["approve"]);
  });

  test("head failure: round 2 gets the previous patch and the failure summary", async () => {
    const w = world();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    finishBoth(w.db, "fail-test", "fail-test");
    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    let a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "retry");
    assert.equal(a.round, 1);
    assert.match(a.summary!, /step test failed/);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "testing");
    assert.equal(a.round, 2);
    const second = JSON.parse(w.asked.filter((x) => x.startsWith("fixissue.patch:")).at(-1)!.slice("fixissue.patch:".length));
    assert.match(second.previous.failure, /step test failed/);
    assert.ok(second.previous.patch.includes(TEST));
    assert.equal(w.asked.filter((x) => x.startsWith("fixissue.triage:")).length, 1);
  });

  test("three failed rounds end as failed with a hold stage and no push", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) {
      await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
      finishBoth(w.db, "fail-test", "fail-test");
      await runFixIssueCollect(w.db, {}, quiet, w.deps);
    }
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "failed");
    assert.equal(a.round, 3);
    assert.match(a.reason!, /3 rounds/);
    assert.equal(w.db.prepare("SELECT stage FROM stages WHERE repo = 'app' AND number = 5 ORDER BY rowid DESC LIMIT 1").get()!.stage, "hold");
    assert.equal(w.log.filter((l) => l.startsWith("push") || l.startsWith("pr ")).length, 0);
    assert.equal(selectIssues(w.db, "app").length, 0);
  });

  test("the test passing on main is a failed round with that reason", async () => {
    const w = world();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    finishBoth(w.db, "pass", "pass");
    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "retry");
    assert.match(a.summary!, /passes without the fix/);
    assert.equal(w.log.filter((l) => l.startsWith("pr ")).length, 0);
  });

  test("an invalid patch is a failed round; a patch for an unlisted file never reaches a task", async () => {
    const w = world({ patches: [FIX.replaceAll(LIB, "crates/app/src/other.rs") + NEWTEST] });
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "retry");
    assert.match(a.summary!, /not a file named/);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE step = 'fixissue'").get() as { n: number }).n, 0);
  });

  test("a patch that does not apply to main is a failed round", async () => {
    const stale = GOOD.replace("-    v[0]", "-    v[1]");
    const w = world({ patches: [stale] });
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    const a = attemptOf(w.db, "app", 5)!;
    assert.equal(a.state, "retry");
    assert.match(a.summary!, /git apply/);
  });

  test("a build-environment error queues the tasks once more before failing", async () => {
    const w = world();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    const a = attemptOf(w.db, "app", 5)!;
    for (const id of [a.head_task_id!, a.base_task_id!]) w.db.prepare("UPDATE build_tasks SET state = 'lost', results = '[]', ended_at = ? WHERE id = ?").run(T0, id);
    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    const b = attemptOf(w.db, "app", 5)!;
    assert.equal(b.state, "testing");
    assert.notEqual(b.head_task_id, a.head_task_id);
    assert.equal(b.retries, 1);
  });
});

describe("opening the PR is gated and repeatable", () => {
  const passedWorld = async (o: Parameters<typeof world>[0] = {}) => {
    const w = world(o);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    finishBoth(w.db, "pass", "fail-test");
    return w;
  };
  const writes = (w: World) => w.log.length + w.calls.filter((c) => c === "gh repo").length;

  test("revoked approval: a passed row waits, nothing is written", async () => {
    const w = await passedWorld();
    setFixIssueApproval(w.db, "op", "app", false);
    const c = await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(c.opened, 0);
    assert.equal(writes(w), 0);
    assert.equal(w.calls.filter((c) => c.startsWith("gh pr") || c.startsWith("gh issue")).length, 0);
    assert.equal(attemptOf(w.db, "app", 5)!.state, "passed");
    setFixIssueApproval(w.db, "op", "app", true);
    assert.equal((await runFixIssueCollect(w.db, {}, quiet, w.deps)).opened, 1);
  });

  test("the fixissue daily limit caps opened PRs", async () => {
    const w = await passedWorld();
    w.db.prepare("INSERT OR REPLACE INTO stage_limits (step, per_day, updated_by, updated_at) VALUES ('fixissue', 1, 'op', ?)").run(T0);
    w.db.prepare("INSERT INTO audit (at, login, action, target) VALUES (?, 'fixissue', 'fixissue-pr', 'app#9')").run(new Date().toISOString());
    assert.equal((await runFixIssueCollect(w.db, {}, quiet, w.deps)).opened, 0);
    assert.equal(writes(w), 0);
    assert.equal(attemptOf(w.db, "app", 5)!.state, "passed");
  });

  test("an existing PR from our branch is adopted: no push, no create, comment once", async () => {
    const w = await passedWorld({ existingPr: "https://github.com/storytold/app/pull/7" });
    assert.equal((await runFixIssueCollect(w.db, {}, quiet, w.deps)).opened, 1);
    const a = attemptOf(w.db, "app", 5)!;
    assert.deepEqual([a.state, a.pr_url], ["pr-opened", "https://github.com/storytold/app/pull/7"]);
    assert.equal(w.log.filter((l) => l.startsWith("push") || l.startsWith("pr ")).length, 0);
    assert.equal(w.log.filter((l) => l.startsWith("comment")).length, 1);
  });

  test("a comment already recorded is not posted again", async () => {
    const w = await passedWorld({ existingPr: "https://github.com/storytold/app/pull/7" });
    w.db.prepare("INSERT INTO audit (at, login, action, target) VALUES (?, 'fixissue', 'fixissue-comment', 'app#5')").run(T0);
    await runFixIssueCollect(w.db, {}, quiet, w.deps);
    assert.equal(w.log.filter((l) => l.startsWith("comment")).length, 0);
  });

  test("a closed issue or another open PR for it fails the row before any write", async () => {
    const closed = await passedWorld();
    closed.db.prepare("UPDATE items SET state = 'CLOSED' WHERE number = 5").run();
    await runFixIssueCollect(closed.db, {}, quiet, closed.deps);
    assert.equal(attemptOf(closed.db, "app", 5)!.state, "failed");
    assert.equal(writes(closed), 0);

    const other = await passedWorld();
    other.db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', 9, 'pr', 'OPEN', 'Fix', 'Fixes #5', 'someone', ?, ?)").run(T0, T0);
    await runFixIssueCollect(other.db, {}, quiet, other.deps);
    assert.equal(attemptOf(other.db, "app", 5)!.state, "failed");
    assert.equal(writes(other), 0);
  });
});

describe("lane helpers", () => {
  test("warmKeyOf yields a key the task store accepts", () => {
    const ok = /^[a-z0-9][a-z0-9-]{0,63}$/;
    for (const n of ["App.Core", "_x", "Foo_Bar", "a".repeat(80), "-lead", "ok-name"]) assert.match(warmKeyOf(n), ok);
    assert.equal(warmKeyOf("Foo_Bar.rs"), "foo-bar-rs");
    assert.equal(warmKeyOf("a".repeat(80)).length, 64);
  });
});

describe("fix step assignment", () => {
  function withQuerier(w: World, assignees: string[]) {
    const calls: string[] = [];
    let assigned = [...assignees];
    w.deps.querier = validating({
      spent: 0, remaining: 5000,
      async query(q: string) {
        if (q.includes("viewer")) return { viewer: { login: LOGIN, id: "U42" } };
        if (q.startsWith("mutation")) {
          const add = q.includes("addAssignees");
          calls.push(add ? "assign" : "unassign");
          assigned = add ? [...assigned, LOGIN] : assigned.filter((l) => l !== LOGIN);
          return {};
        }
        return { repository: { issue: { id: "I5", state: "OPEN", assignees: { nodes: assigned.map((login) => ({ login })) } } } };
      },
    } as Querier);
    return { calls, assigned: () => assigned };
  }

  test("an unassigned issue is assigned and gets one claim comment when the fix starts", async () => {
    const w = world();
    setCommentApproval(w.db, "op", "app", true);
    const g = withQuerier(w, []);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(g.calls, ["assign"]);
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), [`comment _Automated message. Not a maintainer decision._\n\n${CLAIM_COMMENT_TEMPLATE}`]);
    assert.equal(CLAIM_COMMENT_TEMPLATE, "A PR for this is in progress.");
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.equal(w.log.filter((l) => l.startsWith("comment")).length, 1);
  });

  test("an issue someone else is assigned to is not assigned, and nothing is released when the fix fails", async () => {
    const w = world();
    const g = withQuerier(w, ["someone"]);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    w.db.prepare("UPDATE fix_attempts SET state = 'failed'").run();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(g.calls, []);
  });

  test("no claim comment on an issue someone else is assigned to", async () => {
    const w = world();
    setCommentApproval(w.db, "op", "app", true);
    withQuerier(w, ["someone"]);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), []);
  });

  test("a failed fix releases our assignment when we are the sole assignee", async () => {
    const w = world();
    const g = withQuerier(w, []);
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    w.db.prepare("UPDATE fix_attempts SET state = 'failed'").run();
    await runFixIssue(w.db, { repo: "app", dryRun: false }, quiet, w.deps);
    assert.deepEqual(g.calls, ["assign", "unassign"]);
    assert.deepEqual(g.assigned(), []);
  });
});
