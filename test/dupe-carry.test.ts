// Carry-over of a duplicate group's kept PR through Fix-up: a model patch (fake) checked by the
// patch check (fake), then a push with the lease, or a comment when we can't push.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { setCommentApproval } from "../src/act/approval.ts";
import { connect } from "../src/db.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { selectFixups } from "../src/fixup/candidates.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { carryAskText, carryCommentText } from "../src/fixup/template.ts";
import type { Querier } from "../src/mirror.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";


mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "dupe-carry-"));
process.env.CRAFT_AUTO_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const POINT = "master-page handling in src/lib.rs";
const APPROVE = JSON.stringify({ verdict: "approve", reasons: "ports the listed part", problems: [] });
const REJECT = JSON.stringify({ verdict: "reject", reasons: "ports more than listed", problems: ["x"] });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Kept PR #7 at `head`, closed duplicate #8 with a carry point, one queued carry job. */
function fresh(head: string, o: { canModify?: boolean; push?: boolean; comment?: boolean } = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(T0);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES ('app', ?, 'pr', ?, ?, 'someone', ?, '${T0}', '${T0}')`);
  item.run(7, "OPEN", "Kept", head);
  item.run(8, "CLOSED", "Duplicate", "sha8");
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', ?, '${T1}')`).run(head, o.canModify === false ? 0 : 1);
  const ins = db.prepare("INSERT INTO dupe_group_items (decision_id, repo, number, kind, role, target, detail, base_role) VALUES ('app:dupegroup:7', 'app', ?, 'pr', ?, ?, ?, 'keep')");
  ins.run(7, "keep", null, null);
  ins.run(8, "close", 7, JSON.stringify({ carry: [POINT], better: [], duplicate: true }));
  db.prepare("INSERT INTO dupe_carries (decision_id, repo, number, state, updated_at) VALUES ('app:dupegroup:7', 'app', 7, 'queued', ?)").run(T0);
  if (o.push !== false) setPushApproval(db, "op", "app", true);
  if (o.comment) setCommentApproval(db, "op", "app", true);
  return db;
}

type World = { head: string; fork: string; log: string[]; deps: FixupDeps; asked: any[]; checked: any[] };
function world(o: { check?: string; canModify?: boolean } = {}): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "fix");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/lib.rs"), "fn a() {}\nfn main() { a(); }\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);
  const log: string[] = [];
  const asked: any[] = [];
  const checked: any[] = [];
  const good = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string) {
      if (q.startsWith("mutation")) { log.push("assign"); return {}; }
      return { repository: { pullRequest: { id: "PR7", state: "OPEN", isDraft: false, headRefOid: head, headRefName: "fix", maintainerCanModify: o.canModify !== false, mergeable: "MERGEABLE",
        headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } };
    },
  });
  const run: Exec = async (cmd, args, opts = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      log.push(`comment: ${opts.input}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    const net = args.findIndex((a) => a.startsWith("https://github.com/"));
    const sub = args.map((a) => (a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    if (args.includes("push")) log.push("push");
    return exec("git", net >= 0 ? sub : args, { ...opts });
  };
  const deps: FixupDeps = {
    querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
    fetchDiff: async (_r, n) => ({ ok: true, text: `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {} // ${n}\n` }),
    ask: async (_db, input) => { log.push("model"); asked.push(input[0]); return good; },
    check: async (_db, input) => { log.push("check"); checked.push(input[0]); return o.check ?? APPROVE; },
  };
  return { head, fork, log, deps, asked, checked };
}
function storeSuggestion(db: DatabaseSync, text: string): void {
  db.prepare("INSERT INTO dupe_groups (decision_id, repo, source, applied_answer) VALUES ('app:dupegroup:7', 'app', 'model', 'accept') ON CONFLICT DO NOTHING").run();
  db.prepare("INSERT INTO dupe_group_texts (decision_id, option, number, step, text) VALUES ('app:dupegroup:7', 'accept', 7, 'suggestion', ?)").run(text);
}
const carry = (db: DatabaseSync) => db.prepare("SELECT state, attempts, outcome FROM dupe_carries").get() as { state: string; attempts: number; outcome: string };

describe("carry-over", () => {
  test("a queued carry is selected for a PR we may push to, and for a comment when we may not", () => {
    assert.equal(selectFixups(fresh("h1"), "app").fix[0]!.carry!.sources[0]!.points[0], POINT);
    assert.equal(selectFixups(fresh("h1", { canModify: false }), "app").ask.length, 0);
    assert.equal(selectFixups(fresh("h1", { canModify: false, comment: true }), "app").ask.length, 1);
    assert.equal(selectFixups(fresh("h1", { push: false }), "app").fix.length, 0);
  });

  test("the patch sees the closed PR's diff and parts, the check approves, the push follows with a credit comment", async () => {
    const w = world();
    const db = fresh(w.head);
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.pushed, ["app#7"]);
    assert.equal(w.asked[0].carried_from[0].ref, "app#8");
    assert.deepEqual(w.asked[0].carried_from[0].points, [POINT]);
    assert.match(w.asked[0].carried_from[0].diff, /^diff --git a\/src\/lib\.rs/);
    assert.deepEqual(w.log.filter((l) => l !== "assign" || true), ["model", "check", "push", `comment: ${carryCommentText([8], ["src/lib.rs"])}`]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patch_checks WHERE kind = 'fixup' AND number = 7").get()!.n, 1);
    // The patch check sees where the ported code comes from.
    assert.equal(w.checked[0].carried_from[0].ref, "app#8");
    assert.match(w.checked[0].carried_from[0].diff, /^diff --git/);
    assert.equal(carry(db).state, "done");
    // Take-fix bookkeeping is untouched.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixups").get()!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stages").get()!.n, 0);
  });

  test("a rejected patch pushes nothing and the carry waits for its second try, then is held", async () => {
    const w = world({ check: REJECT });
    const db = fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.ok(!w.log.includes("push"));
    assert.deepEqual([carry(db).state, carry(db).attempts], ["queued", 1]);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual([carry(db).state, carry(db).attempts], ["held", 2]);
    assert.ok(!w.log.includes("push"));
  });

  test("without push permission the points go on the PR as a comment, with no model call", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false, comment: true });
    storeSuggestion(db, carryAskText([{ number: 8, points: [POINT] }]));
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(s.asked, ["app#7"]);
    assert.deepEqual(w.log, [`comment: ${carryAskText([{ number: 8, points: [POINT] }])}`]);
    assert.equal(carry(db).state, "done");
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(w.log.length, 1);
  });

  test("a live PR that stopped accepting maintainer pushes falls back to the comment", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: true, comment: true });
    storeSuggestion(db, carryAskText([{ number: 8, points: [POINT] }]));
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, [`comment: ${carryAskText([{ number: 8, points: [POINT] }])}`]);
  });

  test("the stored suggestion text is posted as it is", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false, comment: true });
    storeSuggestion(db, "stored suggestion text");
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, ["comment: stored suggestion text"]);
  });

  test("a kept PR outside the pilot is not worked on", () => {
    const db = fresh("h1");
    db.prepare("INSERT INTO settings (key, value) VALUES ('pilot_items', ?)").run(JSON.stringify(["app#999"]));
    const sel = selectFixups(db, "app");
    assert.equal(sel.fix.length + sel.ask.length, 0);
  });

  test("without a stored suggestion the carry is held and nothing is posted", async () => {
    const w = world({ canModify: false });
    const db = fresh(w.head, { canModify: false, comment: true });
    const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual(w.log, []);
    assert.deepEqual(s.held.map((h) => h.reason), ["no approved suggestion text"]);
    assert.equal(carry(db).state, "held");
  });
});
