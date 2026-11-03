import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { postmergeOf } from "../src/dash/api/postmerge.ts";
import { connect } from "../src/db.ts";
import type { Exec } from "../src/fixup/git.ts";
import { inPilot, setPilot } from "../src/pilot.ts";
import { fileFinding, runPostmergeFile, type FileDeps } from "../src/postmerge/file.ts";
import { reviewOne } from "../src/postmerge/index.ts";
import { queueBackfill, relatedOpen, runPostmerge, type PostmergeDeps } from "../src/postmerge/review.ts";
import { issueBody, issueTitle } from "../src/postmerge/template.ts";
import { ghMerged } from "../src/review/diff.ts";
import { selectPostmerge, type FollowupState } from "../src/postmerge/select.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "postmerge-test-"));

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
type F = { severity: string; title: string; body?: string; duplicate_of?: number | null; file?: string | null; line?: number | null };
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
    fileExists: async () => true,
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

const nowIn = (deps: FileDeps, ms: number): FileDeps => ({ ...deps, now: () => new Date(Date.now() + ms) });
const lost: Exec = async () => ({ code: 1, stdout: "", stderr: "error connecting to api.github.com" });
const refused: Exec = async () => ({ code: 1, stdout: "", stderr: "GraphQL: Repository has disabled issues. (HTTP 410)" });
const withExec = (created: Created[], exec: Exec): FileDeps => ({ ...fakeGh(created), exec: (async (c, a, o) => { created.push({ args: a, input: o?.input }); return exec(c, a, o); }) as Exec });

async function reviewedWith(findings: F[]): Promise<DatabaseSync> {
  const db = fresh();
  const restore = setRunner(fakeModel([], findings));
  try { await runPostmerge(db, { repo: "app" }, () => {}, deps); } finally { restore(); }
  return db;
}

describe("filing safety", () => {
  test("a lost response leaves the row in filing: never filed again, counted, shown as unknown", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    let handled = 0;
    const s = await runPostmergeFile(db, { repo: "app", onHandled: (n) => { handled = n; } }, () => {}, withExec(created, lost));
    assert.equal(created.length, 1);
    assert.equal(handled, 1);
    assert.equal(s.unknown.length, 1);
    assert.deepEqual(states(db), ["0:filing"]);
    await runPostmergeFile(db, { repo: "app" }, () => {}, nowIn(fakeGh(created), 48 * 3600_000));
    assert.equal(created.length, 1, "not tried again");
    assert.equal(postmergeOf(db, "app", 1, false)!.findings[0]!.filing.state, "unknown");
  });

  test("a record failure after a successful create leaves filing", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    const real = fakeGh(created);
    db.exec("CREATE TRIGGER no_filed BEFORE UPDATE ON postmerge_followups WHEN NEW.state = 'filed' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    db.exec("CREATE TRIGGER no_filed2 BEFORE INSERT ON postmerge_followups WHEN NEW.state = 'filed' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const s = await runPostmergeFile(db, { repo: "app" }, () => {}, real);
    assert.equal(s.unknown.length, 1);
    assert.deepEqual(states(db), ["0:filing"]);
  });

  test("a refusal by GitHub is failed with a backoff of 1 h, then 6 h, then stops after three tries", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, withExec(created, refused));
    assert.deepEqual(states(db), ["0:failed"]);
    await runPostmergeFile(db, { repo: "app" }, () => {}, withExec(created, refused));
    assert.equal(created.length, 1, "not retried at once");
    await runPostmergeFile(db, { repo: "app" }, () => {}, nowIn(withExec(created, refused), 2 * 3600_000));
    assert.equal(created.length, 2);
    await runPostmergeFile(db, { repo: "app" }, () => {}, nowIn(withExec(created, refused), 4 * 3600_000));
    assert.equal(created.length, 2, "the second backoff is 6 h");
    await runPostmergeFile(db, { repo: "app" }, () => {}, nowIn(withExec(created, refused), 9 * 3600_000));
    assert.equal(created.length, 3);
    await runPostmergeFile(db, { repo: "app" }, () => {}, nowIn(withExec(created, refused), 400 * 3600_000));
    assert.equal(created.length, 3, "stops after three");
    assert.equal(db.prepare("SELECT attempts FROM postmerge_followups").get()!.attempts, 3);
  });

  test("--again files nothing for a PR with a filed follow-up; the file command files one and the prompt lists the earlier ones", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    const prompts: string[] = [];
    const restore = setRunner(fakeModel(prompts, [{ severity: "defect", title: "Rows are cropped" }, { severity: "defect", title: "Header is skipped", file: "src/other.rs" }]));
    try { await runPostmerge(db, { repo: "app", only: [1] }, () => {}, deps); } finally { restore(); }
    assert.match(prompts[0]!, /"filed_before": \[\s*\{\s*"number": 50,\s*"state": "open",\s*"title": "Stride is wrong"/);
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created, 60));
    assert.equal(created.length, 1);
    const shown = postmergeOf(db, "app", 1, false)!;
    assert.deepEqual(shown.findings.map((f) => f.filing), [{ state: "held", reason: "earlier" }, { state: "held", reason: "earlier" }]);
    assert.equal(shown.earlier.length, 1);
    await assert.rejects(fileFinding(db, "app#1", 5, () => {}, fakeGh(created, 60)), /no finding 5/);
    const o = await fileFinding(db, "app#1", 1, () => {}, fakeGh(created, 60));
    assert.equal(o.kind, "filed");
    assert.equal(created.length, 2);
    assert.equal(created[1]!.args[5], "Header is skipped");
    await assert.rejects(fileFinding(db, "app#1", 1, () => {}, fakeGh(created, 60)), /already filed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'postmerge-file-one'").get()!.n, 1);
  });

  test("the review command refuses while a postmerge job runs for the repo", async () => {
    const db = fresh();
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, repo) VALUES ('postmerge', '{}', 'pipeline', ?, 'running', 'app')").run(new Date().toISOString());
    await assert.rejects(reviewOne(db, "app#1", true, () => {}), /job is running/);
  });

  test("a defect that repeats another one in the same file, near the line, with a similar title is filed once", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong in decode" }]);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, updated_at) VALUES ('app', 2, 'pr', 'MERGED', 'Other', ?, ?)").run(now, now);
    db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome) VALUES ('app', 2, 'head2', 'm1', ?, 'rule', 'merge', 'merged')").run(now);
    const f2 = [finding({ severity: "defect", title: "decode: wrong stride", line: 15 }), finding({ severity: "defect", title: "Stride is wrong in decode", line: 400 })];
    db.prepare("INSERT INTO postmerge_reviews (repo, number, merge_sha, at, model, findings) VALUES ('app', 2, 'x', ?, 'opus', ?)").run(new Date(Date.now() + 1000).toISOString(), JSON.stringify(f2));
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.deepEqual(created.map((c) => c.args[5]), ["Stride is wrong in decode", "Stride is wrong in decode"], "the one at line 400 is a separate defect");
    const dup = db.prepare("SELECT state, duplicate_of FROM postmerge_followups WHERE number = 2 AND finding = 0").get()!;
    assert.deepEqual([dup.state, dup.duplicate_of], ["skipped-duplicate", 1]);
  });

  test("a cited file that is gone from the default branch is skipped as stale", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, { ...fakeGh(created), fileExists: async () => false });
    assert.equal(created.length, 0);
    assert.deepEqual(states(db), ["0:skipped-stale"]);
  });

  test("a body that names the product or the pipeline account is stored and not filed", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "One", body: "AutoCraft left this open." }, { severity: "defect", title: "Two", body: "pipeline-bot wrote this." }, { severity: "defect", title: "Three", body: "Fine." }]);
    db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'pipeline-bot')").run();
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    assert.deepEqual(created.map((c) => c.args[5]), ["Three"]);
    assert.deepEqual(states(db), ["0:skipped-text", "1:skipped-text", "2:filed#50"]);
  });

  test("a PR that fixes a follow-up issue is not filed for automatically", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    const created: Created[] = [];
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, updated_at) VALUES ('app', 2, 'pr', 'MERGED', 'Fix', ?, ?)").run(now, now);
    db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome) VALUES ('app', 2, 'head2', 'm1', ?, 'rule', 'merge', 'merged')").run(now);
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 50, 'm', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/2', ?, ?)").run(now, now);
    const restore = setRunner(fakeModel([], [{ severity: "defect", title: "New problem" }]));
    try { await runPostmerge(db, { repo: "app" }, () => {}, deps); } finally { restore(); }
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh(created, 60));
    assert.equal(created.length, 1);
    assert.deepEqual(postmergeOf(db, "app", 2, false)!.findings[0]!.filing, { state: "held", reason: "fix" });
  });

  test("a Fix PR of a follow-up issue of a pilot PR is a pilot item", async () => {
    const db = await reviewedWith([{ severity: "defect", title: "Stride is wrong" }]);
    await runPostmergeFile(db, { repo: "app" }, () => {}, fakeGh([]));
    setPilot(db, "op", ["app#1"]);
    assert.equal(inPilot(db, "app", 2), false);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, pr_url, created_at, updated_at) VALUES ('app', 50, 'm', 'h', 'pr-opened', 'https://github.com/storytold/app/pull/2', ?, ?)").run(now, now);
    assert.equal(inPilot(db, "app", 2), true);
    assert.equal(inPilot(db, "app", 3), false);
  });
});

describe("review inputs", () => {
  test("a failed review is given up on after three tries", async () => {
    const db = fresh();
    const bad = { ...deps, fetchMerged: async () => ({ ok: false as const, tooLarge: false, error: "boom" }) };
    for (let i = 0; i < 3; i++) await runPostmerge(db, { repo: "app", only: [1] }, () => {}, bad);
    assert.match(db.prepare("SELECT error FROM postmerge_reviews").get()!.error as string, /^held: gave up after 3 tries/);
    assert.deepEqual(selectPostmerge(db, "app", Date.now() + 99 * 3600_000), []);
  });

  test("a batch member is asked for with the batch flag", async () => {
    const db = fresh();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO merge_batches (id, repo, branch, state, base_sha, commit_sha, created_at, updated_at) VALUES (1, 'app', 'integration-app-1', 'merged', 'b', 'c', ?, ?)").run(now, now);
    db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (1, 1, 'head1', 0)").run();
    const seen: unknown[] = [];
    const restore = setRunner(fakeModel([], []));
    try { await runPostmerge(db, { repo: "app" }, () => {}, { ...deps, fetchMerged: async (_r, _n, o) => { seen.push(o); return { ok: true, sha: null, text: DIFF }; } }); } finally { restore(); }
    assert.deepEqual(seen, [{ batch: true }]);
  });

  test("related items include ones closed in the last 30 days, with their state", () => {
    const db = fresh();
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    const add = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, closed_at, created_at, updated_at) VALUES ('app', ?, 'issue', ?, ?, 'about #1', ?, 'z', 'z')");
    add.run(5, "OPEN", "Open one", null);
    add.run(6, "CLOSED", "Closed lately", day(3));
    add.run(7, "CLOSED", "Closed long ago", day(90));
    assert.deepEqual(relatedOpen(db, "app", 1, []).map((r) => [r.number, r.state]), [[5, "open"], [6, "closed"]]);
  });

  test("a backfill more than 14 days back needs --yes", () => {
    const db = fresh();
    const back = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
    assert.throws(() => queueBackfill(db, "cli", back(20)), /--yes/);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'postmerge_since'").get()!.value !== back(20), true);
    assert.equal(queueBackfill(db, "cli", back(10)), 1);
    assert.equal(queueBackfill(db, "cli", back(20), { yes: true }), 1);
  });
});

describe("merged diff", () => {
  /** A fake `gh` first on PATH: `pr diff` fails when FAIL_OWN is set; everything else answers. Calls are logged. */
  function withFakeGh<T>(failOwn: boolean, f: (log: string) => Promise<T>): Promise<T> {
    const bin = mkdtempSync(join(dir, "bin-")), log = join(bin, "calls");
    writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "pr diff") ${failOwn ? 'echo "no diff" >&2; exit 1' : `printf '%s' 'diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-1\n+2\n'`} ;;
  "pr view") echo ${"a".repeat(40)} ;;
  *) printf '%s' 'diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-1\n+3\ndiff --git a/src/other.rs b/src/other.rs\n--- a/src/other.rs\n+++ b/src/other.rs\n@@ -1 +1 @@\n-1\n+2\n' ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    return f(log).finally(() => { process.env.PATH = old; });
  }

  test("when the PR's own diff fails there is no diff, not the whole merge commit", async () => {
    const r = await withFakeGh(true, () => ghMerged("app", 1));
    assert.equal(r.ok, false);
    const db = fresh();
    await runPostmerge(db, { repo: "app" }, () => {}, { ...deps, fetchMerged: async () => r });
    assert.match(db.prepare("SELECT error FROM postmerge_reviews").get()!.error as string, /^retry: no merged diff/);
  });

  test("the merge commit's diff is kept to the PR's own files; a batch member is read as its own diff", async () => {
    const plain = await withFakeGh(false, () => ghMerged("app", 1));
    assert.ok(plain.ok && plain.sha === "a".repeat(40));
    assert.ok(plain.ok && plain.text.includes("+3") && !plain.text.includes("other.rs"));
    const member = await withFakeGh(false, async (log) => { const r = await ghMerged("app", 1, { batch: true }); return { r, calls: readFileSync(log, "utf8") }; });
    assert.ok(member.r.ok && member.r.sha === null && member.r.text.includes("+2"));
    assert.doesNotMatch(member.calls, /commits\//);
  });
});

describe("public text", () => {
  test("URLs, links, issue references and mentions go outside code and stay inside it", () => {
    const body = issueBody({ number: 4, model: "opus", file: "src/a.rs", line: 3, body:
      "See [the docs](https://example.com/x) or https://example.com/y and storytold/app#12, also #7 and issue #8. Ping @someone.\n\n`@keep https://example.com/z #9`\n\n```\nlet a = \"#10 @x\";\n```" });
    assert.match(body, /^_AI-generated review \(Opus\)\. Not a maintainer decision\._\n\nFollow-up to #4\.\n\n/);
    assert.match(body, /See the docs or\s+and issue 12, also issue 7 and issue 8\. Ping someone\./);
    assert.match(body, /`@keep https:\/\/example\.com\/z #9`/);
    assert.match(body, /let a = "#10 @x";/);
    assert.match(body, /Location: `src\/a\.rs:3`/);
    assert.equal(issueTitle("Fix #5 in storytold/app#6 at https://x.y"), "Fix issue 5 in issue 6 at");
  });
});
