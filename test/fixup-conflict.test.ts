import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { classifyFixups } from "../src/fixup/candidates.ts";
import { classifyConflicts, conflictTries } from "../src/fixup/conflict-state.ts";
import { pushable } from "../src/fixup/pushable.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { endNewline, keepsOutside, outsideConflicts, parseResolution } from "../src/fixup/patch.ts";
import { CONFLICT_COMMENT_TEMPLATE, conflictCommentText } from "../src/fixup/template.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "conflict-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const APPROVE = JSON.stringify({ verdict: "approve", reasons: "keeps both sides", problems: [] });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type World = { fork: string; head: string; base: string; log: string[]; deps: FixupDeps; checkInput: unknown[] };

/** `conflicting`: the PR and main edit the same line of f.txt; otherwise they edit different files. */
function world(o: { conflicting: boolean; canModify?: boolean; resolve?: (files: { path: string; content: string }[]) => string | null; check?: string }): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "f.txt"), "a\nb\nc\n");
  writeFileSync(join(work, "g.txt"), "x\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "checkout", "-q", "-b", "feat");
  if (o.conflicting) writeFileSync(join(work, "f.txt"), "a\nB-pr\nc\n"); else writeFileSync(join(work, "g.txt"), "x\ny\n");
  git(work, "commit", "-qam", "pr");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  writeFileSync(join(work, "f.txt"), o.conflicting ? "a\nB-main\nc\n" : "a\nb\nc\nd\n");
  git(work, "commit", "-qam", "main moves");
  const base = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);
  git(fork, "update-ref", "refs/heads/feat", head);
  const log: string[] = [];
  const checkInput: unknown[] = [];
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string) {
      if (q.startsWith("mutation")) { log.push("assign"); return {}; }
      return { repository: { pullRequest: {
        id: "PR7", state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feat", maintainerCanModify: o.canModify !== false, mergeable: "CONFLICTING",
        headRepository: { nameWithOwner: "org-x/app" }, assignees: { nodes: [] },
      } } };
    },
  });
  const run: Exec = async (cmd, args, io = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      log.push(`comment: ${io.input}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    const net = args.some((a) => a.startsWith("https://github.com/"));
    const sub = args.map((a) => (a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    if (args.includes("push")) log.push(`push ${args.filter((a) => a.startsWith("--force-with-lease")).join(" ")}`);
    return exec("git", net ? sub : args, { ...io });
  };
  const deps: FixupDeps = {
    querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
    fetchDiff: async () => ({ ok: true, text: "diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1 +1 @@\n-x\n+y\n" }),
    ask: async () => null,
    check: async (_db, input) => { log.push("check"); checkInput.push(input[0]!.conflict); return o.check ?? APPROVE; },
    resolve: o.resolve ? async (_db, input) => { log.push("resolve"); return o.resolve!(input[0]!.files); } : undefined,
  };
  return { fork, head, base, log, deps, checkInput };
}

/** One take PR (#7), conflicting per the mirror, in a repo with push approval; head from a fork we can't push to unless `sameRepo`. */
function fresh(head: string, o: { headRepo?: string; mergeable?: string; verdict?: string } = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, additions, deletions, head_oid, head_repo, head_ref, base_ref, maintainer_can_modify, mergeable, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Change g', 'Adds a line', 'someone', 1, 0, ?, ?, 'topic', 'main', 1, 'CONFLICTING', '${T0}', '${T0}')`).run(head, o.headRepo ?? "org-x/app");
  db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', 'S', ?, 'fine', '[]')`).run(head, o.verdict ?? "take");
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', ?, 1, '${T1}')`).run(head, o.mergeable ?? "CONFLICTING");
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  setPushApproval(db, "op", "app", true);
  finalizeReviews(db);
  return db;
}

const parents = (fork: string, c: string) => git(fork, "rev-list", "--parents", "-n", "1", c).split(" ").slice(1);

describe("conflict merge", () => {
  test("a clean merge pushes a two-parent commit on the head, with the lease and one comment", async () => {
    const w = world({ conflicting: false });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/feat");
    assert.deepEqual(parents(w.fork, pushed), [w.head, w.base]);
    assert.equal(git(w.fork, "show", `${pushed}:g.txt`), "x\ny");
    assert.equal(git(w.fork, "show", `${pushed}:f.txt`), "a\nb\nc\nd");
    assert.equal(git(w.fork, "log", "-1", "--format=%s", pushed), "Merge main into feat");
    assert.ok(w.log.indexOf("assign") >= 0 && w.log.indexOf("assign") < w.log.findIndex((l) => l.startsWith("push")), "assigned before the push");
    assert.deepEqual(w.log.filter((l) => l.startsWith("push") || l.startsWith("comment") || l === "check"), [`push --force-with-lease=refs/heads/feat:${w.head}`, `comment: ${conflictCommentText("main")}`]);
    assert.equal(conflictCommentText("main"), "Merged main into this branch to resolve the conflict.");
    assert.ok(CONFLICT_COMMENT_TEMPLATE.includes("{{base}}"));
    assert.deepEqual(db.prepare("SELECT state, from_head, to_head, attempt FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "merged", from_head: w.head, to_head: pushed, attempt: 1 }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('conflict-push', 'conflict-comment')").get() as { n: number }).n, 2);
  });

  test("a conflicting merge is resolved by the injected resolver, checked by Opus and pushed without markers", async () => {
    const w = world({ conflicting: true, resolve: (files) => {
      assert.match(files[0]!.content, /<<<<<<< /);
      return JSON.stringify({ files: [{ path: "f.txt", content: "a\nB-pr and B-main\nc\n" }] });
    } });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/feat");
    assert.deepEqual(parents(w.fork, pushed), [w.head, w.base]);
    const f = git(w.fork, "show", `${pushed}:f.txt`);
    assert.equal(f, "a\nB-pr and B-main\nc");
    assert.ok(!/<<<<<<<|>>>>>>>/.test(f));
    assert.deepEqual(w.log.filter((l) => ["resolve", "check"].includes(l)), ["resolve", "check"]);
    assert.deepEqual((w.checkInput[0] as { files: { path: string }[] }).files.map((x) => x.path), ["f.txt"]);
  });

  test("an Opus reject pushes nothing and counts as a try", async () => {
    const w = world({ conflicting: true, resolve: () => JSON.stringify({ files: [{ path: "f.txt", content: "a\nzzz\nc\n" }] }), check: JSON.stringify({ verdict: "reject", reasons: "drops the PR's line", problems: [] }) });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
    assert.equal(git(w.fork, "rev-parse", "refs/heads/feat"), w.head);
    assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "rejected" }]);
    assert.equal(classifyConflicts(db, "app")[0]!.c.attempt, 2);
  });

  test("leftover markers or an extra file are refused; nothing is pushed; two tries end in held", async () => {
    for (const reply of [
      JSON.stringify({ files: [{ path: "f.txt", content: "<<<<<<< pr\nB-pr\n=======\nB-main\n>>>>>>> main\n" }] }),
      JSON.stringify({ files: [{ path: "f.txt", content: "a\nok\nc\n" }, { path: "g.txt", content: "changed\n" }] }),
    ]) {
      const w = world({ conflicting: true, resolve: () => reply });
      const db = fresh(w.head);
      await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.ok(!w.log.some((l) => l.startsWith("push") || l === "check"));
      assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "refused" }]);
      await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.equal(classifyConflicts(db, "app")[0]!.bucket, "held");
    }
    assert.ok(!parseResolution('{"files":[{"path":"f.txt","content":"ok"}]}', ["f.txt", "h.txt"]).ok);
  });

  test("a fork without maintainer edits is asked once with comment approval, else held without a write", async () => {
    const w = world({ conflicting: false, canModify: false });
    const db = fresh(w.head);
    db.prepare("UPDATE items SET maintainer_can_modify = 0").run();
    db.prepare("UPDATE pr_checks SET maintainer_can_modify = 0").run();
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "held");
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), []);
    const { setCommentApproval } = await import("../src/act/approval.ts");
    setCommentApproval(db, "op", "app", true);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "ask");
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), ["comment: This branch conflicts with main. Please merge or rebase main into it."]);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "asked");
  });
});

describe("live read of a candidate the mirror still shows as mergeable", () => {
  test("a live CONFLICTING is recorded, so the PR is not selected for a fix-up again and goes to the conflict path", async () => {
    const w = world({ conflicting: false });
    const db = fresh(w.head, { mergeable: "UNKNOWN", verdict: "take-fix", headRepo: "storytold/app" });
    db.prepare("UPDATE reviews SET fixes = ? WHERE number = 7").run(JSON.stringify([{ file: "src/lib.rs", change: "x" }]));
    db.prepare("UPDATE items SET mergeable = 'UNKNOWN'").run();
    finalizeReviews(db);
    assert.equal(selectFixups(db, "app").fix.length, 1);
    assert.equal(classifyFixups(db, "app").length, 1);
    await runFixup(db, { repo: "app", dryRun: false, limit: 1 }, () => {}, { ...w.deps, ask: async () => { throw new Error("no model call"); } });
    assert.equal(selectFixups(db, "app").fix.length, 0);
    assert.equal(classifyFixups(db, "app").length, 0);
    assert.equal(selectFixups(db, "app").conflictMerge.length, 1);
  });
});

describe("conflict merge guards", () => {
  test("a resolution that changes text outside the conflict sections is refused", async () => {
    const w = world({ conflicting: true, resolve: () => JSON.stringify({ files: [{ path: "f.txt", content: "A\nB-pr and B-main\nc\n" }] }) });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("push") || l === "check"));
    const [row] = db.prepare("SELECT state, reason FROM conflict_merges").all() as { state: string; reason: string }[];
    assert.equal(row!.state, "refused");
    assert.match(row!.reason, /outside its conflict sections/);
  });

  test("outsideConflicts and keepsOutside", () => {
    const t = "a\n<<<<<<< x\n1\n=======\n2\n>>>>>>> y\nmid\n<<<<<<< x\n3\n=======\n4\n>>>>>>> y\nz\n";
    assert.deepEqual(outsideConflicts(t), ["a\n", "mid\n", "z\n"]);
    assert.equal(keepsOutside(t, "a\n12\nmid\n34\nz\n"), true);
    assert.equal(keepsOutside(t, "a\nmid\nz\n"), true);
    assert.equal(keepsOutside(t, "a\n12\nMID\n34\nz\n"), false);
    assert.equal(keepsOutside(t, "a\n12\nz\n34\nmid\n"), false);
    assert.equal(keepsOutside(t, "b\n12\nmid\n34\nz\n"), false);
    assert.equal(outsideConflicts("<<<<<<< x\n1\n"), null);
    assert.equal(keepsOutside("no markers\n", "no markers\n"), false);
  });

  test("a PR whose branch already has the base is skipped once and not selected again", async () => {
    const w = world({ conflicting: false });
    git(w.fork, "update-ref", "refs/heads/main", git(w.fork, "rev-parse", `${w.head}^`));
    const db = fresh(w.head);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "merge");
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
    assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "skipped" }]);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "held");
    assert.equal(selectFixups(db, "app").conflictMerge.length, 0);
    assert.ok(!w.log.includes("assign"), "not claimed");
  });

  test("a PR on a long-lived head branch, in an active batch or on a merge hold is not selected", () => {
    const db = fresh("h1", { headRepo: "storytold/app" });
    assert.equal(classifyConflicts(db, "app").length, 1);
    db.prepare("UPDATE items SET head_ref = 'release/1.0'").run();
    assert.equal(classifyConflicts(db, "app")[0]!.c.pushable, false);
    db.prepare("UPDATE items SET head_ref = 'topic'").run();
    db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 7, 'op', '2026-01-01T00:00:00Z')").run();
    assert.equal(classifyConflicts(db, "app").length, 0);
  });

  test("a protected-branch push rejection is recorded as push-denied, not as a try", async () => {
    const w = world({ conflicting: false });
    const deps: FixupDeps = { ...w.deps, exec: async (cmd, args, io) => (args.includes("push") ? { code: 1, stdout: "", stderr: "! [remote rejected] feat (protected branch hook declined)" } : w.deps.exec(cmd, args, io)) };
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, deps);
    assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "push-denied" }]);
    assert.equal(conflictTries(db, "app", 7, w.head), 0);
  });

  test("a conflict section may only hold lines from its sides plus a few harmless ones", () => {
    const c = "a\n<<<<<<< h\nx\n=======\ny\n>>>>>>> b\nz\n";
    assert.equal(keepsOutside(c, "a\ny\nx\nz\n"), true);
    assert.equal(keepsOutside(c, "a\nx\nx and y\nz\n"), true);
    assert.equal(keepsOutside(c, "a\nx\nfn evil() {}\nz\n"), false);
    assert.equal(keepsOutside(c, "a\nx\nuse evil::Thing;\nz\n"), false);
    assert.equal(keepsOutside(c, "a\nx\n1\n2\n3\n4\nz\n"), false);
    const t = "[dependencies]\n<<<<<<< h\nfoo = \"1\"\n=======\nbar = \"2\"\n>>>>>>> b\n";
    assert.equal(keepsOutside(t, "[dependencies]\nfoo = \"1\"\nbar = \"2\"\n", "Cargo.toml"), true);
    assert.equal(keepsOutside(t, "[dependencies]\nfoo = \"1\"\nevil = \"9\"\n", "Cargo.toml"), false);
  });

  test("a resolution missing the final newline gets it back", () => {
    assert.equal(endNewline("a\n", "a"), "a\n");
    assert.equal(endNewline("a", "a"), "a");
    assert.equal(endNewline("a\n", "a\n"), "a\n");
  });

  test("a push denied at push time is held for the head: no repeat of the model calls or the push", async () => {
    const w = world({ conflicting: false });
    const deps: FixupDeps = { ...w.deps, exec: async (cmd, args, io) => (args.includes("push") ? { code: 1, stdout: "", stderr: "remote: GH013: Repository rule violations found" } : w.deps.exec(cmd, args, io)) };
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, deps);
    assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "push-denied" }]);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "held");
    assert.equal(selectFixups(db, "app").conflictMerge.length, 0);
  });

  test("a branch protected on GitHub, shared by two open PRs, or based on by a closed PR is not pushable", () => {
    const db = fresh("h1", { headRepo: "storytold/app" });
    assert.equal(classifyConflicts(db, "app")[0]!.c.pushable, true);
    db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_ref, base_ref, head_repo, created_at, updated_at) VALUES ('app', 9, 'pr', 'OPEN', 't', 'x', 'topic', 'main', 'storytold/app', ?, ?)").run(T0, T0);
    assert.equal(classifyConflicts(db, "app")[0]!.c.pushable, false);
    db.prepare("DELETE FROM items WHERE number = 9").run();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_ref, base_ref, head_repo, created_at, updated_at) VALUES ('app', 9, 'pr', 'CLOSED', 't', 'x', 'y', 'topic', 'someone/app', ?, ?)").run(T0, T0);
    assert.equal(classifyConflicts(db, "app")[0]!.c.pushable, false);
    assert.equal(pushable("storytold/app", "app", false, "v1.2"), false);
    assert.equal(pushable("storytold/app", "app", false, "topic", () => false, true), false);
  });
});
