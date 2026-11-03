// Every stage that writes to GitHub or spends a model call reads the item's live state first (docs/pipeline.md, Sync); all GitHub access here is faked.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { activeBatches, admits, batchSizeOf, membersOf, setBatchSize } from "../src/merge/batch-store.ts";
import { buildQueue, eligible, singleMergeOnly } from "../src/merge/queue.ts";
import { askMergeDecisions } from "../src/merge/index.ts";
import { selectCandidates } from "../src/review/candidates.ts";
import { Git } from "../src/fixup/git.ts";
import { finalizeReviews } from "./fixture.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "batch-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const MAIN = "a".repeat(40);
const MAIN2 = "b".repeat(40);

function fresh(prs: { n: number; author?: string }[]): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
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

type World = { log: string[]; conflicts: Set<string>; mainHead: string; ci: "SUCCESS" | "FAILURE" | "PENDING"; mergeExit: number; tip: Map<string, string>;
  /** Head commits and states GitHub reports instead of the defaults (`sha<n>`, OPEN); 900 is the batch PR. */
  heads: Map<number, string>; prState: Map<number, string>; binary: Set<string>; existingPr: string;
  /** Assignees GitHub reports per PR, and the assign / unassign writes made. */
  assignees: Map<number, string[]>; ops: string[] };
const world = (): World => ({ log: [], conflicts: new Set(), mainHead: MAIN, ci: "SUCCESS", mergeExit: 0, tip: new Map(), heads: new Map(), prState: new Map(), binary: new Set(), existingPr: "", assignees: new Map(), ops: [] });

function deps(w: World, root: string): BatchDeps {
  let commits = 0;
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number };
      if (query.includes("viewer")) return { viewer: { login: "bot", id: "U1" } };
      if (query.startsWith("mutation")) {
        const n = Number(String((vars as { id: string }).id).slice(2));
        if (query.includes("removeAssignees")) { w.ops.push(`unassign ${n}`); w.assignees.set(n, []); } else { w.ops.push(`assign ${n}`); w.assignees.set(n, ["bot"]); }
        return {};
      }
      const head = (n: number) => w.heads.get(n) ?? (n === 900 ? w.tip.get("tip") ?? "none" : `sha${n}`);
      if (v.n !== undefined) return { repository: { pullRequest: { id: `PR${v.n}`, headRefOid: head(v.n), state: w.prState.get(v.n) ?? "OPEN", assignees: { nodes: (w.assignees.get(v.n) ?? []).map((login) => ({ login })) }, commits: { totalCount: 1, nodes: [] } } } };
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { repository: Object.fromEntries(nums.map((x) => [`pr${x}`, {
        number: x, state: w.prState.get(x) ?? "OPEN", isDraft: false, headRefOid: head(x), mergeable: "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: w.ci === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: w.ci === "PENDING" ? null : w.ci }] } } } }] },
      }])) };
    },
  });
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
        if (a[0] === "diff" && w.binary.has(a[a.length - 1]!.split("...")[1] ?? "")) return ok("diff --git a/x b/x\nBinary files a/x and b/x differ\n");
        if (a[0] === "diff") return ok("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        if (a[0] === "push") { w.log.push(`push ${a.slice(-2).join(" ")}`); return ok(); }
      }
      if (cmd === "gh") {
        if (key === "gh api user") return ok(JSON.stringify({ login: "bot", id: 7, node_id: "N7" }));
        if (a[0] === "api") return ok("storytold/app\n");
        if (a[0] === "pr" && a[1] === "list") return ok(w.existingPr);
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
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { setApproval } from "../src/labels/approval.ts";
import { applyLabels } from "../src/labels/github.ts";
import { ALL_LABELS } from "../src/labels/set.ts";
import { setFixIssueApproval } from "../src/fixissue/approval.ts";
import { openPr } from "../src/fixissue/index.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

const newDb = () => connect(join(mkdtempSync(join(dir, "db-")), "t.db"));

describe("labels", () => {
  test("a PR that GitHub reports MERGED is not labelled and its mirror row is updated", async () => {
    const db = newDb();
    db.exec("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
    for (const n of [1, 2]) {
      db.prepare("INSERT INTO items (repo, number, kind, state, title, url, labels) VALUES ('app', ?, 'pr', 'OPEN', 't', 'u', '[]')").run(n);
      db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'org-1', ?, 'bugfix', '[]', '{\"top\":0.99}')").run(n, T0);
    }
    setApproval(db, "boss", "app", true);
    const written: number[] = [];
    const client = validating({
      spent: 0, remaining: 5000 as number | null,
      async query(query: string, variables: Record<string, unknown>) {
        if (query.includes("label(name:")) {
          const l: Record<string, unknown> = { id: "R1" };
          ALL_LABELS.map((x) => x.name).forEach((n, i) => (l[`l${i}`] = { id: `L-${n}`, name: n }));
          return { repository: l };
        }
        if (query.includes("issueOrPullRequest")) {
          const r: Record<string, unknown> = {};
          for (const m of query.matchAll(/n(\d+): issueOrPullRequest/g)) r[`n${m[1]}`] = { id: `N${m[1]}`, state: m[1] === "2" ? "MERGED" : "OPEN" };
          return { repository: r };
        }
        const out: Record<string, unknown> = {};
        for (const m of query.matchAll(/m(\d+): addLabelsToLabelable/g)) {
          written.push(Number(String(variables[`i${m[1]}`]).slice(1)));
          out[`m${m[1]}`] = { clientMutationId: null };
        }
        return out;
      },
    });
    const logs: string[] = [];
    const r = await applyLabels(db, client, "app", { runId: "org-1", apply: true, wait: async () => {}, log: (l) => logs.push(l) });
    assert.deepEqual(written, [1]);
    assert.deepEqual([r.labeled, r.skipped, r.failed], [1, 1, []]);
    assert.equal((db.prepare("SELECT state FROM items WHERE number = 2").get() as { state: string }).state, "MERGED");
    assert.ok(logs.some((l) => l.includes("app#2: skipped")));
  });
});

describe("fixissue", () => {
  test("a live CLOSED issue gets no PR and no comment; the attempt fails like the mirror's closed path", async () => {
    const db = newDb();
    db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')").run();
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
    db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', 5, 'issue', 'OPEN', 'Panic', 'b', 'someone', ?, ?)").run(T0, T0);
    setFixIssueApproval(db, "op", "app", true);
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, round, files, crate_dir, patch, created_at, updated_at) VALUES ('app', 5, 'm', 'h', 'passed', 1, '[]', 'crates/app', 'p', ?, ?)").run(T0, T0);
    const row = db.prepare("SELECT * FROM fix_attempts WHERE number = 5").get() as never;
    const calls: string[] = [];
    const d = {
      now: () => new Date(T1),
      exec: async (cmd: string, args: string[]): Promise<ExecResult> => {
        calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`);
        return args[0] === "api" && args[1]!.endsWith("/issues/5") ? { code: 0, stdout: "closed\n", stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" };
      },
    };
    const opened = await openPr({ db, d, git: undefined, log: () => {}, runId: "r", usage: undefined } as never, row);
    assert.equal(opened, false);
    assert.deepEqual(calls, ["gh api repos/storytold/app/issues/5"]);
    const a = db.prepare("SELECT state, reason FROM fix_attempts WHERE number = 5").get() as { state: string; reason: string };
    assert.deepEqual([a.state, a.reason], ["failed", "the issue is closed"]);
    assert.equal((db.prepare("SELECT state FROM items WHERE number = 5").get() as { state: string }).state, "CLOSED");
  });
});

describe("opus review", () => {
  const CODE = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n";
  const setup = () => {
    const db = newDb();
    useTestAccount(db);
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES ('app', 1, 'pr', 'OPEN', 'PR 1', 'regular', 5, 0, 'sha1a', '${T0}', '${T0}')`).run();
    db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('app', 1, 'sha1a', 'rv', '${T0}', 'sonnet', 'S', 'take', 'ok')`).run();
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('app', 1, 'sha1a', 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run();
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
    return db;
  };
  const deps = (liveHead: string): OpusDeps => ({
    querier: validating({
      spent: 0, remaining: 5000,
      async query(query: string) {
        if (query.includes("reviewThreads")) return { repository: { pullRequest: { author: null, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } };
        return { repository: { pr1: { number: 1, state: "OPEN", isDraft: false, headRefOid: liveHead, mergeable: "MERGEABLE", maintainerCanModify: true, commits: { nodes: [] } } } };
      },
    }),
    fetchDiff: async () => ({ ok: true, text: CODE }),
    fetchDelta: async () => ({ ok: false, tooLarge: false, error: "none" }),
    model: "opus", maxChars: 120_000,
  });
  const runner = (calls: string[]): Runner => async (_c, _a, input) => {
    calls.push(input);
    const body = { ref: "app#1", verdict: "take", sure: true, reason: "ok", fixes: [], risks: [] };
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(body), usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" };
  };

  test("a PR whose live head moved gets no model call; at the selected head it does", async () => {
    process.env.CRAFT_AUTO_DIFF_CACHE = join(dir, "diffs");
    const calls: string[] = [];
    const restore = setRunner(runner(calls));
    try {
      const db = setup();
      const s = await runOpusReview(db, { repo: "app" }, () => {}, deps("sha1b"));
      assert.deepEqual([calls.length, s.dropped, s.reviewed], [0, 1, 0]);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM opus_reviews").get() as { n: number }).n, 0);
      const ok = await runOpusReview(setup(), { repo: "app" }, () => {}, deps("sha1a"));
      assert.deepEqual([calls.length, ok.dropped, ok.reviewed], [1, 0, 1]);
    } finally {
      restore();
    }
  });
});

describe("fixup", () => {
  const sh = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  test("a head that moved during the model calls is not pushed or assigned", async () => {
    const root = mkdtempSync(join(dir, "w-"));
    const work = join(root, "work");
    mkdirSync(join(work, "src"), { recursive: true });
    sh(work, "init", "-q", "-b", "fix");
    writeFileSync(join(work, "src/lib.rs"), "fn a() {}\nfn main() { a(); }\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "contributor");
    const head = sh(work, "rev-parse", "HEAD");
    const fork = join(root, "fork.git");
    sh(root, "clone", "-q", "--bare", work, fork);
    sh(fork, "update-ref", "refs/pull/7/head", head);
    const db = newDb();
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES ('app', 7, 'pr', 'OPEN', 'Fix a thing', 'someone', 5, 0, ?, '${T0}', '${T0}')`).run(head);
    db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', 'S', 'take-fix', 'nearly right', ?)`)
      .run(head, JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]));
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(head);
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
    setPushApproval(db, "op", "app", true);
    finalizeReviews(db);

    const log: string[] = [];
    let moved = false;
    const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
      if (cmd === "gh") {
        if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
        log.push("comment");
        return { code: 0, stdout: "", stderr: "" };
      }
      const net = args.some((a) => a.startsWith("https://github.com/"));
      const sub = args.map((a) => (a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
      if (args.includes("push")) log.push("push");
      return exec("git", net ? sub : args, { ...o });
    };
    const good = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
    const deps: FixupDeps = {
      querier: validating({
        spent: 0, remaining: 5000,
        async query(q: string) {
          if (q.startsWith("mutation")) { log.push("assign"); return {}; }
          return { repository: { pullRequest: { id: "PR7", state: "OPEN", isDraft: false, headRefOid: moved ? "f".repeat(40) : head, headRefName: "fix", maintainerCanModify: true, mergeable: "MERGEABLE",
            headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } };
        },
      }),
      exec: run, now: () => new Date(T1), root: join(root, "cache"),
      fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
      ask: async () => { moved = true; return good; },
      check: async () => JSON.stringify({ verdict: "approve", reasons: "matches", problems: [] }),
    };
    const before = sh(fork, "rev-parse", "refs/heads/fix");
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, deps);
    assert.deepEqual([s.pushed, s.failed], [[], []]);
    assert.deepEqual(log, []);
    assert.equal(sh(fork, "rev-parse", "refs/heads/fix"), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM fixups").get() as { n: number }).n, 0);
  });
});

describe("batch assignment", () => {
  test("starting a batch assigns an unassigned member and leaves an assigned one alone", async () => {
    const db = fresh([{ n: 1 }, { n: 2 }]);
    const w = world();
    w.assignees.set(2, ["maintainer"]);
    await runBatches(db, { repo: "app" }, quiet, deps(w, join(dir, "a1")));
    assert.deepEqual(w.ops, ["assign 1"]);
    const rows = db.prepare("SELECT target, details FROM audit WHERE action = 'assign'").all() as { target: string; details: string }[];
    assert.deepEqual(rows.map((r) => { const d = JSON.parse(r.details) as { run: string; assignee: string }; return [r.target, d.run, d.assignee]; }), [["app#1", activeRun(db), "bot"]]);
  });

  test("a member held after failing alone loses our assignment; a person's assignment stays", async () => {
    const db = fresh([{ n: 1 }]);
    const w = world();
    const d = deps(w, join(dir, "a2"));
    await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(w.ops, ["assign 1"]);
    finishTask(db, activeBatches(db, "app")[0]!.task_id!, "test");
    const s = await runBatches(db, { repo: "app" }, quiet, d);
    assert.deepEqual(s.failed, [1]);
    assert.deepEqual(w.ops, ["assign 1", "unassign 1"]);
    assert.equal(db.prepare("SELECT 1 FROM audit WHERE action = 'unassign' AND target = 'app#1'").all().length, 1);

    // Another person is assigned as well: the assignment is left alone.
    const db2 = fresh([{ n: 1 }]);
    const w2 = world();
    const d2 = deps(w2, join(dir, "a3"));
    await runBatches(db2, { repo: "app" }, quiet, d2);
    w2.assignees.set(1, ["bot", "maintainer"]);
    finishTask(db2, activeBatches(db2, "app")[0]!.task_id!, "test");
    await runBatches(db2, { repo: "app" }, quiet, d2);
    assert.deepEqual(w2.ops, ["assign 1"]);
  });
});

const activeRun = (db: DatabaseSync): string => (JSON.parse((db.prepare("SELECT details FROM audit WHERE action = 'assign'").get() as { details: string }).details) as { run: string }).run;
