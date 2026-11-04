// Red default branch: a flaky failure is rerun once and a second red is a code failure; an infrastructure failure becomes
// one decision and an issue only on the operator's answer; a repo without the approval is left alone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import { mainCiRepos, saveHead } from "../src/mainci/index.ts";
import { runMainFix, type MainFixDeps, type Verdict } from "../src/mainfix/index.ts";
import { setMainFixApproval } from "../src/mainfix/approval.ts";
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
