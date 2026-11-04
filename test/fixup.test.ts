import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { pushApprovalOf, setPushApproval } from "../src/fixup/approval.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { FILE_CAP, repostAsk, runFixup, scrubReason, type FixupDeps } from "../src/fixup/index.ts";
import { shownSize, viewFile } from "../src/fixup/excerpt.ts";
import { validatePatch, type FixupPr } from "../src/fixup/patch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { ASK_ITEM_MAX, COMMENT_TEMPLATE, askText, commentText } from "../src/fixup/template.ts";
import { checksOf } from "../src/patchcheck/index.ts";
import { selectOpusCandidates as selectCandidates } from "../src/review/opus-candidates.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixup-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Opts = { canModify?: boolean; approved?: boolean; mergeable?: string; verdict?: string; reviewHead?: string };

/** One take-fix PR (#7) at `head`. */
function fresh(head: string, o: Opts = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Fix a thing', 'someone', 5, 0, ?, '${T0}', '${T0}')`).run(head);
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', ?, 'nearly right', ?, 1, 'full')`)
    .run(o.reviewHead ?? head, o.verdict ?? "take-fix", FIXES);
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', ?, ?, '${T1}')`).run(head, o.mergeable ?? "MERGEABLE", o.canModify === false ? 0 : 1);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  if (o.approved !== false) setPushApproval(db, "op", "app", true);
  return db;
}

describe("candidate selection", () => {
  test("a take-fix PR at its head with push permission and approval is a candidate", () => {
    const s = selectFixups(fresh("h1"), "app");
    assert.deepEqual(s.fix.map((c) => [c.number, c.head, c.attempt]), [[7, "h1", 1]]);
    assert.equal(s.cannotPush.length, 0);
  });

  test("other verdicts, a review of an older head, conflicts and missing approval keep it out", () => {
    assert.equal(selectFixups(fresh("h1", { verdict: "take" }), "app").fix.length, 0);
    assert.equal(selectFixups(fresh("h2", { reviewHead: "h1" }), "app").fix.length, 0);
    assert.equal(selectFixups(fresh("h1", { mergeable: "CONFLICTING" }), "app").fix.length, 0);
    assert.equal(selectFixups(fresh("h1", { approved: false }), "app").fix.length, 0);
  });

  test("no push permission: held once per head, never a candidate", () => {
    const db = fresh("h1", { canModify: false });
    const s = selectFixups(db, "app");
    assert.equal(s.fix.length, 0);
    assert.equal(s.cannotPush.length, 1);
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, attempt, created_at) VALUES ('app', 7, 'h1', 'cannot-push', 'x', 1, ?)").run(T1);
    assert.equal(selectFixups(db, "app").cannotPush.length, 0);
  });

  test("two tries per PR; a push at a head ends the work on that head", () => {
    const db = fresh("h1");
    const add = (state: string, head = "h1") => db.prepare("INSERT INTO fixups (repo, number, from_head, state, attempt, created_at) VALUES ('app', 7, ?, ?, 1, ?)").run(head, state, T1);
    add("failed");
    assert.deepEqual(selectFixups(db, "app").fix.map((c) => c.attempt), [2]);
    add("refused");
    assert.equal(selectFixups(db, "app").fix.length, 0);
    const db2 = fresh("h1");
    db2.prepare("INSERT INTO fixups (repo, number, from_head, state, attempt, created_at) VALUES ('app', 7, 'h1', 'pushed', 1, ?)").run(T1);
    assert.equal(selectFixups(db2, "app").fix.length, 0);
  });

  test("the approval is per repo, audited, and needs a tracked repo", () => {
    const db = fresh("h1", { approved: false });
    assert.equal(pushApprovalOf(db, "app"), null);
    assert.equal(setPushApproval(db, "op", "app", true), true);
    assert.equal(setPushApproval(db, "op", "app", true), false);
    assert.equal(pushApprovalOf(db, "app")?.by, "op");
    assert.throws(() => setPushApproval(db, "op", "other", true), /not tracked/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'push_approved:app'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'push-approve'").get() as { n: number }).n, 1);
  });
});

const hunk = (file: string, body = "-a\n+b\n", counts = "-1 +1") =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ ${counts} @@\n${body}`;

describe("patch validation", () => {
  test("accepts a content edit to a named file, also inside a fence", () => {
    const ok = validatePatch(hunk("src/lib.rs"), ["src/lib.rs"]);
    assert.ok(ok.ok && ok.changed === 2 && ok.files[0] === "src/lib.rs");
    assert.ok(validatePatch("```diff\n" + hunk("src/lib.rs") + "```", ["src/lib.rs"]).ok);
  });

  test("refuses a file the fixes do not name, or an unsafe path", () => {
    assert.match(String((validatePatch(hunk("src/other.rs"), ["src/lib.rs"]) as { reason: string }).reason), /not a file named/);
    assert.equal(validatePatch(hunk("../x"), ["../x"]).ok, false);
  });

  test("refuses more than 300 changed lines", () => {
    const body = Array.from({ length: 151 }, (_, i) => `-o${i}\n+n${i}\n`).join("");
    const r = validatePatch(hunk("src/lib.rs", body, "-1,151 +1,151"), ["src/lib.rs"]);
    assert.ok(!r.ok && /302 changed lines/.test(r.reason));
  });

  test("refuses mode, new, deleted, rename, symlink and binary changes", () => {
    const f = "src/lib.rs";
    const cases = [
      `diff --git a/${f} b/${f}\nold mode 100644\nnew mode 100755\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+b\n`,
      `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`,
      `diff --git a/${f} b/${f}\nindex 1234567..89abcde 120000\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${f} b/${f}\nindex 1234567..89abcde 100644\nBinary files a/${f} and b/${f} differ\n`,
      `diff --git a/${f} b/${f}\nGIT binary patch\nliteral 1\n`,
    ];
    for (const c of cases) assert.equal(validatePatch(c, [f]).ok, false, c.split("\n")[1]);
  });

  test("refuses text that is not a diff and a hunk longer than its header", () => {
    assert.equal(validatePatch("I fixed it.", ["a"]).ok, false);
    assert.equal(validatePatch(hunk("a", "-a\n+b\n+c\n"), ["a"]).ok, false);
  });
});

// ---- the whole step against real git, with the network replaced ------------

type World = { asked: FixupPr[]; assigned: string[]; fork: string; base: string; head: string; log: string[]; deps: FixupDeps; movedBeforePush?: boolean };

/** A fork repository with branch `fix` at `head`, standing in for both the base repo's pull ref and the contributor's fork. */
const APPROVE = JSON.stringify({ verdict: "approve", reasons: "matches the listed fix", problems: [] });
const REJECT = JSON.stringify({ verdict: "reject", reasons: "renames more than the review asked", problems: ["touches main"] });

function world(opts: { check?: string | null; reply?: string | null; moveBranch?: boolean; assignees?: string[]; canModify?: boolean; pushError?: string; lib?: string; diff?: string } = {}): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "fix");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/lib.rs"), opts.lib ?? "fn a() {}\nfn main() { a(); }\n");
  writeFileSync(join(work, "src/other.rs"), "fn z() {}\n");
  writeFileSync(join(work, "ROADMAP.md"), "# Plan\n- one\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);
  const log: string[] = [];
  const w: World = { asked: [], assigned: [...(opts.assignees ?? [])], fork, base: root, head, log, deps: undefined as never };
  const good = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string) {
      if (q.startsWith("mutation")) {
        const adding = q.includes("addAssignees");
        log.push(adding ? "assign" : "unassign");
        w.assigned = adding ? [...w.assigned, "pipeline-bot"] : w.assigned.filter((l) => l !== "pipeline-bot");
        return {};
      }
      log.push("pr-info");
      return { repository: { pullRequest: {
        id: "PR7", number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "fix", maintainerCanModify: opts.canModify !== false, mergeable: "MERGEABLE",
        headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: w.assigned.map((login) => ({ login })) },
      } } };
    },
  });
  // Real git on local repositories; gh and the two GitHub URLs are faked.
  const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      log.push(`comment: ${o.input}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    const net = args.findIndex((a) => a.startsWith("https://github.com/"));
    const sub = net >= 0 ? args.map((a) => (a.startsWith("https://github.com/") ? fork : a)) : args;
    const sub2 = sub.filter((a, i) => !(a === "-c" && sub[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    const verb = args.find((a) => ["fetch", "push"].includes(a));
    if (verb === "push") {
      log.push(`push ${args.filter((a) => a.startsWith("--force-with-lease") || /^[0-9a-f]{40}:/.test(a)).join(" ")}`);
      if (opts.pushError) return { code: 1, stdout: "", stderr: opts.pushError };
      if (opts.moveBranch) { git(fork, "update-ref", "refs/heads/fix", git(fork, "commit-tree", "-p", head, "-m", "moved", `${head}^{tree}`)); }
    }
    return exec("git", net >= 0 ? sub2 : args, { ...o });
  };
  w.deps = {
    querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
    fetchDiff: async () => ({ ok: true, text: opts.diff ?? "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
    ask: async (_db, input) => { log.push("model"); w.asked.push(...input); return opts.reply === undefined ? good : opts.reply; },
    check: async (_db, input) => { log.push("check"); assert.match(input[0]!.patch, /^diff --git/); return opts.check === undefined ? APPROVE : opts.check; },
  };
  return w;
}

const rows = (db: DatabaseSync, sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }));

describe("fixup step", () => {
  test("the fix-up is on record as pushing, with its commit, before the push runs", async () => {
    const w = world();
    const db = fresh(w.head);
    const seen: unknown[] = [];
    const inner = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => {
      if (args.includes("push")) seen.push(rows(db, "SELECT state, from_head, to_head FROM fixups"));
      return inner(cmd, args, o);
    };
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const pushed = git(w.fork, "rev-parse", "refs/heads/fix");
    assert.deepEqual(seen, [[{ state: "pushing", from_head: w.head, to_head: pushed }]]);
    assert.deepEqual(rows(db, "SELECT state, to_head FROM fixups"), [{ state: "pushed", to_head: pushed }]);
  });

  test("claims, patches, pushes with the lease on the reviewed head, then comments once", async () => {
    const w = world();
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/fix");
    assert.notEqual(pushed, w.head);
    assert.equal(git(w.fork, "rev-parse", `${pushed}^`), w.head);
    assert.equal(git(w.fork, "show", `${pushed}:src/lib.rs`), "fn b() {}\nfn main() { b(); }");
    assert.equal(git(w.fork, "log", "-1", "--format=%an <%ae>%n%B", pushed).split("\n")[0], "pipeline-bot <42+pipeline-bot@users.noreply.github.com>");
    assert.match(git(w.fork, "log", "-1", "--format=%B", pushed), /^Apply review fixes\n\n- src\/lib\.rs/);
    assert.deepEqual(w.log.filter((l) => !l.startsWith("pr-info")), [
      "assign", "model", "check", `push --force-with-lease=refs/heads/fix:${w.head} ${pushed}:refs/heads/fix`, `comment: _AI-generated comment (Sonnet). Not a maintainer decision._\n\n${commentText(["src/lib.rs"])}`,
    ]);
    assert.equal(commentText(["src/lib.rs"]), "Pushed the small fixes from review: `src/lib.rs`.");
    assert.ok(COMMENT_TEMPLATE.includes("{{files}}"));
    assert.deepEqual(rows(db, "SELECT state, from_head, to_head, files, attempt FROM fixups"), [{ state: "pushed", from_head: w.head, to_head: pushed, files: '["src/lib.rs"]', attempt: 1 }]);
    assert.deepEqual(rows(db, "SELECT action FROM audit WHERE action IN ('assign', 'fixup-push', 'fixup-comment') ORDER BY rowid").map((r) => r.action), ["assign", "fixup-push", "fixup-comment"]);
    assert.equal(rows(db, "SELECT 1 FROM stages WHERE note LIKE 'fix-up pushed%'").length, 1);
    // Done at that head; the pushed head is new to the Review stage once the mirror sees it.
    assert.equal(selectFixups(db, "app").fix.length, 0);
  });

  test("Opus rejects the patch: nothing is pushed, the try is recorded as rejected and counts", async () => {
    const w = world({ check: REJECT });
    const db = fresh(w.head);
    const before = git(w.fork, "rev-parse", "refs/heads/fix");
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, []);
    assert.equal(s.failed.length, 1);
    assert.equal(git(w.fork, "rev-parse", "refs/heads/fix"), before);
    assert.deepEqual(w.log.filter((l) => !l.startsWith("pr-info")), ["assign", "model", "check"]);
    const f = rows(db, "SELECT state, reason, attempt FROM fixups");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.state, "rejected");
    assert.match(String(f[0]!.reason), /Opus rejected the patch: renames more than the review asked; touches main/);
    assert.equal(selectFixups(db, "app").fix[0]!.attempt, 2);
    const c = checksOf(db, "app", 7);
    assert.deepEqual(c.map((x) => [x.kind, x.verdict, x.model, x.subject, x.problems]), [["fixup", "reject", "opus", w.head, ["touches main"]]]);
    assert.match(c[0]!.patchHash, /^[0-9a-f]{16}$/);
  });

  test("Opus approves: the check is recorded and the push goes on", async () => {
    const w = world();
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    assert.deepEqual(checksOf(db, "app", 7).map((x) => x.verdict), ["approve"]);
  });

  test("an unreadable or missing check answer pushes nothing", async () => {
    for (const check of [null, "looks fine"]) {
      const w = world({ check });
      const s = await runFixup(fresh(w.head), { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.deepEqual(s.pushed, []);
      assert.ok(!w.log.some((l) => l.startsWith("push")));
    }
  });

  test("an already assigned PR is not assigned again", async () => {
    const w = world({ assignees: ["someone"] });
    await runFixup(fresh(w.head), { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.includes("assign"));
  });

  test("a branch that moved since the review is not overwritten", async () => {
    const w = world({ moveBranch: true });
    const db = fresh(w.head);
    const moved = () => git(w.fork, "rev-parse", "refs/heads/fix");
    const before = moved();
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(s.pushed.length, 0);
    assert.equal(s.failed.length, 1);
    assert.equal(before, w.head);
    assert.notEqual(moved(), w.head);
    assert.equal(git(w.fork, "show", `${moved()}:src/lib.rs`), "fn a() {}\nfn main() { a(); }");
    assert.deepEqual(rows(db, "SELECT state FROM fixups"), [{ state: "refused" }]);
    assert.ok(!w.log.some((l) => l.startsWith("comment")));
  });

  test("a patch for a file the fixes do not name is refused and nothing is pushed", async () => {
    const w = world({ reply: "diff --git a/src/other.rs b/src/other.rs\n--- a/src/other.rs\n+++ b/src/other.rs\n@@ -1 +1 @@\n-fn z() {}\n+fn y() {}\n" });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(rows(db, "SELECT state, reason FROM fixups"), [{ state: "refused", reason: "src/other.rs is not a file named in the review's fixes" }]);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
    assert.equal(git(w.fork, "rev-parse", "refs/heads/fix"), w.head);
  });

  test("a patch that does not apply is refused", async () => {
    const w = world({ reply: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-not there\n+x\n" });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const r = rows(db, "SELECT state, reason FROM fixups")[0]!;
    assert.equal(r.state, "refused");
    assert.match(String(r.reason), /git apply --check/);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
  });

  test("a PR we can't push to is held once, with no GitHub write and no model call", async () => {
    const w = world();
    const db = fresh(w.head, { canModify: false });
    for (let i = 0; i < 2; i++) await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, []);
    assert.deepEqual(rows(db, "SELECT stage, note FROM stages WHERE stage = 'hold'"), [{ stage: "hold", note: "can't push to the contributor's branch" }]);
    assert.deepEqual(rows(db, "SELECT state FROM fixups"), [{ state: "cannot-push" }]);
  });

  test("a PR we can't push to in a repo not approved for comments stays held and nothing is posted", async () => {
    const w = world();
    const db = fresh(w.head, { canModify: false });
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("comment")));
    assert.deepEqual(rows(db, "SELECT state FROM fixups"), [{ state: "cannot-push" }]);
  });

  test("with comment approval the cleaned fix list is posted once per head", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false });
    setCommentApproval(db, "op", "app", true);
    db.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([
      { file: "src/lib.rs", change: "rename a to b, see [the guide](https://x.example/g) and ping @someone https://evil.example/y" },
      ...Array.from({ length: 8 }, (_, i) => ({ file: `src/f${i}.rs`, change: "x".repeat(300) })),
    ]));
    for (let i = 0; i < 2; i++) await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const posted = w.log.filter((l) => l.startsWith("comment: "));
    assert.equal(posted.length, 1);
    const body = posted[0]!.slice("comment: ".length);
    assert.ok(body.startsWith("_AI-generated comment (m). Not a maintainer decision._\n\nBefore this can be merged, it needs these changes:\n- `src/lib.rs`: rename a to b, see the guide and ping someone."));
    assert.ok(!/@|https?:|\]\(/.test(body));
    const lines = body.split("\n\n")[1]!.split("\n");
    assert.equal(lines.length, 7);
    assert.ok(lines.slice(1).every((l) => l.length <= ASK_ITEM_MAX));
    assert.ok(!w.log.includes("model") && !w.log.some((l) => l.startsWith("push")));
    assert.deepEqual(rows(db, "SELECT state FROM fixups"), [{ state: "asked" }]);
    assert.deepEqual(rows(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'fixup-comment'"), [{ n: 1 }]);
  });

  test("a head that moved before posting is skipped, and a new head is reviewed again", async () => {
    const w = world();
    const db = fresh("old-head", { canModify: false });
    setCommentApproval(db, "op", "app", true);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, ["pr-info"]);
    assert.deepEqual(rows(db, "SELECT state FROM fixups"), []);

    const w2 = world();
    const db2 = fresh(w2.head, { canModify: false });
    setCommentApproval(db2, "op", "app", true);
    await runFixup(db2, { repo: "app", dryRun: false }, () => {}, w2.deps);
    assert.equal(selectFixups(db2, "app").ask.length, 0);
    db2.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 7, 'jev', 'r1', ?, 'bugfix', '[]', '{\"top\":0.95}')").run(T0);
    assert.equal(selectCandidates(db2, "app").length, 0);
    db2.prepare("UPDATE items SET head_oid = 'new', updated_at = '2026-01-03T00:00:00Z'").run();
    assert.deepEqual(selectCandidates(db2, "app").map((c) => c.head_oid), ["new"]);
    assert.equal(selectFixups(db2, "app").ask.length, 0);
  });

  test("approving comments later asks about a head already held", () => {
    const db = fresh("h1", { canModify: false });
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, attempt, created_at) VALUES ('app', 7, 'h1', 'cannot-push', 'x', 1, ?)").run(T1);
    assert.equal(selectFixups(db, "app").ask.length, 0);
    setCommentApproval(db, "op", "app", true);
    assert.equal(selectFixups(db, "app").ask.length, 1);
  });

  test("the comment text caps items and drops empty ones", () => {
    assert.equal(askText([{ file: "a.rs", change: "https://x.example" }]), "Before this can be merged, it needs these changes:\n");
  });

  test("a fix of a few sentences is posted whole", () => {
    const change = "Move the two doc lines and the `MAX_PREVIEW_PIXELS` constant, followed by a blank line, so they sit above the doc lines of `recent_preview`. ".repeat(3).trim();
    assert.ok(askText([{ file: "a.rs", change }]).endsWith(change));
  });

  test("a file over the cap is shown as numbered excerpts around the cited lines and the changed hunks, and a patch with real line numbers applies", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `fn f${i}() {}`);
    const lib = lines.join("\n") + "\n";
    assert.ok(lib.length > FILE_CAP);
    const diff = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -2000,2 +2000,3 @@\n fn f1999() {}\n+fn extra() {}\n fn f2000() {}\n";
    const patch = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -500,3 +500,3 @@\n fn f499() {}\n-fn f500() {}\n+fn g500() {}\n fn f501() {}\n";
    const w = world({ lib, diff, reply: patch });
    const db = fresh(w.head);
    db.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([{ file: "src/lib.rs", change: "rename f500 at line 500 to g500" }]));
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const f = w.asked[0]!.files[0]!;
    assert.ok("excerpt" in f);
    const e = (f as Extract<typeof f, { excerpt: unknown }>).excerpt;
    assert.equal(e.total_lines, 3000);
    assert.deepEqual(e.regions.map((r) => [r.from, r.to]), [[350, 650], [1850, 2152]]);
    assert.ok(e.regions[0]!.text.split("\n").includes("501| fn f500() {}"));
    assert.ok(e.regions[1]!.text.startsWith("1850| fn f1849() {}"));
    assert.ok(e.outline.includes("1| fn f0() {}"));
    assert.equal(git(w.fork, "show", "refs/heads/fix:src/lib.rs").split("\n")[500], "fn g500() {}");
  });

  test("a hold for a file over the old whole-file limit stops blocking after the migration; other holds stay", () => {
    const path = join(mkdtempSync(join(dir, "db-")), "t.db");
    const db = connect(path);
    db.close();
    const again = (head: string): DatabaseSync => {
      const d = connect(path);
      d.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES ('app', 7, 'pr', 'OPEN', 't', 'x', 5, 0, ?, '${T0}', '${T0}')`).run(head);
      d.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', 'take-fix', 'r', ?, 1, 'full')`).run(head, FIXES);
      d.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(head);
      d.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
      setPushApproval(d, "op", "app", true);
      return d;
    };
    const d = again("h1");
    const hold = (reason: string) => d.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, attempt, created_at) VALUES ('app', 7, 'h1', 'too-large', ?, 1, ?)").run(reason, T1);
    hold("src/lib.rs is over the 40000 character limit");
    assert.equal(selectFixups(d, "app").fix.length, 0);
    d.close();
    const migrated = connect(path);
    assert.deepEqual(selectFixups(migrated, "app").fix.map((c) => c.number), [7]);
    assert.deepEqual(rows(migrated, "SELECT state, reason FROM fixups"), [{ state: "superseded", reason: "src/lib.rs is over the 40000 character limit" }]);
    migrated.prepare("DELETE FROM fixups").run();
    migrated.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, attempt, created_at) VALUES ('app', 7, 'h1', 'too-large', 'the fixes name files a fix-up may not edit', 1, ?)").run(T1);
    migrated.close();
    assert.equal(selectFixups(connect(path), "app").fix.length, 0);
  });

  describe("a patch on a large file with a duplicated block", () => {
    const dup = (i: number) => (i >= 100 && i < 103) || (i >= 2500 && i < 2503) ? `dup ${i < 200 ? i - 100 : i - 2500}` : `fn f${i}() {}`;
    const lib = Array.from({ length: 3000 }, (_, i) => dup(i)).join("\n") + "\n";
    const diff = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1000,1 +1000,1 @@\n-x\n+fn f999() {}\n";
    const patch = (start: number) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -${start},3 +${start},3 @@\n dup 0\n-dup 1\n+dup one\n dup 2\n`;
    const run = async (start: number) => {
      const w = world({ lib, diff, reply: patch(start) });
      const db = fresh(w.head);
      const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      return { s, reason: String((rows(db, "SELECT reason FROM fixups")[0] ?? {}).reason), log: w.log };
    };

    test("a hunk applied at an offset from its header is refused", async () => {
      const r = await run(2400);
      assert.deepEqual(r.s.pushed, []);
      assert.match(r.reason, /different line than its header/);
      assert.ok(!r.log.includes("check"));
    });

    test("the same offset hunk on a file shown whole still applies", async () => {
      const small = Array.from({ length: 2600 }, (_, i) => (i >= 2500 ? `dup ${i - 2500}` : `a${i}`)).join("\n") + "\n";
      assert.ok(small.length < FILE_CAP);
      const w2 = world({ lib: small, diff, reply: patch(2400) });
      const db = fresh(w2.head);
      const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w2.deps);
      assert.deepEqual(s.pushed, ["app#7"]);
    });

    test("a hunk at its stated place outside the shown regions is refused", async () => {
      const r = await run(2501);
      assert.deepEqual(r.s.pushed, []);
      assert.match(r.reason, /outside the parts shown/);
      assert.ok(!r.log.includes("check"));
    });
  });

  test("lines are cited as line N, lines N-M, LN and path:N, and a column after a path is not a line", () => {
    const body = Array.from({ length: 1000 }, (_, i) => `fn f${i}() {}`).join("\n") + "\n";
    const regions = (cue: string) => {
      const v = viewFile("src/x.rs", body, [cue], "", 10_000);
      const f = v.ok ? v.file : null;
      return f && "excerpt" in f ? f.excerpt.regions.map((r) => [r.from, r.to]) : null;
    };
    assert.deepEqual(regions("src/x.rs:500:3"), [[350, 650]]);
    assert.deepEqual(regions("line 20, lines 800-810 and L900"), [[1, 170], [650, 1000]]);
  });

  test("the outline is shortened before the file is refused", () => {
    const body = Array.from({ length: 1000 }, (_, i) => `fn f${i}() {}`).join("\n") + "\n";
    const diff = "diff --git a/s.rs b/s.rs\n@@ -500,1 +500,1 @@\n-a\n+b\n";
    const whole = viewFile("s.rs", body, [], diff, 1e9);
    assert.ok(whole.ok && "content" in whole.file);
    const cap = 8_000;
    const v = viewFile("s.rs", body, [], diff, cap);
    assert.ok(v.ok && "excerpt" in v.file && shownSize(v.file) <= cap);
  });

  test("carry-overs held for the old file limit are queued again after connecting; other holds stay", () => {
    const path = join(mkdtempSync(join(dir, "db-")), "t.db");
    const db = connect(path);
    const ins = db.prepare("INSERT INTO dupe_carries (decision_id, repo, number, state, outcome, updated_at) VALUES (?, 'app', ?, 'held', ?, ?)");
    ins.run("d1", 1, "too-large: src/lib.rs is over the 40000 character limit", T0);
    ins.run("d2", 2, "too-large: the fixes name files a fix-up may not edit", T0);
    db.close();
    const again = connect(path);
    assert.deepEqual(rows(again, "SELECT number, state FROM dupe_carries ORDER BY number"), [{ number: 1, state: "queued" }, { number: 2, state: "held" }]);
  });

  test("a large file whose excerpts are still over the limit is held with a reason", async () => {
    const lib = Array.from({ length: 3000 }, (_, i) => `fn f${i}() { /* ${"x".repeat(40)} */ }`).join("\n") + "\n";
    const hunks = [100, 600, 1100, 1600, 2100, 2600].map((n) => `@@ -${n},1 +${n},1 @@\n-a\n+b\n`).join("");
    const diff = `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n${hunks}`;
    const w = world({ lib, diff });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.asked, []);
    const r = rows(db, "SELECT state, reason FROM fixups")[0]!;
    assert.equal(r.state, "too-large");
    assert.match(String(r.reason), /parts of src\/lib\.rs to show are over the 40000 character limit/);
  });

  test("a fix list naming a workflow or manifest is held before any call", async () => {
    const w = world();
    const db = fresh(w.head);
    db.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([{ file: ".github/workflows/ci.yml", change: "x" }, { file: "Cargo.toml", change: "y" }]));
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log.filter((l) => !l.startsWith("pr-info")), []);
    assert.equal(rows(db, "SELECT state FROM fixups")[0]!.state, "too-large");
  });

  test("a fix naming a Markdown file is applied; one naming build.rs is held", async () => {
    const md = "diff --git a/ROADMAP.md b/ROADMAP.md\n--- a/ROADMAP.md\n+++ b/ROADMAP.md\n@@ -1,2 +1,2 @@\n # Plan\n-- one\n+- two\n";
    const w = world({ reply: md });
    const db = fresh(w.head);
    db.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([{ file: "ROADMAP.md", change: "one to two" }]));
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(rows(db, "SELECT state, files FROM fixups"), [{ state: "pushed", files: '["ROADMAP.md"]' }]);
    const b = world();
    const db2 = fresh(b.head);
    db2.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([{ file: "build.rs", change: "x" }]));
    await runFixup(db2, { repo: "app", dryRun: false }, () => {}, b.deps);
    assert.equal(rows(db2, "SELECT state FROM fixups")[0]!.state, "too-large");
  });

  test("holds that name only editable files are re-opened after connecting; a hold naming build.rs stays", () => {
    const path = join(mkdtempSync(join(dir, "db-")), "t.db");
    const db = connect(path);
    const reason = "the fixes name files a fix-up may not edit";
    const ins = db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, files, attempt, created_at) VALUES ('app', ?, 'h', 'too-large', ?, ?, 1, ?)");
    ins.run(1, reason, '["ROADMAP.md","docs/guide.MD"]', T1);
    ins.run(2, reason, '["ROADMAP.md","build.rs"]', T1);
    ins.run(3, reason, '["Cargo.toml"]', T1);
    ins.run(5, reason, '["docs/CLAUDE.md"]', T1);
    ins.run(6, reason, '[".claude/notes.md"]', T1);
    ins.run(4, "src/lib.rs is over the 50000 character limit", '["ROADMAP.md"]', T1);
    db.close();
    const again = connect(path);
    const states = () => rows(again, "SELECT number, state FROM fixups ORDER BY number");
    const want = [{ number: 1, state: "superseded" }, { number: 2, state: "too-large" }, { number: 3, state: "too-large" }, { number: 4, state: "too-large" }, { number: 5, state: "too-large" }, { number: 6, state: "too-large" }];
    assert.deepEqual(states(), want);
    again.close();
    assert.deepEqual(rows(connect(path), "SELECT number, state FROM fixups ORDER BY number"), want);
  });

  test("a patch touching an uneditable path is refused even when the fixes name it", () => {
    const patch = "diff --git a/build.rs b/build.rs\n--- a/build.rs\n+++ b/build.rs\n@@ -1 +1 @@\n-a\n+b\n";
    assert.equal(validatePatch(patch, ["build.rs"]).ok, false);
    assert.equal(validatePatch(patch.replaceAll("build.rs", "src/lib.rs"), ["src/lib.rs"]).ok, true);
  });

  test("assigned when picked up, kept after a refused first try, released only when out of tries and we are the sole assignee", async () => {
    const w = world({ reply: "not a diff" });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log.filter((l) => l === "assign" || l === "unassign"), ["assign"]);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log.filter((l) => l === "assign" || l === "unassign"), ["assign", "unassign"]);
    assert.deepEqual(w.assigned, []);
    assert.deepEqual(rows(db, "SELECT action FROM audit WHERE action IN ('assign', 'unassign') ORDER BY rowid").map((r) => r.action), ["assign", "unassign"]);
  });

  test("a PR someone else is assigned to is neither claimed nor released", async () => {
    const w = world({ reply: "not a diff", assignees: ["someone"] });
    const db = fresh(w.head);
    for (let i = 0; i < 2; i++) await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.includes("assign") && !w.log.includes("unassign"));
  });

  test("no release when the audit does not show our assignment, even as the sole assignee", async () => {
    const w = world({ reply: "not a diff", assignees: ["pipeline-bot"] });
    const db = fresh(w.head);
    for (let i = 0; i < 2; i++) await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.includes("unassign"));
  });

  test("a first Opus reject keeps our assignment (the PR is tried again); a second releases it; a push keeps it", async () => {
    const r = world({ check: REJECT });
    const rdb = fresh(r.head);
    await runFixup(rdb, { repo: "app", dryRun: false }, () => {}, r.deps);
    assert.deepEqual(r.log.filter((l) => l === "assign" || l === "unassign"), ["assign"]);
    await runFixup(rdb, { repo: "app", dryRun: false }, () => {}, r.deps);
    assert.deepEqual(r.log.filter((l) => l === "assign" || l === "unassign"), ["assign", "unassign"]);
    const p = world();
    await runFixup(fresh(p.head), { repo: "app", dryRun: false }, () => {}, p.deps);
    assert.deepEqual(p.log.filter((l) => l === "assign" || l === "unassign"), ["assign"]);
  });

  test("stored reasons carry no absolute path", () => {
    const r = scrubReason("fatal: bad object /home/someone/.cache/x/repo.git/objects/ab\nmore", "/srv/fixups");
    assert.ok(!r.includes("/home") && !r.includes("\n"));
    assert.equal(scrubReason("cannot open /srv/fixups/app.git: no", "/srv/fixups"), "cannot open <dir>/app.git: no");
  });

  test("a dry run reads the tables only", async () => {
    const w = world();
    const db = fresh(w.head);
    await runFixup(db, { repo: "app" }, () => {}, w.deps);
    assert.deepEqual(w.log, []);
    assert.equal(rows(db, "SELECT 1 FROM fixups").length, 0);
  });
});

describe("review of a moved head", () => {
  test("the Review stage selects a PR whose head moved past its review", () => {
    const db = fresh("h1");
    db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', 7, 'jev', 'r1', ?, 'bugfix', '[]', '{\"top\":0.95}')").run(T0);
    assert.equal(selectCandidates(db, "app").length, 0);
    db.prepare("UPDATE items SET head_oid = 'h2', updated_at = '2026-01-03T00:00:00Z'").run();
    assert.deepEqual(selectCandidates(db, "app").map((c) => c.head_oid), ["h2"]);
  });
});

describe("fixup repost", () => {
  test("edits the recorded ask comment to the full text once, records it, and does nothing when the text matches", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false });
    setCommentApproval(db, "op", "app", true);
    const long = "y".repeat(400);
    db.prepare("UPDATE opus_reviews SET fixes = ?").run(JSON.stringify([{ file: "src/lib.rs", change: long }]));
    const url = "https://github.com/storytold/app/pull/7#issuecomment-555";
    const edits: string[][] = [];
    const run: Exec = async (cmd, args, o) => {
      if (cmd === "gh" && args[0] === "api" && args.includes("PATCH")) { edits.push([...args, String(o?.input)]); return { code: 0, stdout: "{}", stderr: "" }; }
      if (cmd === "gh" && args[1] === "comment") return { code: 0, stdout: `${url}\n`, stderr: "" };
      return w.deps.exec!(cmd, args, o);
    };
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, { ...w.deps, exec: run });
    // The comment as the older, shorter template posted it.
    const old = "Before this can be merged, it needs these changes:\n- `src/lib.rs`: " + long.slice(0, 100);
    db.prepare("UPDATE audit SET details = json_set(details, '$.text', ?) WHERE action = 'fixup-comment'").run(old);

    assert.equal((await repostAsk(db, "app", 7, false, run)).status, "dry-run");
    assert.equal(edits.length, 0);
    assert.equal((await repostAsk(db, "app", 7, true, run)).status, "edited");
    assert.equal(edits.length, 1);
    assert.ok(edits[0]!.includes("repos/storytold/app/issues/comments/555"));
    assert.equal(edits[0]!.at(-1), `_AI-generated comment (m). Not a maintainer decision._\n\n${askText([{ file: "src/lib.rs", change: long }])}`);
    assert.ok(edits[0]!.at(-1)!.includes(long));
    const a = rows(db, "SELECT login, target, json_extract(details, '$.state') AS state FROM audit WHERE action = 'fixup-comment-edit'");
    assert.deepEqual(a, [{ login: "fixup", target: "app#7", state: "done" }]);
    assert.equal((await repostAsk(db, "app", 7, true, run)).status, "unchanged");
    assert.equal(edits.length, 1);
  });

  test("refuses a PR that was not asked", async () => {
    const w = world();
    const db = fresh(w.head);
    await assert.rejects(repostAsk(db, "app", 7, true, w.deps.exec), /not in the asked state/);
  });
});
