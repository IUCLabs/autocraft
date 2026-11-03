import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { runMerge, type CommandResult, type MergeDeps } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "merge-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

type Pr = { n: number; verdict?: string; lines?: number; label?: string; author?: string; ci?: "SUCCESS" | "FAILURE" | "PENDING"; mergeable?: string; reviewHead?: string; verify?: string | null; verifyHead?: string };

// #1 meets every part of the rule; each other PR breaks exactly one part.
const PRS: Pr[] = [
  { n: 1 },
  { n: 2, verdict: "take-fix" },
  { n: 3, lines: 400 },
  { n: 4, label: "missing feature" },
  { n: 5, author: "stranger" },
  { n: 6, ci: "FAILURE" },
  { n: 7, ci: "PENDING" },
  { n: 8, mergeable: "CONFLICTING" },
  { n: 9, verdict: "hold" },
  { n: 10, reviewHead: "old10" },
  { n: 11, label: "infra", lines: 120 },
  { n: 12, verify: null },
  { n: 13, verify: "running" },
  { n: 14, verify: "failed" },
  { n: 15, verify: "error" },
  { n: 16, verify: "ci-enough" },
  { n: 17, verifyHead: "old17" },
  { n: 18, author: "stranger", verify: "planned" },
];

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', ?, 'pr', 'OPEN', ?, ?, ?, 0, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', ?, '[]', '{"top":0.95}')`);
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', ?, ?, 'looks right', ?)`);
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', ?, ?, 'OPEN', 0, ?, '[]', ?, 1, '${T1}')`);
  for (const p of PRS) {
    const lines = p.lines ?? 20;
    item.run(p.n, `PR ${p.n}`, p.author ?? "regular", lines, `sha${p.n}`);
    jev.run(p.n, p.label ?? "bugfix");
    const verdict = p.verdict ?? "take";
    review.run(p.n, p.reviewHead ?? `sha${p.n}`, lines <= 50 ? "S" : lines <= 300 ? "M" : "L", verdict, verdict === "take-fix" ? '[{"file":"a.rs","change":"x"}]' : null);
    if (p.verify !== null) {
      db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, summary, note, created_at) VALUES ('app', ?, ?, 'tests', 'r', ?, ?, ?, '${T0}')`)
        .run(p.n, p.verifyHead ?? `sha${p.n}`, p.verify ?? "passed", (p.verify ?? "passed") === "failed" ? "cargo test failed" : null, (p.verify ?? "passed") === "passed" ? "also passes on base" : null);
    }
    checks.run(p.n, `sha${p.n}`, (p.ci ?? "SUCCESS").toLowerCase(), p.mergeable ?? "MERGEABLE");
  }
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('helper', 'maintainer')").run();
  finalizeReviews(db);
  return db;
}

type Log = string[];
type Fake = { heads?: Map<number, string>; authors?: Map<number, string[]>; assignees?: Map<number, string[]>; exit?: Map<number, CommandResult> };

/** GitHub and merge-command stand-ins; every call goes into `log` in order. */
function fakes(log: Log, f: Fake = {}): MergeDeps & { calls: () => number } {
  let n = 0;
  const querier: Querier = {
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      n++;
      const v = vars as { n?: number; id?: string };
      if (query.includes("viewer")) { log.push("viewer"); return { viewer: { login: "pipeline-bot", id: "U1" } }; }
      if (query.startsWith("mutation")) { log.push(`assign ${v.id}`); return { addAssigneesToAssignable: { clientMutationId: null } }; }
      if (v.n !== undefined) {
        log.push(`info ${v.n}`);
        const authors = f.authors?.get(v.n) ?? ["regular"];
        return { repository: { pullRequest: {
          id: `PR${v.n}`, headRefOid: f.heads?.get(v.n) ?? `sha${v.n}`, state: "OPEN",
          assignees: { nodes: (f.assignees?.get(v.n) ?? []).map((login) => ({ login })) },
          commits: { totalCount: authors.length, nodes: authors.map((login) => ({ commit: { authors: { nodes: [{ email: `${login}@x`, name: login, user: { login } }] } } })) },
        } } };
      }
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      log.push(`checks ${nums.join(",")}`);
      return { repository: Object.fromEntries(nums.map((x) => [`pr${x}`, {
        number: x, state: "OPEN", isDraft: false, headRefOid: f.heads?.get(x) ?? `sha${x}`, mergeable: "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
      }])) };
    },
  };
  return {
    querier, now: () => new Date(T1), mergeCommand: "safe-merge-test",
    async run(cmd, args) {
      n++;
      log.push(`${cmd} ${args.join(" ")}`);
      return f.exit?.get(Number(args[1])) ?? { code: 0, stdout: "merged", stderr: "" };
    },
    calls: () => n,
  };
}

const answer = (db: DatabaseSync, id: string, by: string, key: string) =>
  db.prepare("UPDATE decisions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(key, by, T1, id);
const count = (db: DatabaseSync, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const stateOf = (db: DatabaseSync, n: number) => buildQueue(db, { repo: "app" }).find((e) => e.number === n)?.state;
const quiet = () => {};

describe("merge queue", () => {
  test("each rule part failing alone keeps a PR from merging without asking", () => {
    const db = fresh();
    const q = buildQueue(db, { repo: "app" });
    const states = Object.fromEntries(q.map((e) => [e.number, e.state]));
    assert.deepEqual(states, {
      1: "ready", 2: "needs-fix-up", 3: "needs-decision", 4: "needs-decision", 5: "needs-decision",
      6: "ci-failed", 7: "waiting-ci", 8: "conflict", 11: "ready",
      12: "waiting-verify", 13: "waiting-verify", 14: "verify-failed", 15: "verify-error", 16: "ready", 17: "waiting-verify", 18: "waiting-verify",
    });
    assert.deepEqual(q.filter(eligible).map((e) => e.number), [1, 11, 16]);
    assert.deepEqual({ ...q.find((e) => e.number === 14)!.verify }, { state: "failed", kind: "tests", summary: "cargo test failed", note: null });
    assert.equal(q.find((e) => e.number === 12)!.verify, null);
    assert.equal(q.find((e) => e.number === 17)!.verify, null);
    assert.deepEqual(q.find((e) => e.number === 3)!.outsideRule, ["size L"]);
    assert.deepEqual(q.find((e) => e.number === 5)!.outsideRule, ["author not on the whitelist"]);
  });

  test("dry run calls nothing and writes nothing", async () => {
    const db = fresh();
    const before = ["stages", "decisions", "merges", "audit"].map((t) => count(db, t));
    const log: Log = [];
    const deps = fakes(log);
    const s = await runMerge(db, { repo: "app" }, quiet, deps);
    assert.equal(s.dryRun, true);
    assert.deepEqual(s.attempted, ["app#1", "app#11", "app#16"]);
    assert.equal(s.asked.length, 3);
    assert.equal(deps.calls(), 0);
    assert.deepEqual(["stages", "decisions", "merges", "audit"].map((t) => count(db, t)), before);
  });

  test("merges by the rule, assigning first, and asks Merge? once per head", async () => {
    const db = fresh();
    const log: Log = [];
    const s = await runMerge(db, { repo: "app", dryRun: false }, quiet, fakes(log, { assignees: new Map([[11, ["someone"]]]) }));
    assert.deepEqual(s.merged, ["app#1", "app#11", "app#16"]);
    assert.deepEqual(log.slice(0, 8), [
      "checks 1", "info 1", "viewer", "assign PR1", "safe-merge-test storytold/app 1 --squash",
      "checks 11", "info 11", "safe-merge-test storytold/app 11 --squash",
    ]);
    assert.deepEqual(s.asked.sort(), [3, 4, 5].map((n) => mergeDecisionId("app", n, `sha${n}`)));
    const facts = JSON.parse((db.prepare("SELECT facts FROM decisions WHERE id = ?").get(mergeDecisionId("app", 3, "sha3")) as { facts: string }).facts) as string[];
    assert.ok(facts.includes("head commit sha3"));
    assert.equal(stateOf(db, 1), "merged");
    assert.equal(count(db, "merges"), 3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM stages WHERE stage = 'merged'").get() as { n: number }).n, 3);
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM stages WHERE stage = 'batched'").get() as { n: number }).n >= 9);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'merge'").get() as { n: number }).n, 3);

    const again = await runMerge(db, { repo: "app", dryRun: false }, quiet, fakes([]));
    assert.deepEqual(again.asked, []);
    assert.deepEqual(again.merged, []);
    assert.equal(count(db, "decisions"), 3);
  });

  test("an operator's merge answer makes a PR eligible; others' answers are ignored", async () => {
    const db = fresh();
    await runMerge(db, { repo: "app", dryRun: false, limit: 0 }, quiet, fakes([]));
    answer(db, mergeDecisionId("app", 5, "sha5"), "op", "merge");
    answer(db, mergeDecisionId("app", 4, "sha4"), "helper", "merge");
    answer(db, mergeDecisionId("app", 3, "sha3"), "op", "hold");
    assert.equal(stateOf(db, 5), "decision-answered-merge");
    assert.equal(stateOf(db, 4), "needs-decision");
    assert.equal(stateOf(db, 3), "declined");
    const log: Log = [];
    const s = await runMerge(db, { repo: "app", dryRun: false }, quiet, fakes(log));
    assert.deepEqual(s.merged, ["app#1", "app#11", "app#16", "app#5"]);
    assert.ok(!log.some((l) => / storytold\/app [34] /.test(l)));
    assert.ok((db.prepare("SELECT applied_at FROM decisions WHERE id = ?").get(mergeDecisionId("app", 5, "sha5")) as { applied_at: string | null }).applied_at);
  });

  test("a head that moved since the operator's answer is refused", async () => {
    const db = fresh();
    await runMerge(db, { repo: "app", dryRun: false, limit: 0 }, quiet, fakes([]));
    answer(db, mergeDecisionId("app", 5, "sha5"), "op", "merge");
    const log: Log = [];
    const s = await runMerge(db, { repo: "app", dryRun: false, limit: 4 }, quiet, fakes(log, { heads: new Map([[5, "sha5b"]]) }));
    assert.deepEqual(s.merged, ["app#1", "app#11", "app#16"]);
    assert.match(s.refused.find((r) => r.ref === "app#5")!.reason, /head moved/);
    assert.ok(!log.some((l) => l.includes("storytold/app 5")));
  });

  test("commits by several authors merge with --merge", async () => {
    const db = fresh();
    const log: Log = [];
    await runMerge(db, { repo: "app", dryRun: false, limit: 1 }, quiet, fakes(log, { authors: new Map([[1, ["regular", "helper"]]]) }));
    assert.ok(log.includes("safe-merge-test storytold/app 1 --merge"));
    assert.ok(!log.some((l) => l.includes("--allow-pending")));
  });

  test("a refusal is recorded and the PR stays in the queue", async () => {
    const db = fresh();
    const exit = new Map([[1, { code: 1, stdout: "", stderr: "refusing: check 'ci' is pending\n" }]]);
    const s = await runMerge(db, { repo: "app", dryRun: false, limit: 1 }, quiet, fakes([], { exit }));
    assert.deepEqual(s.merged, []);
    assert.equal(s.refused[0]!.reason, "safe-merge-test: refusing: check 'ci' is pending");
    const e = buildQueue(db, { repo: "app" }).find((x) => x.number === 1)!;
    assert.equal(e.state, "refused");
    assert.equal(e.refusedReason, "safe-merge-test: refusing: check 'ci' is pending");
    assert.ok(eligible(e));
  });

  test("an unexpected error stops the run", async () => {
    const db = fresh();
    const deps = fakes([]);
    deps.run = async () => { throw new Error("spawn safe-merge-test ENOENT"); };
    await assert.rejects(runMerge(db, { repo: "app", dryRun: false }, quiet, deps), /ENOENT/);
    assert.equal(count(db, "merges"), 0);
  });

  test("Merge? is asked only for PRs whose verification passed or said CI is enough", async () => {
    const db = fresh();
    const s = await runMerge(db, { repo: "app", dryRun: false, limit: 0 }, quiet, fakes([]));
    assert.deepEqual(s.asked.sort(), [3, 4, 5].map((n) => mergeDecisionId("app", n, `sha${n}`)));
    assert.equal(stateOf(db, 18), "waiting-verify");
    const facts = JSON.parse((db.prepare("SELECT facts FROM decisions WHERE id = ?").get(mergeDecisionId("app", 5, "sha5")) as { facts: string }).facts) as string[];
    assert.ok(facts.includes("verify: tests, passed: also passes on base"));
    db.prepare("UPDATE verifications SET state = 'ci-enough' WHERE number = 18").run();
    assert.equal(stateOf(db, 18), "needs-decision");
    db.prepare("UPDATE verifications SET state = 'failed' WHERE number = 18").run();
    assert.equal(stateOf(db, 18), "verify-failed");
  });

  test("an answered merge waits for the verification at the head", () => {
    const db = fresh();
    db.prepare("UPDATE verifications SET state = 'running' WHERE number = 5").run();
    db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, facts, asked_at, answer, answered_by, answered_at)
      VALUES (?, 'merge', 'app', 5, 'Merge this PR?', '[]', '[]', ?, 'merge', 'op', ?)`).run(mergeDecisionId("app", 5, "sha5"), T0, T1);
    assert.equal(stateOf(db, 5), "waiting-verify");
    assert.ok(!buildQueue(db, { repo: "app" }).filter(eligible).some((e) => e.number === 5));
    db.prepare("UPDATE verifications SET state = 'passed' WHERE number = 5").run();
    assert.equal(stateOf(db, 5), "decision-answered-merge");
  });

  test("the pre-merge re-check refuses when the verification is no longer passed at the head", async () => {
    const db = fresh();
    const log: Log = [];
    const deps = fakes(log);
    const query = deps.querier.query.bind(deps.querier);
    // The verification turns stale and a failing one lands for #11 while #1 is being merged.
    deps.querier.query = async (q: string, v: object) => {
      if ((v as { n?: number }).n === 1) db.prepare("UPDATE verifications SET state = 'stale' WHERE number = 11").run();
      return query(q, v);
    };
    db.prepare("UPDATE verifications SET state = 'failed' WHERE number = 16").run();
    const s = await runMerge(db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(s.merged, ["app#1"]);
    assert.match(s.refused.find((r) => r.ref === "app#11")!.reason, /verification at sha11 is stale/);
    assert.ok(!log.some((l) => l.includes("storytold/app 11 ")));
  });
});
