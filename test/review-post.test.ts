import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { modelLabel, reviewBody, REVIEW_BODY_MAX } from "../src/review/post-template.ts";
import { postCandidates, runReviewPost, type PostDeps } from "../src/review/post.ts";
import { COMMENT_TEMPLATES } from "../src/act/templates.ts";
import { pauseReason } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";

const dir = mkdtempSync(join(SCRATCH, "review-post-test-"));
const T0 = "2026-01-01T00:00:00Z";
const sha = (n: number, v = "a") => `${String(n).repeat(7)}${v}`.padEnd(40, "0");

function fresh(opts: { approved?: boolean } = {}): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('app', 'op', ?) ON CONFLICT DO NOTHING").run(T0);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('other', 'op', ?) ON CONFLICT DO NOTHING").run(T0);
  if (opts.approved !== false) setCommentApproval(db, "op", "app", true);
  return db;
}

function addPr(db: DatabaseSync, n: number, o: { repo?: string; author?: string; verdict?: string | null; fixes?: unknown[]; reason?: string; head?: string; model?: string } = {}): string {
  const repo = o.repo ?? "app", head = o.head ?? sha(n);
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES (?, ?, 'pr', 'OPEN', ?, ?, ?, ?, ?)`)
    .run(repo, n, `PR ${n}`, o.author ?? "contrib", head, T0, T0);
  saveOpus(db, repo, n, head, o);
  return head;
}

function saveOpus(db: DatabaseSync, repo: string, n: number, head: string, o: { verdict?: string | null; fixes?: unknown[]; reason?: string; model?: string } = {}): void {
  const verdict = o.verdict === undefined ? "take" : o.verdict;
  db.prepare(`INSERT OR REPLACE INTO opus_reviews (repo, number, head_oid, run_id, at, model, mode, verdict, sure, reason, fixes, risks)
    VALUES (?, ?, ?, 'r', ?, ?, ?, ?, 1, ?, ?, '[]')`).run(repo, n, head, T0, verdict ? (o.model ?? "claude-opus-5-5") : null, verdict ? "full" : "skipped", verdict,
    o.reason ?? "Looks fine.", o.fixes ? JSON.stringify(o.fixes) : null);
}

type Live = { head: string; state: string };
type Fake = PostDeps & { calls: { kind: string; vars: Record<string, unknown> }[]; live: Map<number, Live> };

function fake(live: Record<number, Live> = {}): Fake {
  const map = new Map(Object.entries(live).map(([k, v]) => [Number(k), v]));
  const calls: Fake["calls"] = [];
  const querier: Querier = {
    spent: 0, remaining: null,
    async query(q: string, vars: Record<string, unknown>) {
      if (q.includes("addPullRequestReview")) { calls.push({ kind: "add", vars }); return { addPullRequestReview: { pullRequestReview: { id: `R_${vars.pr}` } } }; }
      if (q.includes("updatePullRequestReview")) { calls.push({ kind: "edit", vars }); return { updatePullRequestReview: { pullRequestReview: { id: vars.id } } }; }
      const l = map.get(vars.n as number);
      return { repository: { pullRequest: l ? { id: `PR_${vars.n}`, headRefOid: l.head, state: l.state, commits: { totalCount: 1, nodes: [] } } : null } };
    },
  };
  return { querier, now: () => new Date("2026-02-01T00:00:00Z"), calls, live: map };
}

const open = (head: string): Live => ({ head, state: "OPEN" });
const quiet = () => {};

describe("model label", () => {
  test("ids become a name and version; unknown ids stay", () => {
    assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
    assert.equal(modelLabel("claude-opus-4-1-20250805"), "Opus 4.1");
    assert.equal(modelLabel("claude-opus-5"), "Opus 5");
    assert.equal(modelLabel("opus"), "Opus");
    assert.equal(modelLabel("jev-latest"), "jev-latest");
    assert.equal(modelLabel(null), "unknown model");
  });
});

describe("review body", () => {
  const base = { model: "claude-opus-5-5", verdict: "take-fix", sure: true, reason: "Handles errors badly.", fixes: [{ file: "src/a.rs:12", change: "Return the error." }], risks: [], head: "0123456789abcdef" };

  test("starts with the disclaimer naming the model, lists the findings and ends with the short head", () => {
    const b = reviewBody(base);
    assert.equal(b, "_AI-generated review (Opus 5.5). Not a maintainer decision._\n\nSmall fixes needed before merging:\n\n- Handles errors badly.\n- `src/a.rs:12`: Return the error.\n\nReviewed at 0123456.");
  });

  test("verdict wording", () => {
    for (const [v, line] of [["take", "No blocking problems found."], ["hold", "Changes needed:"], ["close", "This does not look mergeable as it is:"]] as const)
      assert.match(reviewBody({ ...base, verdict: v, fixes: [] }), new RegExp(`\\n\\n${line}\\n`));
  });

  test("mentions are removed, emails stay, and the body is cut at a line boundary under the cap", () => {
    const b = reviewBody({ ...base, reason: "Ask @alice and @org/team, mail bob@example.com", fixes: Array.from({ length: 20 }, (_, i) => ({ file: `f${i}.rs`, change: `@carol ${"x".repeat(550)}` })) });
    assert.ok(!/(^|[^\w])@\w/.test(b), b);
    assert.match(b, /bob@example\.com/);
    assert.ok(b.length <= REVIEW_BODY_MAX, String(b.length));
    assert.match(b, /\n- …\n\nReviewed at 0123456\.$/);
  });

  test("the Prompts page lists the template", () => {
    const t = COMMENT_TEMPLATES.find((x) => x.id === "review.post")!;
    assert.equal(t.stage, "Review");
    assert.match(t.example, /^_AI-generated review \(Opus 5\.5\)\./);
  });
});

describe("review-post", () => {
  test("posts a COMMENT review at the reviewed head in an approved repo, once", async () => {
    const db = fresh();
    const h = addPr(db, 1);
    const d = fake({ 1: open(h) });
    const s = await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    assert.deepEqual(s.posted, ["app#1"]);
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0]!.vars.oid, h);
    assert.equal(d.calls[0]!.vars.pr, "PR_1");
    assert.match(String(d.calls[0]!.vars.body), /^_AI-generated review \(Opus 5\.5\)\. Not a maintainer decision\._/);
    assert.deepEqual({ ...(db.prepare("SELECT review_id, head_oid FROM review_posts WHERE number = 1").get() as object) }, { review_id: "R_PR_1", head_oid: h });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'review-post'").get() as { n: number }).n, 1);
    const again = await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    assert.equal(again.candidates, 0);
    assert.equal(d.calls.length, 1);
  });

  test("a dry run lists the body and calls nothing", async () => {
    const db = fresh();
    addPr(db, 1);
    const lines: string[] = [];
    const d = fake();
    const s = await runReviewPost(db, { repo: "app" }, (l) => lines.push(l), d);
    assert.equal(s.candidates, 1);
    assert.equal(d.calls.length, 0);
    assert.match(lines.join("\n"), /would review app#1/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM review_posts").get() as { n: number }).n, 0);
  });

  test("nothing in a repo without comment approval", async () => {
    const db = fresh({ approved: false });
    const h = addPr(db, 1);
    const d = fake({ 1: open(h) });
    const s = await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    assert.equal(d.calls.length, 0);
    assert.match(s.note ?? "", /not approved/);
  });

  test("nothing when the live head moved or the PR closed", async () => {
    const db = fresh();
    const h1 = addPr(db, 1), h2 = addPr(db, 2);
    const d = fake({ 1: open(sha(1, "b")), 2: { head: h2, state: "CLOSED" } });
    const s = await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    assert.equal(d.calls.length, 0);
    assert.deepEqual(s.skipped.map((x) => x.ref), ["app#1", "app#2"]);
    assert.equal(h1.length, 40);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM review_posts").get() as { n: number }).n, 0);
  });

  test("a skip-listed head, own PRs and batch PRs are not candidates", () => {
    const db = fresh();
    addPr(db, 1, { verdict: null });
    addPr(db, 2, { author: "bot" });
    addPr(db, 3);
    addPr(db, 4, { author: "someone" });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
    db.prepare(`INSERT INTO merge_batches (repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at) VALUES ('app', 'integration-app-1', 'open', 'a', 'b', 4, ?, ?)`).run(T0, T0);
    addPr(db, 5, { author: "contrib" });
    assert.deepEqual(postCandidates(db, "app").map((c) => c.number), [3, 5]);
  });

  test("a review at a new head edits the stored review", async () => {
    const db = fresh();
    const h1 = addPr(db, 1);
    const d = fake({ 1: open(h1) });
    await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    const h2 = sha(1, "c");
    db.prepare("UPDATE items SET head_oid = ?, updated_at = '2026-01-05T00:00:00Z' WHERE number = 1").run(h2);
    saveOpus(db, "app", 1, h2, { verdict: "hold", reason: "Now broken." });
    d.live.set(1, open(h2));
    const s = await runReviewPost(db, { repo: "app", dryRun: false }, quiet, d);
    assert.deepEqual(s.edited, ["app#1"]);
    assert.deepEqual(d.calls.map((c) => c.kind), ["add", "edit"]);
    assert.equal(d.calls[1]!.vars.id, "R_PR_1");
    assert.match(String(d.calls[1]!.vars.body), /Changes needed:[\s\S]*Reviewed at 1111111\./);
    assert.deepEqual((db.prepare("SELECT review_id, head_oid FROM review_posts").all() as object[]).map((r) => ({ ...r })), [{ review_id: "R_PR_1", head_oid: h2 }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'review-edit'").get() as { n: number }).n, 1);
  });

  test("the limit and the daily limit count posts", async () => {
    const db = fresh();
    const heads = [1, 2, 3].map((n) => addPr(db, n));
    const d = fake({ 1: open(heads[0]!), 2: open(heads[1]!), 3: open(heads[2]!) });
    let handled = 0;
    const s = await runReviewPost(db, { repo: "app", dryRun: false, limit: 2, onHandled: (n) => (handled = n) }, quiet, d);
    assert.equal(s.posted.length, 2);
    assert.equal(handled, 2);
    assert.equal(pauseReason(db, "review-post"), null);
    db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, items) VALUES ('review-post', '{}', 'pipeline', ?, 'done', ?, 40)")
      .run(new Date().toISOString(), new Date().toISOString());
    assert.match(pauseReason(db, "review-post") ?? "", /daily limit of 40/);
  });

  test("the pilot limits the candidates", () => {
    const db = fresh();
    addPr(db, 1);
    addPr(db, 2);
    db.prepare("INSERT INTO settings (key, value) VALUES ('pilot_items', '[\"app#2\"]')").run();
    assert.deepEqual(postCandidates(db, "app").map((c) => c.number), [2]);
  });
});
