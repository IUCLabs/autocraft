// The pilot is a hard boundary for the planner: with a pilot set, no lane proposes a job for another repo,
// and the checks step reads only pilot PRs. Also the reset of a stage's daily count.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";

const { connect } = await import("../src/db.ts");
const { setPilot, pilotRepos } = await import("../src/pilot.ts");
const { detectAutopilot, LANES, planCtx, pauseReason, resetLimitCount, LimitError, usageToday, stageLimits, LIMIT_STEPS } = await import("../src/runner/autopilot.ts");
const { readSeqs } = await import("../src/live.ts");
const { setMergeApproval } = await import("../src/merge/approval.ts");
const { setCommentApproval } = await import("../src/act/approval.ts");
const { setPushApproval } = await import("../src/fixup/approval.ts");
const { setFixIssueApproval } = await import("../src/fixissue/approval.ts");
const { finalizeReviews } = await import("./fixture.ts");
const { refreshChecks } = await import("../src/review/checks.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "scope-test-"));
const db = connect(join(dir, "s.db"));
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = "2026-01-02T00:00:00Z";
db.exec("DELETE FROM tracked_repos");
db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', 'r1')").run();
for (const repo of ["app", "other"]) {
  db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES (?, 'public', 'main')").run(repo);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES (?, 'op', ?)").run(repo, T);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, additions, deletions, head_oid, url, embed_hash, created_at, updated_at)
    VALUES (?, ?, ?, 'OPEN', ?, 'b', 'someone', 20, 0, ?, ?, 'h', ?, ?)`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, 'jev', 'r1', ?, 'bugfix', '[]', '{"top":0.97}')`);
  const haiku = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, 'haiku', 'r1', ?, 'missing feature', '[]', '{}')`);
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES (?, ?, ?, 'rv', ?, 'm', 'S', ?, 'r', ?)`);
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES (?, ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, ?)`);
  const pr = (n: number, verdict: string | null) => {
    item.run(repo, n, "pr", `PR ${n}`, `sha${n}`, `https://github.com/storytold/${repo}/pull/${n}`, T, T);
    jev.run(repo, n, T);
    if (!verdict) return;
    review.run(repo, n, `sha${n}`, T, verdict, verdict === "take-fix" ? '[{"file":"a.rs","change":"x"}]' : null);
    checks.run(repo, n, `sha${n}`, T);
  };
  pr(1, null); pr(2, "take"); pr(3, "close"); pr(4, "take-fix");
  item.run(repo, 5, "issue", "Issue 5", null, `https://github.com/storytold/${repo}/issues/5`, T, T);
  jev.run(repo, 5, T);
  item.run(repo, 6, "issue", "Issue 6", null, `https://github.com/storytold/${repo}/issues/6`, T, T);
  jev.run(repo, 6, T);
  haiku.run(repo, 6, T);
  item.run(repo, 7, "issue", "Issue 7", null, `https://github.com/storytold/${repo}/issues/7`, T, T); // no verdict yet
  setMergeApproval(db, "op", repo, true);
  setCommentApproval(db, "op", repo, true);
  setPushApproval(db, "op", repo, true);
  setFixIssueApproval(db, "op", repo, true);
}
finalizeReviews(db);

const reposOf = (xs: { params: Record<string, unknown>; gate?: { params: Record<string, unknown> } }[]) =>
  xs.flatMap((x) => [x.params.repo, x.gate?.params.repo]).filter((r): r is string => typeof r === "string");

test("with a pilot on one repo, no lane candidate or proposed job touches the other repo", async () => {
  const before = await detectAutopilot(db, { lanes: LANES });
  assert.ok(reposOf(before.proposals).includes("other"), "without a pilot the other repo has work");

  setPilot(db, "tester", ["app"]);
  assert.deepEqual([...pilotRepos(db)!], ["app"]);
  const ctx = planCtx(db);
  assert.deepEqual(ctx.tracked, ["app"]);
  for (const lane of LANES) {
    const repos = reposOf(lane.detect(db, ctx));
    assert.ok(!repos.includes("other"), `lane ${lane.name} offers a job for the other repo`);
  }
  const after = await detectAutopilot(db, { lanes: LANES });
  assert.ok(reposOf(after.proposals).length > 0, "the pilot repo still gets jobs");
  assert.ok(!reposOf(after.proposals).includes("other"));
});

test("the planner drops a job whose repo is outside the pilot and says so", async () => {
  setPilot(db, "tester", ["app#2"]);
  const lanes = [{ name: "stray", steps: ["checks"], detect: () => [{ step: "checks", params: { repo: "other" } }] }];
  const d = await detectAutopilot(db, { lanes });
  assert.deepEqual(d.proposals, []);
  assert.equal(d.status?.checks, "outside the pilot");
  const ok = await detectAutopilot(db, { lanes: [{ ...lanes[0]!, detect: () => [{ step: "checks", params: { repo: "app" } }] }] });
  assert.equal(ok.proposals.length, 1);
});

test("the checks step refreshes only pilot PRs of the repo", async () => {
  setPilot(db, "tester", ["app#2", "other#3"]);
  const asked: string[] = [];
  const querier = { query: async (q: string) => { asked.push(q); return { repository: {} }; } };
  await refreshChecks(db, querier as never, "app");
  assert.ok(asked.length === 1 && /pullRequest\(number: 2\)/.test(asked[0]!) && !/number: 1\b/.test(asked[0]!), asked[0]);
  setPilot(db, "tester", []);
});

// ---- resetting today's count ----------------------------------------------------

const job = (step: string, items: number, startedAt: string) =>
  db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, ended_at, items) VALUES (?, '{}', 'pipeline', ?, 'done', ?, ?, ?)")
    .run(step, startedAt, startedAt, startedAt, items);

test("a reset counts only the jobs that started after it, lifts a reached limit and is audited", async () => {
  const noon = Date.parse("2026-11-03T12:00:00Z");
  db.prepare("INSERT OR REPLACE INTO stage_limits (step, per_day) VALUES ('labels-apply', 10)").run();
  job("labels-apply", 10, "2026-11-03T08:00:00.000Z");
  assert.equal(usageToday(db, "labels-apply", noon), 10);
  assert.match(pauseReason(db, "labels-apply", noon) ?? "", /daily limit of 10 items reached/);

  const seq = readSeqs(db).settings;
  resetLimitCount(db, "labels-apply", "boss");
  assert.ok(readSeqs(db).settings > seq!, "the settings topic moves so the Pipeline page updates");
  const later = Date.now() + 1000;
  assert.equal(usageToday(db, "labels-apply", later), 0, "usage before the reset is not counted");
  assert.equal(pauseReason(db, "labels-apply", later, { backoff: false }), null, "a step at its limit can run again");
  job("labels-apply", 4, new Date(later + 1000).toISOString());
  assert.equal(usageToday(db, "labels-apply", later + 2000), 4);
  assert.equal(usageToday(db, "referee", later), 0);

  const rows = db.prepare("SELECT login, target, details FROM audit WHERE action = 'limit-reset'").all() as { login: string; target: string; details: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.login, "boss");
  assert.equal(rows[0]!.target, "step:labels-apply");
});

test("a reset of all stages covers every limited step; an unknown stage is refused", async () => {
  db.exec("DELETE FROM jobs");
  job("labels-apply", 3, new Date(Date.now() - 50).toISOString());
  assert.deepEqual(resetLimitCount(db, "all", "cli").steps, LIMIT_STEPS);
  assert.throws(() => resetLimitCount(db, "nope", "cli"), LimitError);
  await new Promise((r) => setTimeout(r, 5));
  const l = (await stageLimits(db)).find((x) => x.step === "labels-apply")!;
  assert.equal(l.usedToday, 0);
});
