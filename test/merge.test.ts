import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { discussionHash } from "../src/review/discussion.ts";
import { runMerge, type CommandResult, type MergeDeps } from "../src/merge/index.ts";
import { buildQueue, eligible, mergeDecisionId } from "../src/merge/queue.ts";
import { runSingles, setSingleMergeMax, singleMergeMax } from "../src/merge/single.ts";
import { setMergeApproval } from "../src/merge/approval.ts";
import { insertBatch } from "../src/merge/batch-store.ts";
import type { DiffFetcher } from "../src/review/diff.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

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
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
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
  setMergeApproval(db, "op", "app", true);
  return db;
}

type Log = string[];
type Fake = { mergeable?: Map<number, string>; heads?: Map<number, string>; authors?: Map<number, string[]>; assignees?: Map<number, string[]>; exit?: Map<number, CommandResult>; /** Counted comments the live discussion query returns for every PR. */ discussion?: unknown[]; /** Latest formal reviews of writers the live query returns for every PR. */ formal?: unknown[] };

/** GitHub and merge-command stand-ins; every call goes into `log` in order. */
function fakes(log: Log, f: Fake = {}): MergeDeps & { calls: () => number } {
  let n = 0;
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      if (query.includes("reviewThreads")) return { repository: { pullRequest: { author: null, comments: { nodes: f.discussion ?? [] }, reviews: { nodes: [] }, formal: { nodes: f.formal ?? [] }, reviewThreads: { nodes: [] } } } };
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
        number: x, state: "OPEN", isDraft: false, headRefOid: f.heads?.get(x) ?? `sha${x}`, mergeable: f.mergeable?.get(x) ?? "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
      }])) };
    },
  });
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

  test("new discussion at merge time holds the PR without a refusal record; once it is reviewed again it merges", async () => {
    const db = fresh();
    const note = { id: "n1", author: { login: "rabbit", __typename: "Bot" }, authorAssociation: "NONE", createdAt: "2026-01-03T00:00:00Z", body: "Major: this breaks the overlap" };
    const log: Log = [];
    const s = await runMerge(db, { repo: "app", dryRun: false, limit: 1 }, quiet, fakes(log, { discussion: [note] }));
    assert.deepEqual(s.merged, []);
    assert.deepEqual(s.refused, []);
    assert.equal(count(db, "merges"), 0);
    assert.ok(!log.some((l) => l.startsWith("safe-merge-test")));
    // A new review of the same head that read the comment: later than the stale mark, with the live snapshot's hash.
    const later = new Date(Date.now() + 60_000).toISOString();
    db.prepare("UPDATE reviews SET at = ?, seen_at = ?, disc_hash = ? WHERE number = 1").run(later, later, discussionHash([{ id: "n1", body: note.body }]));
    db.prepare("UPDATE opus_reviews SET at = ?, seen_at = ?, disc_hash = ? WHERE number = 1").run(later, later, discussionHash([{ id: "n1", body: note.body }]));
    const again = await runMerge(db, { repo: "app", dryRun: false, limit: 1 }, quiet, fakes([], { discussion: [note] }));
    assert.deepEqual(again.merged, ["app#1"]);
  });

  test("a maintainer's changes-requested review found at merge time stops the merge command and shows in the queue", async () => {
    const db = fresh();
    const cr = { id: "r1", author: { login: "ana" }, authorAssociation: "NONE", createdAt: "2026-01-03T00:00:00Z", submittedAt: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED" };
    const log: Log = [];
    const s = await runMerge(db, { repo: "app", dryRun: false, limit: 1 }, quiet, fakes(log, { formal: [cr] }));
    assert.deepEqual([s.merged, s.refused], [[], []]);
    assert.ok(!log.some((l) => l.startsWith("safe-merge-test")));
    assert.equal(stateOf(db, 1), "changes-requested");
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

describe("merging a few ready PRs one at a time", () => {
  // PRs 1, 11 and 16 are ready. Each changes its own file unless `shared` names a file two of them change.
  const diffs = (shared: number[] = []): DiffFetcher => async (_repo, n) => {
    const file = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`;
    return { ok: true, text: file(`src/pr${n}.rs`) + (shared.includes(n) ? file("Cargo.lock") : "") };
  };
  const saved = process.env.AUTOCRAFT_DIFF_CACHE;
  after(() => { if (saved === undefined) delete process.env.AUTOCRAFT_DIFF_CACHE; else process.env.AUTOCRAFT_DIFF_CACHE = saved; });
  const attempt = async (db: DatabaseSync, fetchDiff: DiffFetcher, f: Fake = {}) => {
    process.env.AUTOCRAFT_DIFF_CACHE = mkdtempSync(join(dir, "diffs-"));
    const log: Log = [];
    const r = await runSingles(db, { repo: "app" }, quiet, fakes(log, f), fetchDiff);
    return { r, log };
  };
  const noBatch = (db: DatabaseSync) => count(db, "merge_batches");

  test("PRs with disjoint files merge singly, each re-read from GitHub first, and the first one that is no longer ready ends the round", async () => {
    const db = fresh();
    assert.equal(singleMergeMax(db), 3);
    const { r, log } = await attempt(db, diffs());
    assert.deepEqual(r?.merged, ["app#1", "app#11", "app#16"]);
    assert.deepEqual(log.filter((l) => l.startsWith("checks")), ["checks 1", "checks 11", "checks 16"]);
    assert.equal(noBatch(db), 0);

    const moved = await attempt(fresh(), diffs(), { heads: new Map([[11, "newer"]]) });
    assert.deepEqual(moved.r?.merged, ["app#1"]);
    assert.equal(moved.r?.refused.length, 1);
    assert.ok(!moved.log.some((l) => l.startsWith("checks 16")), "PR 16 waits for the next round");
  });

  test("two PRs changing the same file, more PRs than the limit, or a limit of 0 leave the work to the batches", async () => {
    const db = fresh();
    const { r, log } = await attempt(db, diffs([1, 11]));
    assert.equal(r, null);
    assert.deepEqual(log, []);

    setSingleMergeMax(db, 2, "op");
    assert.equal((await attempt(db, diffs())).r, null);
    setSingleMergeMax(db, 0, "op");
    assert.equal((await attempt(db, diffs())).r, null);
    setSingleMergeMax(db, 3, "op");
    assert.ok((await attempt(db, diffs())).r);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'single-merge-max'").get() as { n: number }).n, 3);
  });

  test("a PR refused on a round does not hold up the next round, and an unreadable diff or a batch in flight leaves the work to the batches", async () => {
    const db = fresh();
    const bad = { exit: new Map([[1, { code: 1, stdout: "", stderr: "refused" }]]) };
    const first = await attempt(db, diffs(), bad);
    assert.deepEqual(first.r?.merged, []);
    assert.equal(first.r?.refused.length, 1);
    const second = await attempt(db, diffs(), bad);
    assert.deepEqual(second.r?.merged, ["app#11", "app#16"]);

    const odd: DiffFetcher = async () => ({ ok: true, text: 'diff --git "a/caf\\303\\251.rs" "b/caf\\303\\251.rs"\n' });
    assert.equal((await attempt(fresh(), odd)).r, null);
    assert.equal((await attempt(fresh(), async () => ({ ok: true, text: "" }))).r, null);

    const busy = fresh();
    insertBatch(busy, { repo: "app", branch: "integration-app-x-1", baseSha: "b", commitSha: "c", parentId: null, taskId: null, members: [{ number: 1, head_oid: "sha1" }], at: T1 });
    assert.equal((await attempt(busy, diffs())).r, null);
  });

  test("a PR whose mergeable state GitHub has not computed after a merge, or one put on Backlog since planning, is left without a record", async () => {
    const db = fresh();
    const unknown = await attempt(db, diffs(), { mergeable: new Map([[11, "UNKNOWN"]]) });
    assert.deepEqual(unknown.r?.merged, ["app#1"]);
    assert.deepEqual(unknown.r?.attempted, ["app#1"]);
    assert.deepEqual(unknown.r?.refused, []);
    assert.equal(count(db, "merges"), 1);
    assert.ok(!unknown.log.some((l) => l.startsWith("checks 16")));

    const db2 = fresh();
    const backlog = (inner: DiffFetcher): DiffFetcher => async (repo, n) => {
      if (n === 16) db2.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer) VALUES ('bk', 'scope', 'app', 11, 'q', '[]', ?, 'backlog')").run(T0);
      return inner(repo, n);
    };
    const held = await attempt(db2, backlog(diffs()));
    assert.deepEqual(held.r?.merged, ["app#1", "app#16"]);
    assert.deepEqual(held.r?.refused, []);
    assert.equal(count(db2, "merges"), 2);
  });
});
