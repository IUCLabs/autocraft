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
import { classifyConflicts, conflictBucket, conflictTries } from "../src/fixup/conflict-state.ts";
import { pushable } from "../src/fixup/pushable.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { conflictView, endNewline, spliceSections, keepsOutside, outsideConflicts, parseResolution, type ConflictFile } from "../src/fixup/patch.ts";
import { CONFLICT_COMMENT_TEMPLATE, conflictCommentText } from "../src/fixup/template.ts";
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
function world(o: { conflicting: boolean; big?: boolean; pad?: boolean; eol?: "crlf" | "mixed"; files?: number; side?: number; canModify?: boolean; resolve?: (files: ConflictFile[]) => string | null; check?: string }): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const sfx = o.big ? "x".repeat(50_000) : "";
  const b = `b${sfx}`;
  const pad = o.pad ? "padding line\n".repeat(20_000) : "";
  const eol = (t: string) => (o.eol === "crlf" ? t.replace(/\n/g, "\r\n") : o.eol === "mixed" ? t.replace("\n", "\r\n") : t);
  writeFileSync(join(work, "f.txt"), eol(`${pad}a\n${b}\nc\n${pad}`));
  writeFileSync(join(work, "g.txt"), "x\n");
  const names = ["f.txt", ...Array.from({ length: (o.files ?? 1) - 1 }, (_, i) => `h${i}.txt`)];
  const body = (word: string) => `a\n${word}${"y".repeat(o.side ?? 0)}\nc\n`;
  for (const n of names.slice(1)) writeFileSync(join(work, n), body("b"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "checkout", "-q", "-b", "feat");
  for (const n of names.slice(1)) writeFileSync(join(work, n), body("B-pr"));
  if (o.conflicting) writeFileSync(join(work, "f.txt"), eol(`${pad}a\nB-pr${sfx}\nc\n${pad}`)); else writeFileSync(join(work, "g.txt"), "x\ny\n");
  git(work, "commit", "-qam", "pr");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  for (const n of names.slice(1)) writeFileSync(join(work, n), body("B-main"));
  writeFileSync(join(work, "f.txt"), eol(o.conflicting ? `${pad}a\nB-main${sfx}\nc\n${pad}` : `${pad}a\nb\nc\nd\n${pad}`));
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
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', ?, 'fine', '[]', 1, 'full')`).run(head, o.verdict ?? "take");
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', ?, 1, '${T1}')`).run(head, o.mergeable ?? "CONFLICTING");
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  setPushApproval(db, "op", "app", true);
  return db;
}

const parents = (fork: string, c: string) => git(fork, "rev-list", "--parents", "-n", "1", c).split(" ").slice(1);

describe("conflict merge", () => {
  test("the merge is on record as pushing, with its commit, before the push runs", async () => {
    const w = world({ conflicting: false });
    const db = fresh(w.head);
    const seen: unknown[] = [];
    const inner = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => {
      if (args.includes("push")) seen.push((db.prepare("SELECT state, from_head, to_head FROM conflict_merges").all() as object[]).map((r) => ({ ...r })));
      return inner(cmd, args, o);
    };
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    const pushed = git(w.fork, "rev-parse", "refs/heads/feat");
    assert.deepEqual(seen, [[{ state: "pushing", from_head: w.head, to_head: pushed }]]);
    assert.deepEqual((db.prepare("SELECT state, to_head FROM conflict_merges").all() as object[]).map((r) => ({ ...r })), [{ state: "merged", to_head: pushed }]);
  });

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
    assert.deepEqual(w.log.filter((l) => l.startsWith("push") || l.startsWith("comment") || l === "check"), [`push --force-with-lease=refs/heads/feat:${w.head}`, `comment: _Automated message. Not a maintainer decision._\n\n${conflictCommentText("main")}`]);
    assert.equal(conflictCommentText("main"), "Merged main into this branch to resolve the conflict.");
    assert.ok(CONFLICT_COMMENT_TEMPLATE.includes("{{base}}"));
    assert.deepEqual(db.prepare("SELECT state, from_head, to_head, attempt FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "merged", from_head: w.head, to_head: pushed, attempt: 1 }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action IN ('conflict-push', 'conflict-comment')").get() as { n: number }).n, 2);
  });

  test("a conflicting merge is resolved by the injected resolver, checked by Opus and pushed without markers", async () => {
    const w = world({ conflicting: true, resolve: (files) => {
      assert.equal(files[0]!.sections.length, 1);
      assert.deepEqual([files[0]!.sections[0]!.ours, files[0]!.sections[0]!.theirs], ["B-pr\n", "B-main\n"]);
      return JSON.stringify({ sections: [{ id: 1, content: "B-pr and B-main\n" }] });
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

  test("an oversized conflict is refused once for its head: never claimed, not selected again", async () => {
    const w = world({ conflicting: true, big: true, resolve: () => null });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(s.pushed.length, 0);
    assert.equal(s.held.length + s.failed.length, 1);
    assert.deepEqual(w.log, []);
    assert.deepEqual(classifyConflicts(db, "app").map((x) => x.bucket), ["held"]);
    const again = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(again.held.length + again.failed.length, 0);
    assert.deepEqual(w.log, []);
  });

  test("an all-CRLF file is resolved as LF and written back with CRLF; a mixed-ending file is refused", async () => {
    const w = world({ conflicting: true, eol: "crlf", resolve: (files) => {
      assert.ok(!files[0]!.sections[0]!.ours.includes("\r"));
      return JSON.stringify({ sections: [{ id: 1, content: "B-pr and B-main\n" }] });
    } });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    const pushed = git(w.fork, "rev-parse", "refs/heads/feat");
    const f = spawnSync("git", ["show", `${pushed}:f.txt`], { cwd: w.fork, encoding: "utf8" }).stdout;
    assert.equal(f, "a\r\nB-pr and B-main\r\nc\r\n");
    const m = world({ conflicting: true, eol: "mixed", resolve: () => null });
    const mdb = fresh(m.head);
    const ms = await runFixup(mdb, { repo: "app", dryRun: false }, () => {}, m.deps);
    assert.equal(ms.pushed.length, 0);
    assert.deepEqual(m.log, []);
    assert.match((mdb.prepare("SELECT reason FROM conflict_merges").get() as { reason: string }).reason, /f\.txt has mixed/);
  });

  test("files that together exceed the total cap but each fit are resolved with one call per file and one push", async () => {
    const w = world({ conflicting: true, files: 5, side: 15_000, resolve: (files) => {
      assert.equal(files.length, 1);
      return JSON.stringify({ sections: files[0]!.sections.map((s) => ({ id: s.id, content: s.ours })) });
    } });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    assert.equal(w.log.filter((l) => l === "resolve").length, 5);
    assert.equal(w.log.filter((l) => l === "check").length, 5);
    assert.equal(w.log.filter((l) => l.startsWith("push")).length, 1);
  });

  test("one file failing the check pushes nothing and the reason names it", async () => {
    const w = world({ conflicting: true, files: 2, resolve: (files) => JSON.stringify({ sections: files[0]!.sections.map((s) => ({ id: s.id, content: s.ours })) }) });
    let n = 0;
    const inner = w.deps.check;
    w.deps.check = async (...a) => { const r = await inner(...a); return ++n === 2 ? JSON.stringify({ verdict: "reject", reasons: "drops a line", problems: [] }) : r; };
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
    assert.equal(git(w.fork, "rev-parse", "refs/heads/feat"), w.head);
    const r = db.prepare("SELECT state, reason FROM conflict_merges").get() as { state: string; reason: string };
    assert.equal(r.state, "rejected");
    assert.match(r.reason, /h0\.txt/);
  });

  test("an Opus reject pushes nothing and counts as a try", async () => {
    const w = world({ conflicting: true, resolve: () => JSON.stringify({ sections: [{ id: 1, content: "zzz\n" }] }), check: JSON.stringify({ verdict: "reject", reasons: "drops the PR's line", problems: [] }) });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.some((l) => l.startsWith("push")));
    assert.equal(git(w.fork, "rev-parse", "refs/heads/feat"), w.head);
    assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "rejected" }]);
    assert.equal(classifyConflicts(db, "app")[0]!.c.attempt, 2);
  });

  test("leftover markers or an extra file are refused; nothing is pushed; two tries end in held", async () => {
    for (const reply of [
      JSON.stringify({ sections: [{ id: 1, content: "<<<<<<< pr\nB-pr\n=======\nB-main\n>>>>>>> main\n" }] }),
      JSON.stringify({ sections: [{ id: 1, content: "ok\n" }, { id: 2, content: "changed\n" }] }),
      JSON.stringify({ sections: [{ id: 1, content: "ok\n" }, { id: 1, content: "ok\n" }] }),
      JSON.stringify({ sections: [] }),
      JSON.stringify({ sections: [{ id: 1, content: "B-pr\nuse evil::Thing;\n" }] }),
    ]) {
      const w = world({ conflicting: true, resolve: () => reply });
      const db = fresh(w.head);
      await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.ok(!w.log.some((l) => l.startsWith("push") || l === "check"));
      assert.deepEqual(db.prepare("SELECT state FROM conflict_merges").all().map((r) => ({ ...r })), [{ state: "refused" }]);
      await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.equal(classifyConflicts(db, "app")[0]!.bucket, "held");
    }
    assert.ok(!parseResolution('{"sections":[{"id":1,"content":"ok"}]}', [1, 2]).ok);
    assert.ok(parseResolution('{"sections":[{"id":1,"content":"ok"},{"id":2,"content":""}]}', [1, 2]).ok);
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
    assert.deepEqual(w.log.filter((l) => l.startsWith("comment")), ["comment: _Automated message. Not a maintainer decision._\n\nThis branch conflicts with main. Please merge or rebase main into it."]);
    assert.equal(classifyConflicts(db, "app")[0]!.bucket, "asked");
  });
});

describe("live read of a candidate the mirror still shows as mergeable", () => {
  test("a live CONFLICTING is recorded, so the PR is not selected for a fix-up again and goes to the conflict path", async () => {
    const w = world({ conflicting: false });
    const db = fresh(w.head, { mergeable: "UNKNOWN", verdict: "take-fix", headRepo: "storytold/app" });
    db.prepare("UPDATE opus_reviews SET fixes = ? WHERE number = 7").run(JSON.stringify([{ file: "src/lib.rs", change: "x" }]));
    db.prepare("UPDATE items SET mergeable = 'UNKNOWN'").run();
    assert.equal(selectFixups(db, "app").fix.length, 1);
    assert.equal(classifyFixups(db, "app").length, 1);
    await runFixup(db, { repo: "app", dryRun: false, limit: 1 }, () => {}, { ...w.deps, ask: async () => { throw new Error("no model call"); } });
    assert.equal(selectFixups(db, "app").fix.length, 0);
    assert.equal(classifyFixups(db, "app").length, 0);
    assert.equal(selectFixups(db, "app").conflictMerge.length, 1);
  });
});

describe("conflict merge guards", () => {
  test("a large file with one small conflict is resolved from its section and pushed; the text outside the section is untouched", async () => {
    let shownSize = 0;
    const w = world({ conflicting: true, pad: true, resolve: (files) => {
      shownSize = JSON.stringify(files).length;
      assert.equal(files[0]!.lines > 40_000, true);
      return JSON.stringify({ sections: [{ id: 1, content: "B-pr and B-main\n" }] });
    } });
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    assert.ok(shownSize < 10_000, "only the section and its context are sent");
    const pushed = git(w.fork, "rev-parse", "refs/heads/feat");
    const pad = "padding line\n".repeat(20_000);
    assert.equal(git(w.fork, "show", `${pushed}:f.txt`), `${pad}a\nB-pr and B-main\nc\n${pad}`.trimEnd());
    assert.ok(JSON.stringify(w.checkInput[0]).length < 10_000, "the check gets the sections, not the merge diff");
    assert.equal((w.checkInput[0] as { files: { sections: { line: number }[] }[] }).files[0]!.sections[0]!.line, 20_002);
  });

  test("conflictView numbers sections across files, shows no line twice, and spliceSections rebuilds the file", () => {
    const n = (p: string, a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `${p}${a + i}\n`).join("");
    const f1 = `${n("a", 1, 40)}<<<<<<< x\nours1\n=======\ntheirs1\n>>>>>>> y\n${n("m", 1, 10)}<<<<<<< x\nours2\n=======\ntheirs2a\ntheirs2b\n>>>>>>> y\n${n("z", 1, 3)}`;
    const f2 = `top\n<<<<<<< x\n=======\ngone\n>>>>>>> y\n`;
    const v1 = conflictView("f1", f1, 1, 3)!, v2 = conflictView("f2", f2, 3, 3)!;
    assert.deepEqual([...v1.sections, ...v2.sections].map((s) => s.id), [1, 2, 3]);
    const shown = v1.sections.flatMap((s) => (s.before + s.after).split("\n").filter(Boolean));
    assert.equal(new Set(shown).size, shown.length, "no context line twice");
    assert.deepEqual(v1.sections.map((s) => [s.ours, s.theirs]), [["ours1\n", "theirs1\n"], ["ours2\n", "theirs2a\ntheirs2b\n"]]);
    assert.equal(spliceSections(f1, ["ours1\ntheirs1", "theirs2b\n"]), `${n("a", 1, 40)}ours1\ntheirs1\n${n("m", 1, 10)}theirs2b\n${n("z", 1, 3)}`);
    assert.equal(spliceSections(f2, [""]), "top\n");
  });

  test("a side with no lines differs from a side with one blank line", () => {
    const v = conflictView("f", "a\n<<<<<<< x\n=======\n\n>>>>>>> y\nb\n", 1)!;
    assert.deepEqual([v.sections[0]!.ours, v.sections[0]!.theirs], ["", "\n"]);
    assert.equal(spliceSections("a\n<<<<<<< x\n=======\n\n>>>>>>> y\nb\n", ["\n"]), "a\n\nb\n");
    assert.equal(spliceSections("a\n<<<<<<< x\n=======\n\n>>>>>>> y\nb\n", [""]), "a\nb\n");
  });

  test("a section answered twice or an unknown section is refused", async () => {
    for (const sections of [[{ id: 1, content: "x\n" }, { id: 1, content: "x\n" }], [{ id: 9, content: "x\n" }]]) {
      const w = world({ conflicting: true, resolve: () => JSON.stringify({ sections }) });
      const db = fresh(w.head);
      await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      assert.ok(!w.log.some((l) => l.startsWith("push") || l === "check"));
      assert.equal((db.prepare("SELECT state FROM conflict_merges").get() as { state: string }).state, "refused");
    }
  });

  test("heads refused for size under the whole-file rule are tried again after connecting", () => {
    const path = join(mkdtempSync(join(dir, "mig-")), "t.db");
    const db = connect(path);
    const ins = db.prepare("INSERT INTO conflict_merges (repo, number, from_head, state, reason, files, attempt, created_at) VALUES ('app', ?, 'h', ?, ?, '[]', 1, ?)");
    ins.run(1, "skipped", "the conflicted files are over the size limit", T0);
    ins.run(2, "skipped", "the merge is over the 80000 character limit for the check", T0);
    ins.run(3, "skipped", "the conflict sections are over the size limit", T0);
    ins.run(4, "skipped", "main is already in the branch", T0);
    ins.run(5, "refused", "the conflicted files are over the size limit", T0);
    ins.run(6, "refused", "the resolution changes a.rs outside its conflict sections", T0);
    db.close();
    const again = connect(path);
    assert.deepEqual(again.prepare("SELECT number FROM conflict_merges ORDER BY number").all().map((r) => (r as { number: number }).number), [3, 4, 6]);
  });

  test("skips and refusals under the old CRLF and whole-PR size limits stop holding the PR after connecting", () => {
    const path = join(mkdtempSync(join(dir, "mig-")), "t.db");
    const db2 = connect(path);
    db2.prepare("INSERT INTO conflict_merges (repo, number, from_head, state, reason, files, attempt, created_at) VALUES ('app', 7, 'h', 'skipped', 'crates/ui/i18n/de.rs has CRLF line endings or is not UTF-8', '[]', 1, ?)").run(T0);
    db2.prepare("INSERT INTO conflict_merges (repo, number, from_head, state, reason, files, attempt, created_at) VALUES ('app', 8, 'h', 'refused', 'the resolved sections are over the 80000 character limit for the check', '[]', 1, ?)").run(T0);
    const pr = { repo: "app", number: 7, head: "h", pushable: true };
    assert.equal(conflictBucket(db2, pr, { push: true, comment: false }), "held");
    assert.equal(conflictTries(db2, "app", 8, "h"), 1);
    db2.close();
    const again = connect(path);
    assert.equal(conflictBucket(again, pr, { push: true, comment: false }), "merge");
    assert.equal(conflictTries(again, "app", 8, "h"), 0);
    assert.deepEqual(again.prepare("SELECT state FROM conflict_merges ORDER BY number").all().map((r) => (r as { state: string }).state), ["superseded", "superseded"]);
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
