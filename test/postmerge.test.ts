import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { postmergeOf } from "../src/dash/api/postmerge.ts";
import { connect } from "../src/db.ts";
import type { Exec } from "../src/fixup/git.ts";
import { inPilot, setPilot } from "../src/pilot.ts";
import { runPostmergeFile, type FileDeps } from "../src/postmerge/file.ts";
import { reviewOne } from "../src/postmerge/index.ts";
import { runPostmerge, type PostmergeDeps } from "../src/postmerge/review.ts";
import { selectPostmerge, type FollowupState } from "../src/postmerge/select.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "postmerge-test-"));

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
type F = { severity: string; title: string; body?: string; duplicate_of?: number | null };
const finding = (f: F) => ({ file: "src/lib.rs", line: 1, missed_by: "review", missed_why: "not read", body: `${f.title}: body`, duplicate_of: null, ...f });

/** Repo `app` with PR 1 merged by the pipeline, commenting approved. */
function fresh(approved = true): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  const now = new Date().toISOString();
  db.exec("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')");
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1) ON CONFLICT DO NOTHING").run(now);
  db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, head_oid, created_at, updated_at) VALUES ('app', 1, 'pr', 'MERGED', 'Fix the stride', 'Fixes the stride.', 'regular', 'head1', ?, ?)").run(now, now);
  db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome) VALUES ('app', 1, 'head1', 'm1', ?, 'rule', 'merge', 'merged')").run(now);
  if (approved) setCommentApproval(db, "op", "app", true);
  return db;
}

function fakeModel(calls: string[], findings: F[]): Runner {
  return async (_cmd, _args, input) => {
    calls.push(input);
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify({ findings: findings.map(finding) }), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
  };
}

const deps: PostmergeDeps = { fetchMerged: async () => ({ ok: true, sha: "merge1", text: DIFF }), model: "opus", maxChars: 120_000 };

type Created = { args: string[]; input: string | undefined };
function fakeGh(created: Created[], first = 50): FileDeps {
  let next = first;
  return {
    now: () => new Date(),
    exec: (async (_cmd, args, opts) => {
      created.push({ args, input: opts?.input });
      return { code: 0, stdout: `https://github.com/storytold/app/issues/${next++}\n`, stderr: "" };
    }) as Exec,
  };
}

const states = (db: DatabaseSync) => (db.prepare("SELECT finding, state, issue_number FROM postmerge_followups ORDER BY finding").all() as { finding: number; state: FollowupState; issue_number: number | null }[]).map((r) => `${r.finding}:${r.state}${r.issue_number ? `#${r.issue_number}` : ""}`);

describe("post-merge review", () => {
  test("a merged PR gets one review, with the merge commit's diff and the PR's history in the prompt", async () => {
    const db = fresh();
    db.prepare("INSERT INTO conflict_merges (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('app', 1, 'h0', 'head1', 'merged', 1, ?)").run(new Date().toISOString());
    assert.deepEqual(selectPostmerge(db, "app").map((c) => c.number), [1]);
    const calls: string[] = [];
    const restore = setRunner(fakeModel(calls, [{ severity: "minor", title: "Stale comment" }]));
    try {
      const s = await runPostmerge(db, { repo: "app" }, () => {}, deps);
      assert.equal(s.reviewed, 1);
      await runPostmerge(db, { repo: "app" }, () => {}, deps);
    } finally { restore(); }
    assert.equal(calls.length, 1, "reviewed once");
    assert.match(calls[0]!, /"merge_sha": "merge1"/);
    assert.match(calls[0]!, /"kind": "conflict-merge"/);
    assert.match(calls[0]!, /\+let a = 2;/);
    assert.deepEqual(selectPostmerge(db, "app"), []);
  });

  test("a PR outside the pilot is not reviewed", () => {
    const db = fresh();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, updated_at) VALUES ('app', 9, 'pr', 'OPEN', 'x', 'z', 'z')").run();
    setPilot(db, "op", ["app#9"]);
    assert.deepEqual(selectPostmerge(db, "app"), []);
  });

  test("a failed review is tried again after an hour, a held one is not", async () => {
    const db = fresh();
    const restore = setRunner(async () => ({ code: 0, stdout: JSON.stringify({ type: "result", result: "no json", usage: {} }), stderr: "" }));
    try { await runPostmerge(db, { repo: "app" }, () => {}, deps); } finally { restore(); }
    assert.deepEqual(selectPostmerge(db, "app"), []);
    assert.equal(selectPostmerge(db, "app", Date.now() + 2 * 3600_000).length, 1);
    const held = fresh();
    await runPostmerge(held, { repo: "app" }, () => {}, { ...deps, fetchMerged: async () => ({ ok: false, tooLarge: true, error: "406" }) });
    assert.deepEqual(selectPostmerge(held, "app", Date.now() + 2 * 3600_000), []);
  });

  test("the command refuses a second review without --again and a PR the pipeline did not merge", async () => {
    const db = fresh();
    await assert.rejects(reviewOne(db, "app#7", false, () => {}), /not merged by the pipeline/);
    db.prepare("INSERT INTO postmerge_reviews (repo, number, merge_sha, at, findings) VALUES ('app', 1, 'x', 'a', '[]')").run();
    await assert.rejects(reviewOne(db, "app#1", false, () => {}), /--again/);
  });
});

describe("filing", () => {
  async function reviewed(findings: F[], approved = true): Promise<DatabaseSync> {
    const db = fresh(approved);
    const restore = setRunner(fakeModel([], findings));
    try { await runPostmerge(db, { repo: "app" }, () => {}, deps); } finally { restore(); }
    return db;
  }

  test("a defect becomes one issue with the follow-up body, once, and the issue is a pilot item", async () => {
    const db = await reviewed([{ severity: "defect", title: "Stride is wrong", body: "`decode` at src/lib.rs:1 reads half of each row." }]);
    const created: Created[] = [];
    const s = await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.deepEqual(s.filed, [{ ref: "app#1", issue: 50 }]);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0]!.args.slice(0, 6), ["issue", "create", "--repo", "storytold/app", "--title", "Stride is wrong"]);
    const body = created[0]!.input!;
    assert.match(body, /^_AI-generated review \(Opus\)\. Not a maintainer decision\._\n\nFollow-up to #1\.\n\n`decode` at src\/lib\.rs:1 reads half of each row\./);
    assert.doesNotMatch(body, /autocraft/i);
    assert.deepEqual(states(db), ["0:filed#50"]);
    const audit = db.prepare("SELECT login, target, details FROM audit WHERE action = 'postmerge-file'").all() as { login: string; target: string; details: string }[];
    assert.deepEqual(audit.map((a) => [a.login, a.target, JSON.parse(a.details).state]), [["postmerge-file", "app#1", "done"]]);
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.equal(created.length, 1, "not filed twice");
    setPilot(db, "op", ["app#1"]);
    assert.equal(inPilot(db, "app", 50), true);
    assert.equal(inPilot(db, "app", 51), false);
  });

  test("a minor finding and a duplicate are stored and never filed", async () => {
    const db = await reviewed([{ severity: "minor", title: "Stale comment" }, { severity: "defect", title: "Known problem", duplicate_of: 14 }]);
    const created: Created[] = [];
    const s = await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.equal(created.length, 0);
    assert.equal(s.candidates, 0);
    assert.deepEqual(states(db), ["0:skipped-minor", "1:skipped-duplicate"]);
    const shown = postmergeOf(db, "app", 1, true)!;
    assert.deepEqual(shown.findings.map((f) => f.filing.state), ["minor", "duplicate"]);
  });

  test("the daily limit stops filing and the rest is filed later", async () => {
    const db = await reviewed([{ severity: "defect", title: "One" }, { severity: "defect", title: "Two" }, { severity: "defect", title: "Three" }]);
    const created: Created[] = [];
    const first = await runPostmergeFile(db, { repo: "app", limit: 1 }, () => {}, fakeGh(created));
    assert.equal(first.filed.length, 1);
    assert.equal(first.limited, 2);
    assert.deepEqual(states(db), ["0:filed#50", "1:skipped-limit", "2:skipped-limit"]);
    assert.deepEqual(postmergeOf(db, "app", 1, false)!.findings.map((f) => f.filing.state), ["filed", "limit", "limit"]);
    const second = await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created, 51));
    assert.equal(second.filed.length, 2);
    assert.deepEqual(created.map((c) => c.args[5]), ["One", "Two", "Three"]);
    assert.deepEqual(states(db), ["0:filed#50", "1:filed#51", "2:filed#52"]);
  });

  test("a repo without comment approval files nothing", async () => {
    const db = await reviewed([{ severity: "defect", title: "Stride is wrong" }], false);
    const created: Created[] = [];
    const s = await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.equal(created.length, 0);
    assert.match(s.note ?? "", /not approved/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'postmerge-file'").get()!.n, 0);
  });

  test("a second review of the PR does not file a defect again", async () => {
    const db = await reviewed([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    const restore = setRunner(fakeModel([], [{ severity: "defect", title: "stride is wrong" }]));
    try { await runPostmerge(db, { repo: "app", only: [1] }, () => {}, deps); } finally { restore(); }
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.equal(created.length, 1);
  });
});

describe("item API", () => {
  test("missed_by and missed_why are for staff only", async () => {
    const db = await (async () => { const d = fresh(); const r = setRunner(fakeModel([], [{ severity: "defect", title: "Stride is wrong" }])); try { await runPostmerge(d, { repo: "app" }, () => {}, deps); } finally { r(); } return d; })();
    const staff = postmergeOf(db, "app", 1, true)!, other = postmergeOf(db, "app", 1, false)!;
    assert.deepEqual([staff.findings[0]!.missedBy, staff.findings[0]!.missedWhy], ["review", "not read"]);
    assert.equal("missedBy" in other.findings[0]!, false);
    assert.equal("missedWhy" in other.findings[0]!, false);
    assert.equal(other.findings[0]!.filing.state, "pending");
  });
});
