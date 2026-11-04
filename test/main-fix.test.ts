// Red default branch: a flaky failure is rerun once and a second red is a code failure; an infrastructure failure becomes
// one decision and an issue only on the operator's answer; a repo without the approval is left alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { mainCiRepos, saveHead } from "../src/mainci/index.ts";
import { runMainFix, type MainFixDeps, type Verdict } from "../src/mainfix/index.ts";
import { setMainFixApproval } from "../src/mainfix/approval.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { SCRATCH } from "./scratch.ts";

const REPO = "alpha";
const checkRuns = JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/o/alpha/actions/runs/55", completed_at: "2026-11-01T10:05:00Z" }] });
const failedLog = "test\tcargo test\t2026-11-01T10:04:00.0000000Z error: Timeout was reached, token=abcdef0123456789abcdef0123456789\n";

function setup(approved: boolean) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(mkdtempSync(join(SCRATCH, "mainfix-")), "t.db"));
  db.prepare("INSERT INTO repos (name, synced_at) VALUES (?, ?)").run(REPO, "2026-11-01T00:00:00Z");
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES (?, 'test', '2026-11-01')").run(REPO);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  if (approved) setMainFixApproval(db, "op", REPO, true);
  const execs: { args: string[]; input?: string }[] = [];
  let clock = Date.parse("2026-11-01T10:10:00Z");
  let verdict: Verdict["verdict"] = "code";
  let classified = 0;
  const deps: MainFixDeps = {
    gh: async (args) => (args[0] === "api" ? checkRuns : failedLog),
    exec: async (_cmd, args, opts) => {
      execs.push({ args, input: opts?.input });
      return { code: 0, stdout: args[0] === "issue" ? "https://github.com/o/alpha/issues/12\n" : "", stderr: "" };
    },
    classify: async (_db, input) => { classified++; return input.checks.map((c) => ({ check: c.check, verdict, reason: `${verdict} failure` })); },
    now: () => new Date(clock),
  };
  const head = (sha: string, state: "failure" | "success" | "pending", at: string) =>
    saveHead(db, { repo: REPO, branch: "main", sha, committedAt: at, headline: "Merge pull request #7 from x/y", checks: [{ name: "gate / test", state, url: null }] }, at);
  return { db, deps, execs, head, setVerdict: (v: Verdict["verdict"]) => { verdict = v; }, tick: (ms: number) => { clock += ms; }, classified: () => classified };
}

const rows = (db: DatabaseSync) => db.prepare('SELECT "check", verdict, state, reason FROM main_fixes ORDER BY "check"').all() as Record<string, string>[];
const log = () => {};

test("flaky: one rerun at the head, a second red is a code failure", async () => {
  const t = setup(true);
  t.setVerdict("flaky");
  t.head("aaa111", "failure", "2026-11-01T10:00:00Z");
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  assert.deepEqual(t.execs.map((e) => e.args.slice(0, 4)), [["run", "rerun", "55", "--failed"]]);
  assert.equal(rows(t.db)[0]!.state, "rerun-requested");
  assert.equal(mainCiRepos(t.db)[0]!.autocraft, "rerunning failed jobs");

  // Still waiting: no new rerun, no new classification.
  t.tick(60_000);
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  assert.equal(t.execs.length, 1);
  assert.equal(t.classified(), 1);
  assert.equal(rows(t.db)[0]!.state, "rerun-requested");

  // The rerun ran and failed again: the poll saw the state move on and back to red.
  t.tick(60_000);
  const later = new Date(Date.parse("2026-11-01T10:10:00Z") + 5 * 60_000).toISOString();
  t.head("aaa111", "pending", later);
  t.head("aaa111", "failure", new Date(Date.parse(later) + 60_000).toISOString());
  t.tick(10 * 60_000);
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  assert.equal(t.execs.length, 1, "never a second rerun");
  assert.deepEqual(rows(t.db).map((r) => [r.verdict, r.state]), [["code", "needs-fix"]]);
  assert.equal(mainCiRepos(t.db)[0]!.autocraft, "needs a fix");
});

test("infra: one decision per check, an issue with the operator note only on Open issue", async () => {
  const t = setup(true);
  t.setVerdict("infra");
  t.head("bbb222", "failure", "2026-11-01T10:00:00Z");
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  t.head("ccc333", "failure", "2026-11-01T10:20:00Z");
  t.tick(30 * 60_000);
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  const decisions = t.db.prepare("SELECT id, kind, options, public_text FROM decisions").all() as { id: string; kind: string; options: string; public_text: string }[];
  assert.equal(decisions.length, 1, "a later head of the same red run asks nothing new");
  assert.equal(decisions[0]!.kind, "other");
  assert.deepEqual((JSON.parse(decisions[0]!.options) as { label: string }[]).map((o) => o.label), ["Open issue", "Not now"]);
  assert.match(decisions[0]!.public_text, /gate \/ test/);
  assert.doesNotMatch(decisions[0]!.public_text, /abcdef0123456789abcdef0123456789/);
  assert.equal(t.execs.length, 0, "nothing is posted before the answer");
  assert.equal(mainCiRepos(t.db)[0]!.autocraft, "asked an operator");

  t.db.prepare("UPDATE decisions SET answer = 'open-issue', answered_by = 'op', answered_at = ? WHERE id = ?").run("2026-11-01T11:00:00Z", decisions[0]!.id);
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  await runMainFix(t.db, { repo: REPO }, log, t.deps);
  const issues = t.execs.filter((e) => e.args[0] === "issue");
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.input ?? "", /^_AI-generated reply \(Haiku\)_/);
  assert.match(issues[0]!.input ?? "", /gate \/ test/);
  assert.match(rows(t.db).map((r) => r.state).join(), /issue-opened/);
  assert.ok((t.db.prepare("SELECT applied_at FROM decisions").get() as { applied_at: string | null }).applied_at);
});

test("a repo without the Fix red main approval is left alone", async () => {
  const t = setup(false);
  t.setVerdict("flaky");
  t.head("ddd444", "failure", "2026-11-01T10:00:00Z");
  const s = await runMainFix(t.db, { repo: REPO }, log, t.deps);
  assert.match(s.note ?? "", /not approved/);
  assert.equal(t.classified(), 0);
  assert.equal(t.execs.length, 0);
  assert.deepEqual(rows(t.db), []);
  assert.equal(mainCiRepos(t.db)[0]!.autocraft, null);
});

// ---- the fix PR ---------------------------------------------------------------------

const CODE_LOG = "test\tcargo test\t2026-11-01T10:04:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-11-01T10:04:01Z  --> src/lib.rs:2:20\n";
const GOOD = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { b(); }\n+fn b() {}\n+fn main() { b(); }\n";
const APPROVE = JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] });
const REJECT = JSON.stringify({ verdict: "reject", reasons: "hides the error", problems: ["silences it"] });
const RED_AT = "2026-11-01T10:00:00Z";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare repository that serves as both the upstream and the pipeline's fork, with the red head on `main`. */
function fixWorld(o: { check?: string | null; prFiles?: string } = {}) {
  const t = setup(true);
  t.setVerdict("code");
  const root = mkdtempSync(join(SCRATCH, "mainfix-git-"));
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "src/lib.rs"), "fn a() {}\nfn main() { b(); }\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Merge pull request #7 from x/y");
  const sha = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  const log: string[] = [];
  const created: string[] = [];
  const run: Exec = async (cmd, args, opts = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      log.push(`gh ${args.slice(0, 2).join(" ")}`);
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      if (args[0] === "api") return { code: 0, stdout: `storytold/${REPO}\n`, stderr: "" };
      if (args[1] === "list") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "create") { created.push(`${args.join(" ")}\n${opts.input ?? ""}`); return { code: 0, stdout: `https://github.com/storytold/${REPO}/pull/31\n`, stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }
    const net = args.some((a) => a.startsWith("https://github.com/"));
    if (args.includes("push")) log.push("push");
    const mapped = args.map((a) => (a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    return exec("git", net ? mapped : args, { ...opts });
  };
  const checks = JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/o/alpha/actions/runs/55", completed_at: "2026-11-01T10:05:00Z" }] });
  t.deps.exec = run;
  t.deps.gh = async (args) => {
    if (args[0] === "api" && args[1]!.includes("/pulls/")) return o.prFiles ?? "README.md\n";
    return args[0] === "api" ? checks : CODE_LOG;
  };
  t.deps.fix = {
    root: join(root, "cache"),
    ask: async () => { log.push("model"); return GOOD; },
    check: async () => { log.push("check"); return o.check === undefined ? APPROVE : o.check; },
  };
  t.head(sha, "failure", RED_AT);
  const branches = () => git(fork, "branch", "--list", "autocraft/*").split("\n").map((l) => l.trim()).filter(Boolean);
  return { ...t, sha, log, created, branches };
}

test("a code failure: patch, Opus check, push to autocraft/main-ci-…, PR with the note, the row records it, one attempt", async () => {
  const w = fixWorld();
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  assert.deepEqual(w.branches(), [`autocraft/main-ci-gate-test-${w.sha.slice(0, 7)}`]);
  assert.equal(w.created.length, 1);
  const pr = w.created[0]!;
  assert.match(pr, /--base main --head pipeline-bot:autocraft\/main-ci-gate-test-/);
  assert.match(pr, /--title Fix main CI: gate \/ test/);
  assert.match(pr, /_AI-generated pull request \(Sonnet\)\./);
  assert.match(pr, /Failing check: `gate \/ test` \(https:\/\/github.com\/storytold\/alpha\/actions\/runs\/55\)/);
  assert.match(pr, /Culprit: [0-9a-f]{8} \(#7\)/);
  assert.match(pr, /`src\/lib.rs`/);
  const r = w.db.prepare('SELECT state, pr_number, pr_url FROM main_fixes').get() as { state: string; pr_number: number; pr_url: string };
  assert.deepEqual({ ...r }, { state: "pr-opened", pr_number: 31, pr_url: "https://github.com/storytold/alpha/pull/31" });
  assert.equal(mainCiRepos(w.db)[0]!.autocraft, "opened fix PR #31");

  // One attempt per (repo, head, check).
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  assert.equal(w.created.length, 1);
  assert.equal(w.log.filter((l) => l === "model").length, 1);

  // The merge queue counts it as our own Fix PR.
  w.db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_ref, head_oid, created_at, updated_at) VALUES (?, 31, 'pr', 'OPEN', 'Fix main CI: gate / test', 'pipeline-bot', 'autocraft/main-ci-gate-test-x', 'h', ?, ?)").run(REPO, RED_AT, RED_AT);
  w.db.prepare("UPDATE tracked_repos SET pipeline = 1").run();
  w.db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES (?, 31, 'h', 'rv', ?, 'm', 'take', 'ok', '[]', 1, 'full')").run(REPO, RED_AT);
  const e = buildQueue(w.db, { repo: REPO }).find((x) => x.number === 31);
  assert.equal(e?.tier, "whitelisted");
  assert.equal(e?.mainFix, true);
});

test("an open PR updated after the red that touches the failing file: nothing to do, naming the PR", async () => {
  const w = fixWorld({ prFiles: "src/lib.rs\nREADME.md\n" });
  w.db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, 9, 'pr', 'OPEN', 'Rename b', 'someone', '2026-10-01T00:00:00Z', '2026-11-01T10:30:00Z')").run(REPO);
  // Opened before the red and not touched since: not counted.
  w.db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, 8, 'pr', 'OPEN', 'Old', 'someone', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')").run(REPO);
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  const r = w.db.prepare("SELECT state, reason FROM main_fixes").get() as { state: string; reason: string };
  assert.equal(r.state, "nothing-to-do");
  assert.match(r.reason, /#9\b/);
  assert.deepEqual(w.log.filter((l) => l === "model" || l === "push"), []);
  assert.equal(w.created.length, 0);
});

test("an open PR that names the failing check in its title: nothing to do", async () => {
  const w = fixWorld();
  w.db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, 12, 'pr', 'OPEN', 'Make gate / test pass again', 'someone', ?, ?)").run(REPO, "2026-11-01T10:30:00Z", "2026-11-01T10:30:00Z");
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  assert.match((w.db.prepare("SELECT reason FROM main_fixes").get() as { reason: string }).reason, /#12\b/);
  assert.equal(w.created.length, 0);
});

test("main green again before the attempt: nothing to do, nothing written", async () => {
  const w = fixWorld();
  await runMainFix(w.db, { repo: REPO }, log, { ...w.deps, fix: undefined });
  assert.equal(rows(w.db)[0]!.state, "needs-fix");
  w.head(w.sha, "success", "2026-11-01T10:20:00Z");
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  assert.deepEqual(rows(w.db).map((r) => [r.state, r.reason]), [["nothing-to-do", "main is green again"]]);
  assert.deepEqual(w.log.filter((l) => l === "model" || l === "push"), []);
  assert.equal(w.created.length, 0);
});

test("Opus rejects the patch: fix-failed, needs a person, nothing pushed", async () => {
  const w = fixWorld({ check: REJECT });
  await runMainFix(w.db, { repo: REPO }, log, w.deps);
  const r = w.db.prepare("SELECT state, reason FROM main_fixes").get() as { state: string; reason: string };
  assert.equal(r.state, "fix-failed");
  assert.match(r.reason, /Opus rejected the patch/);
  assert.deepEqual(w.branches(), []);
  assert.equal(w.created.length, 0);
  assert.equal(mainCiRepos(w.db)[0]!.autocraft, "needs a person");
});
