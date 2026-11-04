// CI fix: candidates, the log triage, the formatter, the rerun, the model patch and its check, the push and the comment fallback.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { setCommentApproval } from "../src/act/approval.ts";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { connect } from "../src/db.ts";
import { classifyCifix, selectCifix } from "../src/cifix/candidates.ts";
import { FORMAT_ARTIFACT, gitFormatDiff, runCifix, runRerun, type CifixDeps } from "../src/cifix/index.ts";
import { formattingOnly, guardPatch } from "../src/cifix/guard.ts";
import { parseFailedLog } from "../src/cifix/logs.ts";
import { triage } from "../src/cifix/triage.ts";
import type { CiFailure } from "../src/cifix/types.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { setCiApproval } from "../src/merge/ci-approval.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { buildQueue, eligible } from "../src/merge/queue.ts";
import type { Querier } from "../src/mirror.ts";
import { saveOpus } from "../src/review/opus.ts";
import { fresh as freshQueueDb, T1 as QT1 } from "./batch-fixture.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "cifix-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-03T00:00:00Z";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Opts = { canModify?: boolean; push?: boolean; comment?: boolean; ci?: boolean; verdict?: string; overall?: string; head?: string };

/** One PR (#7) at `head` whose gate check failed. */
function fresh(head: string, o: Opts = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Rename a to b', 'someone', 5, 0, ?, '${T0}', '${T0}')`).run(head);
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', ?, 'looks right', '[]', 1, 'full')`)
    .run(head, o.verdict ?? "take");
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, ?, '[{"name":"gate / test","state":"failure"}]', 'MERGEABLE', ?, '${T1}')`).run(head, o.overall ?? "failure", o.canModify === false ? 0 : 1);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  if (o.push !== false) setPushApproval(db, "op", "app", true);
  if (o.comment) setCommentApproval(db, "op", "app", true);
  if (o.ci) setCiApproval(db, "op", "app", true);
  return db;
}

describe("candidates", () => {
  test("a take PR whose check failed at its head is a candidate; take-fix too once its fix-up is done", () => {
    assert.deepEqual(selectCifix(fresh("h1"), "app").work.map((c) => [c.number, c.head, c.attempt, c.route]), [[7, "h1", 1, "branch"]]);
    // The take-fix's fixes are empty here, so the fix-up has nothing to do first.
    assert.equal(selectCifix(fresh("h1", { verdict: "take-fix" }), "app").work.length, 1);
  });

  test("a take-fix with fixes still to push goes through the fix-up first", () => {
    const db = fresh("h1", { verdict: "take-fix" });
    db.prepare("UPDATE opus_reviews SET fixes = ? WHERE number = 7").run(JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]));
    assert.equal(selectCifix(db, "app").work.length, 0);
  });

  test("passing or pending checks, other verdicts, held, backlogged and changes-requested PRs are not candidates", () => {
    assert.equal(selectCifix(fresh("h1", { overall: "success" }), "app").work.length, 0);
    assert.equal(selectCifix(fresh("h1", { overall: "pending" }), "app").work.length, 0);
    assert.equal(selectCifix(fresh("h1", { verdict: "hold" }), "app").work.length, 0);
    assert.equal(selectCifix(fresh("h1", { verdict: "close" }), "app").work.length, 0);
    const held = fresh("h1");
    held.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 7, 'op', ?)").run(T1);
    assert.equal(selectCifix(held, "app").work.length, 0);
    const blocked = fresh("h1");
    blocked.prepare("INSERT INTO review_gates (repo, number, blocked, by_login, read_at) VALUES ('app', 7, 1, 'maint', ?)").run(T1);
    assert.equal(selectCifix(blocked, "app").work.length, 0);
    const backlog = fresh("h1");
    backlog.prepare("INSERT INTO decisions (id, kind, repo, number, items, question, options, asked_at, answer) VALUES ('d1', 'scope', 'app', 7, '[]', 'q', '[]', ?, 'backlog')").run(T0);
    assert.equal(selectCifix(backlog, "app").work.length, 0);
  });

  test("without push approval a pushable PR waits; without comment approval a closed branch waits; with it the patch is posted", () => {
    assert.equal(classifyCifix(fresh("h1", { push: false }), "app")[0]!.bucket, "unapproved");
    assert.equal(classifyCifix(fresh("h1", { canModify: false }), "app")[0]!.bucket, "cannot-push");
    const ask = selectCifix(fresh("h1", { canModify: false, comment: true }), "app").work;
    assert.deepEqual(ask.map((c) => c.route), ["comment"]);
  });

  test("at most 2 pushed CI fixes and 4 tries per PR, over all heads", () => {
    const add = (db: DatabaseSync, state: string, head: string) => db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, created_at) VALUES ('app', 7, ?, 'code', ?, 1, ?)").run(head, state, T1);
    // Two of our own pushes made earlier heads; the PR is now at a fresh head with no tries of its own.
    const pushes = fresh("h3");
    add(pushes, "pushed", "h1");
    assert.equal(classifyCifix(pushes, "app")[0]!.bucket, "work");
    add(pushes, "pushed", "h2");
    assert.equal(classifyCifix(pushes, "app")[0]!.bucket, "capped");
    assert.equal(selectCifix(pushes, "app").work.length, 0);
    const tries = fresh("h5");
    for (const h of ["h1", "h2", "h3", "h4"]) add(tries, "rejected", h);
    assert.equal(classifyCifix(tries, "app")[0]!.bucket, "capped");
    const three = fresh("h5");
    for (const h of ["h1", "h2", "h3"]) add(three, "rejected", h);
    assert.equal(classifyCifix(three, "app")[0]!.bucket, "work");
  });

  test("the cap is noted on the PR once, with no model call", async () => {
    const w = world();
    const db = fresh(w.head);
    for (const h of ["a1", "a2", "a3", "a4"]) db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, created_at) VALUES ('app', 7, ?, 'code', 'failed', 1, ?)").run(h, T1);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, []);
    assert.equal(rows(db, "SELECT 1 FROM stages WHERE note LIKE 'CI fix capped%'").length, 1);
    assert.equal(classifyCifix(db, "app")[0]!.bucket, "failed");
  });

  test("a changes request mirrored after the last live read blocks, like in the merge queue", () => {
    const db = fresh("h1");
    // The live read found nothing blocking, then the PR changed and a maintainer's review was mirrored.
    db.prepare("INSERT INTO review_gates (repo, number, blocked, by_login, read_at) VALUES ('app', 7, 0, '', ?)").run(T1);
    db.prepare("UPDATE items SET updated_at = ?").run(T2);
    db.prepare("UPDATE pr_checks SET fetched_at = ?").run("2026-01-04T00:00:00Z");
    assert.equal(selectCifix(db, "app").work.length, 1);
    db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, review_state, counted, author_association) VALUES ('app', 7, 'r1', 'review', 'maint', ?, '', 'CHANGES_REQUESTED', 0, 'MEMBER')").run(T2);
    assert.equal(selectCifix(db, "app").work.length, 0);
    const decision = fresh("h1");
    decision.prepare("UPDATE items SET review_decision = 'CHANGES_REQUESTED'").run();
    assert.equal(selectCifix(decision, "app").work.length, 0);
  });

  test("two tries per head; a push or a comment ends the work on the head", () => {
    const db = fresh("h1");
    const add = (state: string, head = "h1") => db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, created_at) VALUES ('app', 7, ?, 'code', ?, 1, ?)").run(head, state, T1);
    add("failed");
    assert.deepEqual(selectCifix(db, "app").work.map((c) => c.attempt), [2]);
    add("rejected");
    assert.equal(classifyCifix(db, "app")[0]!.bucket, "failed");
    add("failed", "other-head");
    assert.equal(classifyCifix(fresh("h2"), "app")[0]!.bucket, "work");
    const pushed = fresh("h1");
    pushed.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, created_at) VALUES ('app', 7, 'h1', 'code', 'asked', 1, ?)").run(T1);
    assert.equal(classifyCifix(pushed, "app")[0]!.bucket, "done");
  });
});

const step = (job: string, name: string, tail: string) => ({ job, step: name, tail });
const failure = (conclusion: string, steps: ReturnType<typeof step>[]): CiFailure => ({ head: "h", checks: [{ name: "gate / test", conclusion, runId: 11, steps }] });

describe("triage", () => {
  test("formatter-only output is format; any compiler or test error makes it code", () => {
    assert.equal(triage(failure("failure", [step("fmt", "Check formatting", "Diff in /w/src/lib.rs:1:\n-fn a() {}\n+fn a() { }\n")])).kind, "format");
    assert.equal(triage(failure("failure", [step("fmt", "Check formatting", "Diff in /w/src/lib.rs:1:\n"), step("test", "cargo test", "error[E0425]: cannot find value\n")])).kind, "code");
    assert.equal(triage(failure("failure", [step("test", "cargo test", "test result: FAILED. 1 passed; 1 failed\n")])).kind, "code");
    assert.equal(triage(failure("failure", [step("lint", "cargo clippy", "error: this could be `x` (clippy::needless)\n")])).kind, "code");
  });

  test("a cancelled run is skipped, not infra", () => {
    assert.equal(triage(failure("cancelled", [])).kind, "skip");
  });

  test("a timed out run, or a network error without a code error, is infra; infra is tested before format", () => {
    assert.equal(triage(failure("failure", [step("fmt", "Check formatting", "Diff in /w/src/lib.rs:1:\nCould not resolve host: x\n")])).kind, "infra");
    assert.equal(triage(failure("timed_out", [step("test", "cargo test", "")])).kind, "infra");
    assert.equal(triage(failure("failure", [step("build", "cargo fetch", "warning: spurious network error (2 tries remaining): Could not resolve host: index.crates.io\n")])).kind, "infra");
    // A network word next to a real error is the PR's failure.
    assert.equal(triage(failure("failure", [step("test", "cargo test", "Could not resolve host: x\nerror[E0308]: mismatched types\n")])).kind, "code");
  });

  test("no log at all is unreadable", () => {
    assert.equal(triage(failure("failure", [])).kind, "unreadable");
  });

  test("the failed-step log is grouped per job and step and cut to its tail", () => {
    const text = `test\tcargo test\t2026-01-01T00:00:01.0000000Z \u001b[31merror\u001b[0m: boom\ntest\tcargo test\t2026-01-01T00:00:02.0000000Z more\nfmt\tcheck\t2026-01-01T00:00:03.0000000Z Diff in x:1:\n`;
    const steps = parseFailedLog(text);
    assert.deepEqual(steps.map((s) => [s.job, s.step, s.tail]), [["test", "cargo test", "error: boom\nmore\n"], ["fmt", "check", "Diff in x:1:\n"]]);
    assert.equal(parseFailedLog(`j\ts\t${"x".repeat(9000)}\n`)[0]!.tail.length, 4000);
  });
});

describe("guard", () => {
  const edit = (file: string, body: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}`;
  test("a patch that edits tests, disables lints or drops assertions is refused", () => {
    assert.match(guardPatch(edit("tests/png.rs", "-a\n+b\n"), ["tests/png.rs"])!, /test file/);
    assert.match(guardPatch(edit("src/png/tests.rs", "-a\n+b\n"), ["src/png/tests.rs"])!, /test file/);
    assert.match(guardPatch(edit("src/lib.rs", "-fn a() {}\n+#[allow(dead_code)] fn a() {}\n"), ["src/lib.rs"])!, /disables/);
    assert.match(guardPatch(edit("src/lib.rs", "-    assert_eq!(a(), 1);\n+    let _ = a();\n"), ["src/lib.rs"])!, /assertion/);
    assert.equal(guardPatch(edit("src/lib.rs", "-fn a() {}\n+fn b() {}\n"), ["src/lib.rs"]), null);
    assert.match(guardPatch(edit("src/lib.rs", "-fn a() {}\n+#[cfg(feature = \"x\")] fn a() {}\n"), ["src/lib.rs"])!, /disables/);
    assert.match(guardPatch(edit("src/lib.rs", "-fn a() {}\n+#[should_panic] fn a() {}\n"), ["src/lib.rs"])!, /disables/);
  });

  const SRC = "fn a() {}\n\n#[cfg(test)]\nmod tests {\n    fn helper() {\n        let x = \"}\";\n    }\n\n    #[test]\n    fn t() {\n        check();\n    }\n}\n\nfn last() {}\n";
  const hunk = (at: number, body: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -${at} +${at} @@\n${body}`;
  const heads = new Map([["src/lib.rs", SRC]]);

  test("a hunk inside a #[cfg(test)] module is refused; one outside is allowed", () => {
    assert.match(guardPatch(hunk(6, "-        let x = \"}\";\n+        let x = \"{\";\n"), ["src/lib.rs"], heads)!, /test code/);
    assert.equal(guardPatch(hunk(1, "-fn a() {}\n+fn b() {}\n"), ["src/lib.rs"], heads), null);
    assert.equal(guardPatch(hunk(15, "-fn last() {}\n+fn end() {}\n"), ["src/lib.rs"], heads), null);
    assert.match(guardPatch(hunk(1, "-fn a() {}\n+fn b() {}\n"), ["src/lib.rs"], new Map())!, /could not be read/);
    assert.match(guardPatch(hunk(1, "-fn a() {}\n+fn b() {}\n"), ["src/lib.rs"], new Map([["src/lib.rs", "#[test]\nfn a() {\n"]]))!, /could not be checked/);
  });

  test("an early return added to a #[test] function is refused", () => {
    const src = "#[test]\nfn t() {\n    check();\n}\n";
    const patch = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -2,2 +2,3 @@\n fn t() {\n+    return;\n     check();\n";
    assert.match(guardPatch(patch, ["src/lib.rs"], new Map([["src/lib.rs", src]]))!, /early return/);
  });
});

// ---- the whole step against real git, with the network replaced ------------

type World = { fork: string; head: string; log: string[]; deps: CifixDeps };

const APPROVE = JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] });
const REJECT = JSON.stringify({ verdict: "reject", reasons: "hides the error", problems: ["silences it"] });
const CODE_LOG = "test\tcargo test\t2026-01-01T00:00:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-01-01T00:00:01Z  --> src/lib.rs:2:20\n";
const FMT_LOG = "fmt\tCheck formatting\t2026-01-01T00:00:00Z Diff in /home/runner/work/app/app/src/lib.rs:1:\n";
const INFRA_LOG = "build\tcargo fetch\t2026-01-01T00:00:00Z warning: spurious network error: Could not resolve host: index.crates.io\n";
const BASE = "b".repeat(40);
const GOOD = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { b(); }\n+fn b() {}\n+fn main() { b(); }\n";

function world(opts: { log?: string; reply?: string | null; check?: string | null; canModify?: boolean; pushError?: string; conclusion?: string; completedAt?: string; checkRuns?: unknown[]; commentFails?: boolean; closedAfter?: number; decision?: string } = {}): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "fix");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/lib.rs"), "fn a() {}\nfn main() { b(); }\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);
  const log: string[] = [];
  let reads = 0;
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query() {
      return { repository: { pullRequest: {
        id: "PR7", number: 7, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "gate / test", status: "COMPLETED", conclusion: "FAILURE" }] } } } }] }, state: opts.closedAfter !== undefined && ++reads > opts.closedAfter ? "CLOSED" : "OPEN", isDraft: false, headRefOid: head, headRefName: "fix", maintainerCanModify: opts.canModify !== false, mergeable: "MERGEABLE",
        headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] }, reviewDecision: opts.decision ?? null,
      } } };
    },
  });
  const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      if (args[0] === "run") { log.push(`rerun ${args[2]}`); return { code: 0, stdout: "", stderr: "" }; }
      log.push(`comment: ${o.input}`);
      return opts.commentFails ? { code: 1, stdout: "", stderr: "HTTP 403" } : { code: 0, stdout: "", stderr: "" };
    }
    const net = args.findIndex((a) => a.startsWith("https://github.com/"));
    const sub = net >= 0 ? args.map((a) => (a.startsWith("https://github.com/") ? fork : a)) : args;
    const sub2 = sub.filter((a, i) => !(a === "-c" && sub[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    if (args.includes("push")) {
      log.push("push");
      if (opts.pushError) return { code: 1, stdout: "", stderr: opts.pushError };
    }
    return exec("git", net >= 0 ? sub2 : args, { ...o });
  };
  const deps: CifixDeps = {
    querier, exec: run, now: () => new Date(T2), root: join(root, "cache"),
    fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
    gh: async (args) => {
      if (args[0] === "api" && args[1]!.includes("/pulls/")) return `${BASE}\n`;
      if (args[0] === "api") return JSON.stringify({ check_runs: opts.checkRuns ?? [
        { name: "gate / test", status: "completed", conclusion: opts.conclusion ?? "failure", completed_at: opts.completedAt ?? "2026-01-03T12:00:00Z", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" },
        { name: "optional / lint", status: "completed", conclusion: "success", details_url: "https://github.com/storytold/app/actions/runs/12/job/6" },
      ] });
      log.push("read-log");
      return opts.log ?? CODE_LOG;
    },
    ask: async () => { log.push("model"); return opts.reply === undefined ? GOOD : opts.reply; },
    check: async (_db, input) => {
      log.push("check");
      assert.deepEqual(input[0]!.fixes, []);
      assert.deepEqual(input[0]!.ci_failure!.checks, ["gate / test"]);
      return opts.check === undefined ? APPROVE : opts.check;
    },
  };
  return { fork, head, log, deps };
}

const rows = (db: DatabaseSync, sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
const ops = (w: World) => w.log.filter((l) => !l.startsWith("read-log"));

describe("code failure", () => {
  test("model patch, Opus check, push on the head's branch with a lease, one comment", async () => {
    const w = world();
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/fix");
    assert.notEqual(pushed, w.head);
    assert.equal(git(w.fork, "show", `${pushed}:src/lib.rs`), "fn b() {}\nfn main() { b(); }");
    assert.match(git(w.fork, "log", "-1", "--format=%B", pushed), /^Fix failing CI check\n\n- src\/lib\.rs/);
    assert.deepEqual(ops(w), ["model", "check", "push", "comment: _AI-generated comment (Sonnet). Not a maintainer decision._\n\nPushed a fix for the failing CI check: `src/lib.rs`."]);
    assert.deepEqual(rows(db, "SELECT kind, state, from_head, to_head FROM (SELECT kind, state, head AS from_head, to_head FROM ci_fixes)"), [{ kind: "code", state: "pushed", from_head: w.head, to_head: pushed }]);
    assert.deepEqual(rows(db, "SELECT action FROM audit WHERE action LIKE 'cifix%' ORDER BY rowid").map((r) => r.action), ["cifix-check", "cifix-push", "cifix-comment"]);
    assert.equal(rows(db, "SELECT 1 FROM stages WHERE note LIKE 'CI fix pushed%'").length, 1);
    assert.equal(selectCifix(db, "app").work.length, 0);
  });

  test("a patch Opus rejects is not pushed and counts as a try", async () => {
    const w = world({ check: REJECT });
    const db = fresh(w.head);
    const before = git(w.fork, "rev-parse", "refs/heads/fix");
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, []);
    assert.equal(git(w.fork, "rev-parse", "refs/heads/fix"), before);
    assert.ok(!w.log.includes("push"));
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "rejected" }]);
    assert.equal(selectCifix(db, "app").work[0]!.attempt, 2);
  });

  test("a patch that edits a test file or has no answer is refused before the check", async () => {
    const w = world({ reply: GOOD.replaceAll("src/lib.rs", "tests/lib.rs") });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, []);
    assert.deepEqual(ops(w), ["model"]);
    assert.match(String(rows(db, "SELECT reason FROM ci_fixes")[0]!.reason), /not a file named|test file/);
    const w2 = world({ reply: "NONE" });
    const s2 = await runCifix(fresh(w2.head), { repo: "app", dryRun: false }, () => {}, w2.deps);
    assert.deepEqual(s2.pushed, []);
    assert.ok(!w2.log.includes("check"));
  });

  test("the third try at a head is never made", async () => {
    const w = world({ check: REJECT });
    const db = fresh(w.head);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const third = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([third.pushed, third.failed], [[], []]);
    assert.equal(w.log.filter((l) => l === "model").length, 2);
    assert.deepEqual(rows(db, "SELECT attempt FROM ci_fixes ORDER BY rowid").map((r) => r.attempt), [1, 2]);
  });

  test("a branch closed to maintainers gets the patch as a comment where comments are approved, nothing elsewhere", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false, comment: true });
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.pushed, s.asked], [[], ["app#7"]]);
    assert.ok(!w.log.includes("push"));
    const comment = w.log.find((l) => l.startsWith("comment: "))!;
    assert.match(comment, /^comment: _AI-generated comment \(Sonnet\)\. Not a maintainer decision\._\n\nThe CI check `gate \/ test` fails on this branch\. This patch fixes it:\n\n```diff\ndiff --git a\/src\/lib\.rs/);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "asked" }]);
    // Another run does not comment again.
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(w.log.filter((l) => l.startsWith("comment: ")).length, 1);
    const none = world({ canModify: false });
    const db2 = fresh(none.head, { canModify: false });
    assert.equal(selectCifix(db2, "app").work.length, 0);
    await runCifix(db2, { repo: "app", dryRun: false }, () => {}, none.deps);
    assert.deepEqual(none.log, []);
  });
});

describe("format failure", () => {
  const hdr = "diff -uN a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\t2026-01-01 00:00:00.000000000 +0000\n+++ b/src/lib.rs\t2026-01-01 00:00:01.000000000 +0000\n@@ -1,2 +1,2 @@\n";
  // Spacing only.
  const diffText = `${hdr}-fn a() {}\n+fn a() { }\n fn main() { b(); }\n`;
  // What a PR that aliases the formatter, or prints fake `Diff in` lines, can make it produce: a code change.
  const forced = `${hdr}-fn a() {}\n-fn main() { b(); }\n+fn b() {}\n+fn main() { b(); }\n`;

  /** Runs the step to the queued formatter task, gives the task `diff` as its result and applies it. */
  async function formatRun(w: World, diff: string | null, db = fresh(w.head)) {
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const task = rows(db, "SELECT id FROM build_tasks")[0]!;
    db.prepare("UPDATE build_tasks SET state = 'done', ended_at = ? WHERE id = ?").run(T2, Number(task.id));
    if (diff !== null) {
      const tmp = tempPath(Number(task.id));
      writeFileSync(tmp, diff);
      storeArtifact(db, Number(task.id), FORMAT_ARTIFACT, tmp);
    }
    return { db, summary: await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps) };
  }

  test("a diff that changes code is refused, whatever produced it; the formatting row is closed", async () => {
    const w = world({ log: FMT_LOG });
    const before = git(w.fork, "rev-parse", "refs/heads/fix");
    const { db, summary } = await formatRun(w, forced);
    assert.deepEqual(summary.pushed, []);
    assert.ok(!w.log.includes("push"));
    assert.equal(git(w.fork, "rev-parse", "refs/heads/fix"), before);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "refused" }]);
    assert.match(String(rows(db, "SELECT reason FROM ci_fixes")[0]!.reason), /more than whitespace/);
  });

  test("formatting is checked by tokens: spacing passes, anything else is refused", () => {
    const fmt = (a: string, b: string) => formattingOnly("x.rs", a, b);
    assert.equal(fmt("fn a(x:i32){ }\nfn b(){}\n", "fn a(x: i32) {}\nfn b() {}\n"), null);
    assert.equal(fmt("f(a, b)\n", "f(a,\n  b)\n"), null);
    // Reordered, trailing comma, moved line.
    assert.notEqual(fmt("use b;\nuse a;\n", "use a;\nuse b;\n"), null);
    assert.notEqual(fmt("f(a, b)\n", "f(a, b,)\n"), null);
    assert.notEqual(fmt("let a = 1;\nlet b = 2;\n", "let b = 2;\nlet a = 1;\n"), null);
    // Whitespace inside a string literal or a comment is content.
    assert.notEqual(fmt('let s = "a b";\n', 'let s = "ab";\n'), null);
    assert.notEqual(fmt('let s = r#"a  b"#;\n', 'let s = r#"a b"#;\n'), null);
    assert.notEqual(fmt("// a  b\nfn f() {}\n", "// a b\nfn f() {}\n"), null);
    assert.equal(fmt("// a b  \nfn f() {}\n", "// a b\nfn f() {}\n"), null);
    // `/ *` and `/*` differ: the second opens a comment that may run to a planted `*/`.
    assert.notEqual(fmt("let y = x / *p; // done */\n", "let y = x /*p; // done */\n"), null);
    assert.notEqual(fmt("a - > b\n", "a -> b\n"), null);
    // Lifetimes and chars are not strings.
    assert.equal(fmt("fn f<'a>(x:&'a u8)->char{'}'}\n", "fn f<'a>(x: &'a u8) -> char { '}' }\n"), null);
  });

  test("files outside the PR's diff and the log's Diff in lines are never formatted", async () => {
    // The log names src/other.rs, which the PR does not change: no task, a refused try.
    const w = world({ log: "fmt\tCheck formatting\t2026-01-01T00:00:00Z Diff in /w/app/src/other.rs:1:\n" });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.queued, s.failed.length], [[], 1]);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "refused" }]);
    assert.equal(rows(db, "SELECT 1 FROM build_tasks").length, 0);
    // A formatter result for a file that was not named is refused too.
    const w2 = world({ log: FMT_LOG });
    const other = diffText.replaceAll("src/lib.rs", "src/other.rs");
    const r = await formatRun(w2, other);
    assert.deepEqual(r.summary.pushed, []);
    assert.deepEqual(rows(r.db, "SELECT state FROM ci_fixes"), [{ state: "refused" }]);
  });

  test("a step named like the formatter without the formatter's Diff in lines is code, not format", () => {
    assert.equal(triage(failure("failure", [step("fmt", "Check formatting", "error: something else broke\n")])).kind, "code");
    assert.equal(triage(failure("failure", [step("fmt", "Check formatting", "no diff lines here\n")])).kind, "code");
  });

  test("the formatter task runs rustfmt on the named files, not cargo fmt", async () => {
    const w = world({ log: FMT_LOG });
    const db = fresh(w.head);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const plan = JSON.parse(String(rows(db, "SELECT plan FROM build_tasks")[0]!.plan)) as { cmd: string[] }[];
    assert.deepEqual(plan[0]!.cmd.slice(0, 2), ["sh", "-c"]);
    assert.deepEqual(plan[0]!.cmd.slice(4), ["src/lib.rs"]);
    assert.match(plan[0]!.cmd[2]!, /rustfmt --edition/);
    assert.doesNotMatch(plan[0]!.cmd[2]!, /cargo fmt/);
    // Fixed environment and absolute path: nothing the PR sets (RUSTUP_HOME, PATH, a planted rustfmt) is used; no globbing.
    assert.match(plan[0]!.cmd[2]!, /^set -e; set -f;/);
    assert.match(plan[0]!.cmd[2]!, /env -i PATH=\/usr\/local\/cargo\/bin:\/usr\/bin:\/bin HOME=\/tmp RUSTUP_HOME=\/usr\/local\/rustup CARGO_HOME=\/usr\/local\/cargo \/usr\/local\/cargo\/bin\/rustfmt /);
    // The build environment comes from the PR's base commit, not the PR's own workflow.
    assert.equal(rows(db, "SELECT base_sha FROM build_tasks")[0]!.base_sha, BASE);
  });

  test("a string-literal whitespace change or a `/ *` turned into a comment opener in a formatter result is refused", async () => {
    const mk = (from: string, to: string) => `diff -uN a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-${from}\n+${to}\n fn main() { b(); }\n`;
    for (const [from, to] of [["fn a() {}", 'fn a() { let s = "a b"; }'], ["fn a() {}", "fn a() { x / *p; }"]]) {
      const w = world({ log: FMT_LOG });
      const db = fresh(w.head);
      // The head holds the spaced version; the "formatter" result drops the space.
      git(w.fork, "update-ref", "refs/heads/unused", w.head);
      const spaced = mk(from!, to!);
      const { summary } = await formatRun(w, spaced, db);
      assert.deepEqual(summary.pushed, []);
      assert.ok(!w.log.includes("push"));
    }
  });

  test("a changes request that arrived before the push skips it and records why", async () => {
    const w = world({ decision: "CHANGES_REQUESTED" });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.pushed, s.skipped], [[], ["app#7"]]);
    assert.ok(!w.log.includes("push"));
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "skipped" }]);
  });

  test("a head that moved before the formatter result was applied is a failed try that closes the formatting row", async () => {
    const w = world({ log: FMT_LOG });
    const db = fresh(w.head);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const moved = git(w.fork, "commit-tree", `${w.head}^{tree}`, "-m", "moved");
    git(w.fork, "update-ref", "refs/pull/7/head", moved);
    const task = rows(db, "SELECT id FROM build_tasks")[0]!;
    db.prepare("UPDATE build_tasks SET state = 'done', ended_at = ? WHERE id = ?").run(T2, Number(task.id));
    const tmp = tempPath(Number(task.id));
    writeFileSync(tmp, diffText);
    storeArtifact(db, Number(task.id), FORMAT_ARTIFACT, tmp);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "failed" }]);
    assert.equal((rows(db, "SELECT head_oid FROM pr_checks")[0] as { head_oid: string }).head_oid, moved);
  });

  test("spacing-only formatter diff of a build task is validated and pushed without a model call", async () => {
    const w = world({ log: FMT_LOG });
    const db = fresh(w.head);
    const first = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(first.queued, ["app#7"]);
    const task = rows(db, "SELECT id, step, head_sha, plan FROM build_tasks")[0]!;
    assert.deepEqual([task.step, task.head_sha], ["cifix", w.head]);
    // Waiting for the task: nothing to do, not a candidate again.
    assert.deepEqual([selectCifix(db, "app").work.length, selectCifix(db, "app").collect.length], [0, 0]);
    db.prepare("UPDATE build_tasks SET state = 'done', ended_at = ? WHERE id = ?").run(T2, Number(task.id));
    const tmp = tempPath(Number(task.id));
    writeFileSync(tmp, diffText);
    storeArtifact(db, Number(task.id), FORMAT_ARTIFACT, tmp);
    assert.equal(selectCifix(db, "app").collect.length, 1);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/fix");
    assert.equal(git(w.fork, "show", `${pushed}:src/lib.rs`), "fn a() { }\nfn main() { b(); }");
    assert.match(git(w.fork, "log", "-1", "--format=%B", pushed), /^Fix formatting for CI/);
    assert.ok(!w.log.includes("model") && !w.log.includes("check"));
    assert.deepEqual(rows(db, "SELECT kind, state FROM ci_fixes"), [{ kind: "format", state: "pushed" }]);
  });

  test("a formatter that changed nothing means the failure is not formatting: the try fails", async () => {
    const w = world({ log: FMT_LOG });
    const db = fresh(w.head);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    db.prepare("UPDATE build_tasks SET state = 'done', ended_at = ?").run(T2);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.pushed, s.failed.length], [[], 1]);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "failed" }]);
  });

  test("diff -ruN output becomes a git-format diff", () => {
    assert.match(gitFormatDiff(diffText), /^diff --git a\/src\/lib\.rs b\/src\/lib\.rs\n--- a\/src\/lib\.rs\n\+\+\+ b\/src\/lib\.rs\n@@/);
  });
});

describe("infrastructure failure", () => {
  test("is rerun once per head, never twice", async () => {
    const w = world({ log: INFRA_LOG });
    const db = fresh(w.head, { ci: true });
    const first = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(first.infra, ["app#7"]);
    assert.ok(!w.log.includes("model"));
    assert.equal(selectCifix(db, "app").rerun.length, 1);
    // The rerun is on record before the gh call is made.
    const seen: unknown[] = [];
    const inner = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => {
      if (cmd === "gh" && args[0] === "run") seen.push(rows(db, "SELECT state FROM ci_fixes WHERE state LIKE 'rerun%'"));
      return inner(cmd, args, o);
    };
    const r = await runRerun(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(seen, [[{ state: "rerunning" }]]);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes WHERE state LIKE 'rerun%'"), [{ state: "rerun" }]);
    assert.deepEqual(r.reran, ["app#7"]);
    assert.deepEqual(w.log.filter((l) => l.startsWith("rerun")), ["rerun 11"]);
    assert.deepEqual(rows(db, "SELECT action, target FROM audit WHERE action = 'ci-rerun'"), [{ action: "ci-rerun", target: "app#7" }]);
    // The checks were not read since: wait. Once they were and the failure repeats as infra, it is a failed try, not a second rerun.
    assert.equal(classifyCifix(db, "app")[0]!.bucket, "rerun-wait");
    assert.equal((await runRerun(db, { repo: "app", dryRun: false }, () => {}, w.deps)).reran.length, 0);
    db.prepare("UPDATE pr_checks SET fetched_at = ?").run("2026-01-04T00:00:00Z");
    const again = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([again.infra, again.failed.length], [[], 1]);
    assert.equal((await runRerun(db, { repo: "app", dryRun: false }, () => {}, w.deps)).reran.length, 0);
    assert.equal(w.log.filter((l) => l.startsWith("rerun")).length, 1);
  });

  test("results that predate the rerun are not judged as infra again", async () => {
    const w = world({ log: INFRA_LOG, completedAt: "2026-01-02T00:00:00Z" });
    const db = fresh(w.head, { ci: true });
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    await runRerun(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    db.prepare("UPDATE pr_checks SET fetched_at = ?").run("2026-01-04T00:00:00Z");
    let handled = 0;
    const again = await runCifix(db, { repo: "app", dryRun: false, onHandled: () => handled++ }, () => {}, w.deps);
    assert.deepEqual([again.infra, again.failed], [[], []]);
    assert.equal(handled, 0, "waiting for rerun results does not use the step's limit");
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes ORDER BY rowid"), [{ state: "infra" }, { state: "rerun" }]);
  });

  test("a rerun needs the repo's CI approval", async () => {
    const w = world({ log: INFRA_LOG });
    const db = fresh(w.head);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(selectCifix(db, "app").rerun.length, 0);
  });

  test("a failure after the rerun that is a code error goes to the model", async () => {
    const w = world({ log: CODE_LOG });
    const db = fresh(w.head, { ci: true });
    db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, runs, created_at) VALUES ('app', 7, ?, 'infra', 'infra', 1, '[11]', ?)").run(w.head, T0);
    db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, attempt, runs, created_at) VALUES ('app', 7, ?, 'infra', 'rerun', 0, '[11]', ?)").run(w.head, T0);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
  });
});

describe("unsure carries across the pushed head", () => {
  const review = (sure: boolean) => ({ ref: "x", verdict: "take" as const, sure, reason: sure ? "sure" : "unsure", fixes: [], risks: ["r"], summary: null, why: null, public: null });
  const save = (db: DatabaseSync, head: string, sure: boolean) => saveOpus(db, null, { repo: "app", number: 1, head_oid: head }, { mode: "full", base: null, model: "m", review: review(sure) });

  test("an unsure review before a CI fix push still needs a person's merge answer at the new head", () => {
    const db = freshQueueDb([{ n: 1 }]);
    db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
    db.prepare("DELETE FROM opus_reviews").run();
    save(db, "sha1", false);
    askMergeDecisions(db, { at: QT1 });
    db.prepare("INSERT INTO ci_fixes (repo, number, head, to_head, kind, state, attempt, created_at) VALUES ('app', 1, 'sha1', 'sha1c', 'code', 'pushed', 1, ?)").run(QT1);
    db.prepare("UPDATE items SET head_oid = 'sha1c' WHERE number = 1").run();
    db.prepare("UPDATE pr_checks SET head_oid = 'sha1c' WHERE number = 1").run();
    db.prepare("UPDATE verifications SET head_sha = 'sha1c' WHERE number = 1").run();
    save(db, "sha1c", true);
    const e = buildQueue(db, { merged: "exclude" }).find((x) => x.number === 1)!;
    assert.ok(e.outsideRule.includes("Opus was unsure"));
    assert.equal(eligible(e), false);
  });
});

describe("exits record their state", () => {
  test("a gate that passed with only an optional check failing is skipped, not a try", async () => {
    const w = world({ checkRuns: [
      { name: "gate / test", status: "completed", conclusion: "success", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" },
      { name: "optional / lint", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/12/job/6" },
    ] });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.skipped, s.failed, s.pushed], [["app#7"], [], []]);
    assert.deepEqual(ops(w), []);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "skipped" }]);
    assert.equal(classifyCifix(db, "app")[0]!.bucket, "done");
  });

  test("a failure that is not a failed check run (a status, a run waiting for approval) is skipped without a try", async () => {
    const w = world({ checkRuns: [{ name: "build", status: "completed", conclusion: "action_required", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" }] });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.skipped, ["app#7"]);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "skipped" }]);
  });

  test("a cancelled run is skipped without a try and without a rerun", async () => {
    const w = world({ conclusion: "cancelled" });
    const db = fresh(w.head, { ci: true });
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.skipped, s.infra], [["app#7"], []]);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "skipped" }]);
    assert.equal(selectCifix(db, "app").rerun.length, 0);
    assert.ok(!w.log.includes("model"));
  });

  test("a head that moved between the read and the fetch fails the try and is noted live", async () => {
    const w = world();
    const db = fresh(w.head);
    const moved = git(w.fork, "commit-tree", `${w.head}^{tree}`, "-m", "moved");
    git(w.fork, "update-ref", "refs/pull/7/head", moved);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(s.failed.length, 1);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "failed" }]);
    assert.ok(!w.log.includes("model"));
    assert.equal((rows(db, "SELECT head_oid FROM pr_checks")[0] as { head_oid: string }).head_oid, moved);
  });

  test("a PR that closed during the model calls fails the try", async () => {
    const w = world({ closedAfter: 1 });
    const db = fresh(w.head);
    const s = await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([s.pushed, s.failed.length], [[], 1]);
    assert.ok(!w.log.includes("push"));
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "failed" }]);
  });

  test("a patch comment that fails is final: no retry, no second model call", async () => {
    const w = world({ canModify: false, commentFails: true });
    const db = fresh(w.head, { canModify: false, comment: true });
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(w.log.filter((l) => l === "model").length, 1);
    assert.deepEqual(rows(db, "SELECT state FROM ci_fixes"), [{ state: "comment-failed" }]);
    assert.equal(classifyCifix(db, "app")[0]!.bucket, "done");
  });
});

describe("pushes are recorded before they happen", () => {
  test("the ci_fixes row exists, with the commit about to be pushed, when the push runs", async () => {
    const w = world();
    const db = fresh(w.head);
    const seen: unknown[] = [];
    const inner = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => {
      if (args.includes("push")) seen.push(rows(db, "SELECT state, head, to_head FROM ci_fixes"));
      return inner(cmd, args, o);
    };
    await runCifix(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const pushed = git(w.fork, "rev-parse", "refs/heads/fix");
    assert.deepEqual(seen, [[{ state: "pushing", head: w.head, to_head: pushed }]]);
    assert.deepEqual(rows(db, "SELECT state, to_head FROM ci_fixes"), [{ state: "pushed", to_head: pushed }]);
  });

  test("a push whose record never happened (crash) still carries an unsure review to the new head, for every pipeline push", () => {
    for (const [table, from] of [["ci_fixes", "head"], ["fixups", "from_head"], ["conflict_merges", "from_head"]] as const) {
      const db = freshQueueDb([{ n: 1 }]);
      db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
      db.prepare("DELETE FROM opus_reviews").run();
      saveOpus(db, null, { repo: "app", number: 1, head_oid: "sha1" }, { mode: "full", base: null, model: "m", review: { ref: "x", verdict: "take", sure: false, reason: "unsure", fixes: [], risks: ["r"], summary: null, why: null, public: null } });
      askMergeDecisions(db, { at: QT1 });
      db.prepare(`INSERT INTO ${table} (repo, number, ${from}, to_head, ${table === "ci_fixes" ? "kind, " : ""}state, attempt, created_at) VALUES ('app', 1, 'sha1', 'sha1c', ${table === "ci_fixes" ? "'code', " : ""}'pushing', 1, ?)`).run(QT1);
      db.prepare("UPDATE items SET head_oid = 'sha1c' WHERE number = 1").run();
      db.prepare("UPDATE pr_checks SET head_oid = 'sha1c' WHERE number = 1").run();
      db.prepare("UPDATE verifications SET head_sha = 'sha1c' WHERE number = 1").run();
      saveOpus(db, null, { repo: "app", number: 1, head_oid: "sha1c" }, { mode: "full", base: null, model: "m", review: { ref: "x", verdict: "take", sure: true, reason: "sure", fixes: [], risks: ["r"], summary: null, why: null, public: null } });
      const e = buildQueue(db, { merged: "exclude" }).find((x) => x.number === 1)!;
      assert.ok(e.outsideRule.includes("Opus was unsure"), table);
    }
  });
});

test("the token check sees raw strings with many hashes and a shebang line", () => {
  const h = "#".repeat(40);
  const raw = (body: string) => `fn f() { let s = r${h}"${body}"${h}; } // "\n`;
  assert.notEqual(formattingOnly("a.rs", raw(" a \" b + c "), raw(" a \" b+c ")), null);
  const bang = (s: string) => `#!/x "\nfn f() { let s = "${s}"; }\n`;
  assert.notEqual(formattingOnly("a.rs", bang("a + b"), bang("a+b")), null);
  assert.equal(formattingOnly("a.rs", bang("a + b"), bang("a + b").replace("fn f() {", "fn f()  {")), null);
});
