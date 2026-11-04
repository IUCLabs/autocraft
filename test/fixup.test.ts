import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { viewFile } from "../src/fixup/excerpt.ts";
import { validatePatch, type FixupPr } from "../src/fixup/patch.ts";
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













});

describe("review of a moved head", () => {
});

describe("fixup repost", () => {

});
