// The flowchart counts (GET /api/flow) and the Items browser's flow filter, on a
// small database with one item for each branch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FlowNode } from "../web/src/api/types.ts";
import { connect } from "../src/db.ts";
import { buildFlow } from "../src/flow/shape.ts";
import { readSummary, refreshSummary } from "../src/flow/summary.ts";
import { listItems } from "../src/dash/api/items.ts";
import { queue } from "../src/dash/api/queue.ts";
import type { Req } from "../src/dash/types.ts";
import { scopeToTracked } from "../src/repos.ts";
import { candidateRefs, selectCandidates } from "../src/review/candidates.ts";
import { finalizeReviews } from "./fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const R = "photocraft";
const T0 = "2026-01-01T00:00:00Z";
const NOW = new Date().toISOString();

function build() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "flow-test-")), "f.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
  // Only the test repo: counting stops after a time budget, so the seeded list would leave it uncounted on a loaded machine.
  db.prepare(`DELETE FROM tracked_repos WHERE name != '${R}'`).run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('${R}', ?, ?, ?, ?, 'regular', 10, 0, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('${R}', ?, 'jev', 'r1', '${T0}', ?, ?, ?)`);
  const haiku = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('${R}', ?, 'haiku', 'r1', '${T0}', ?, '[]')`);
  const sure = (n: number, label: string, flags: string[] = []) => jev.run(n, label, JSON.stringify(flags), '{"top":0.95}');
  const unsure = (n: number, label: string) => jev.run(n, label, "[]", '{"top":0.5}');
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES ('${R}', ?, ?, 'rv', ?, 'sonnet', 'S', ?, 'why')`);
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('${R}', ?, ?, 'OPEN', 0, ?, '[]', 'MERGEABLE', 1, '2026-01-02T00:00:00Z')`);
  const scope = db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at)
    VALUES (?, 'scope', '${R}', ?, 'In scope?', '[]', '${T0}', ?, ?, ?)`);

  item.run(1, "issue", "OPEN", "settled bugfix", null); sure(1, "bugfix");
  item.run(2, "issue", "OPEN", "waiting", null); unsure(2, "bugfix");
  item.run(3, "issue", "OPEN", "scope disagreement", null); unsure(3, "small extra"); haiku.run(3, "plugin candidate");
  item.run(4, "issue", "OPEN", "not classified", null);
  item.run(5, "issue", "OPEN", "open decision", null); sure(5, "missing feature", ["needs decision"]); scope.run(`${R}#5:scope`, 5, null, null, null);
  item.run(6, "issue", "OPEN", "answered plugin", null); sure(6, "missing feature", ["needs decision"]); scope.run(`${R}#6:scope`, 6, "plugin", "op", NOW);
  item.run(10, "pr", "OPEN", "not reviewed", "h10"); sure(10, "bugfix");
  item.run(11, "pr", "OPEN", "take, green", "h11"); sure(11, "bugfix"); review.run(11, "h11", NOW, "take"); checks.run(11, "h11", "success");
  item.run(12, "pr", "OPEN", "hold", "h12"); sure(12, "bugfix"); review.run(12, "h12", T0, "hold");
  item.run(13, "pr", "OPEN", "wanted, take-fix", "h13"); sure(13, "missing feature", ["needs decision"]); scope.run(`${R}#13:scope`, 13, "take", "op", T0);
  review.run(13, "h13", T0, "take-fix");
  item.run(14, "pr", "OPEN", "take, CI fails", "h14"); sure(14, "bugfix"); review.run(14, "h14", T0, "take"); checks.run(14, "h14", "failure");
  item.run(15, "pr", "MERGED", "merged by us", "h15"); sure(15, "bugfix"); review.run(15, "h15", T0, "take");
  db.prepare(`INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome) VALUES ('${R}', 15, 'h15', 'm1', ?, 'rule', 'squash', 'merged')`).run(NOW);
  db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at, finished_at) VALUES ('${R}', 11, 'h11', 'tests', 'r', 'passed', '${T0}', ?)`).run(NOW);
  db.prepare(`INSERT INTO stages (repo, number, stage, at) VALUES ('${R}', 1, 'labeled', ?)`).run(NOW);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('labels_approved:${R}', '{"by":"op","at":"${T0}"}')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('merge_approved:${R}', '{"by":"op","at":"${T0}"}')`).run();
  db.prepare(`INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', '${T0}')`).run();
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  scopeToTracked(db);
  finalizeReviews(db);
  return db;
}

const flowOf = (db: ReturnType<typeof build>, repo: string | null) =>
  buildFlow(readSummary(db, repo).counts, { repo, now: NOW, lastSync: null, run: null, countedAt: null, uncounted: 0, steps: [] });
const counts = (n: FlowNode) => Object.fromEntries(n.branches.map((b) => [b.id, b.count]));

test("a repo not approved for merging moves its ready PRs out of 'May merge now'", async () => {
  const db = build();
  db.prepare("DELETE FROM settings WHERE key LIKE 'merge_approved:%'").run();
  refreshSummary(db);
  const merge = flowOf(db, null).nodes.find((n) => n.id === "merge")!;
  assert.deepEqual([counts(merge).eligible, counts(merge).unapproved], [0, 1]);
});

test("a take or take-fix without an Opus review counts as waiting for Opus, not under its verdict", async () => {
  const db = build();
  db.prepare("DELETE FROM opus_reviews WHERE number IN (13, 14)").run();
  refreshSummary(db);
  const review = flowOf(db, null).nodes.find((n) => n.id === "review")!;
  assert.deepEqual(counts(review), { "not-reviewed": 1, "waiting-opus": 2, take: 1, "take-fix": 0, hold: 1, close: 0 });
});

test("flowchart counts every branch by the stages' own rules", async () => {
  const db = build();
  const flow = flowOf(db, null);
  const node = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.deepEqual(counts(node("synced")), { issues: 6, prs: 5 });
  assert.deepEqual(counts(node("classify")), { settled: 8, waiting: 1, referee: 0, disagree: 1, unclassified: 1 });
  assert.deepEqual(counts(node("decide")), { "not-asked": 1, open: 1, take: 1, "small-extra": 0, plugin: 1, close: 0, "need-info": 0, backlog: 0 });
  assert.deepEqual(counts(node("review")), { "not-reviewed": 1, "waiting-opus": 0, take: 2, "take-fix": 1, hold: 1, close: 0 });
  assert.deepEqual(counts(node("merge")), { eligible: 1, "in-batch": 0, unapproved: 0, "needs-decision": 0, "waiting-ci": 0, "ci-approval": 0, "ci-approval-person": 0, "ci-failed": 1, conflict: 0, "waiting-verify": 0, "verify-failed": 0, "verify-error": 0, "needs-fix-up": 1, "batch-failed": 0, declined: 0, merged: 1 });
  assert.deepEqual(counts(node("verify")), { waiting: 0, planned: 0, running: 0, passed: 1, "ci-enough": 0, failed: 0, error: 0 });
  assert.equal(node("verify").total, 1);
  assert.deepEqual(node("verify").recent, [{ label: "finished", count: 1 }]);
  assert.deepEqual(counts(node("labels")), { labelled: 1, pending: 7, unapproved: 0 });
  assert.deepEqual(node("decide").waitsOn.sort(), ["model", "person"]);
  const edge = (from: string, to: string) => flow.edges.find((e) => e.from === from && e.to === to)!.count;
  assert.equal(edge("labels", "review"), 5);
  assert.equal(edge("decide", "labels"), 8);
  assert.equal(edge("review", "verify"), 2);
  assert.equal(edge("review", "fixup"), 1);
  assert.equal(edge("verify", "merge"), 1);
  assert.deepEqual(node("review").recent, [{ label: "reviewed", count: 1 }]);

  // The batched candidate rule matches the Review stage's own.
  assert.deepEqual([...candidateRefs(db)], selectCandidates(db, R).map((c) => `${c.repo}#${c.number}`));

  // A repo filter that matches nothing empties every count.
  const other = flowOf(db, "pdfcraft");
  assert.ok(other.nodes.every((n) => n.branches.every((b) => !b.count)));

  // The Items browser's flow filter lists exactly a branch's items.
  const req = (qs: string) => ({ query: new URLSearchParams(qs), user: { login: "op", role: "operator" } }) as unknown as Req;
  assert.deepEqual((await listItems(db, req("flow=review.take"))).rows.map((r) => r.number).sort((a, b) => a - b), [11, 14]);
  assert.deepEqual((await listItems(db, req("flow=decide.not-asked"))).rows.map((r) => r.number), [3]);
  await assert.rejects(async () => listItems(db, req("flow=classify.nope")), /flow/);

  // The summary row notices an answer and is counted again on the next refresh.
  refreshSummary(db);
  db.prepare("UPDATE main.decisions SET answer = 'close', answered_by = 'op', answered_at = ? WHERE id = ?").run(NOW, `${R}#5:scope`);
  assert.equal(counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).open, 1);
  assert.deepEqual(refreshSummary(db), [R]);
  assert.deepEqual([counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).open, counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).close], [0, 1]);
  assert.deepEqual(refreshSummary(db), []);
});

test("verify counts follow the verification at the PR's current head", () => {
  const db = build();
  const ins = db.prepare(`INSERT OR REPLACE INTO verifications (repo, number, head_sha, kind, reason, state, created_at, finished_at) VALUES ('${R}', ?, ?, 'tests', 'r', ?, '${T0}', ?)`);
  ins.run(14, "h14", "failed", NOW);
  ins.run(12, "h12", "running", null);
  ins.run(10, "old10", "error", NOW); // an older head does not count
  ins.run(13, "h13", "stale", NOW);
  refreshSummary(db);
  const flow = flowOf(db, null);
  const node = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.deepEqual(counts(node("verify")), { waiting: 0, planned: 0, running: 1, passed: 1, "ci-enough": 0, failed: 1, error: 0 });
  assert.equal(node("verify").total, 3);
  assert.equal(counts(node("merge"))["verify-failed"], 0); // #14 is blocked by CI first
  db.prepare("UPDATE verifications SET state = 'planned' WHERE number = 11").run();
  refreshSummary(db);
  const merge = flowOf(db, null).nodes.find((n) => n.id === "merge")!;
  assert.deepEqual([counts(merge)["waiting-verify"], counts(merge).eligible], [1, 0]);
});

test("the duplicate, priority, fix, fix-up and act nodes count one item in each state", async () => {
  const db = build();
  const item = db.prepare(`INSERT INTO main.items (repo, number, kind, state, title, author, head_oid, embed_hash, created_at, updated_at) VALUES ('${R}', ?, ?, ?, 't', 'regular', ?, ?, '${T0}', '${T0}')`);
  const dec = db.prepare(`INSERT INTO main.decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at, applied_at) VALUES (?, ?, '${R}', ?, 'q', '[]', '${T0}', ?, ?, ?, ?)`);
  const setting = (k: string) => db.prepare("INSERT OR REPLACE INTO main.settings (key, value) VALUES (?, '{\"by\":\"op\",\"at\":\"x\"}')").run(k);
  // Counted afresh on every call: the stored summary would otherwise show the first count.
  const node = (id: string) => { db.prepare("DELETE FROM main.flow_summary").run(); return flowOf(db, null).nodes.find((n) => n.id === id)!; };

  // Duplicates: 20 and 21 sit in an unjudged pair, 22 has an open decision, 24 was answered close, 25 is closed after that.
  for (const n of [20, 21, 22, 24]) item.run(n, "issue", "OPEN", null, `e${n}`);
  item.run(25, "issue", "CLOSED", null, "e25");
  db.prepare(`INSERT INTO main.duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at) VALUES ('${R}', 20, 21, 'e20', 'e21', 0.9, '${T0}')`).run();
  dec.run(`${R}#22:duplicate@20`, "duplicate", 22, null, null, null, null);
  dec.run(`${R}#24:duplicate@20`, "duplicate", 24, "close", "op", NOW, null);
  dec.run(`${R}#25:duplicate@20`, "duplicate", 25, "close", "op", NOW, NOW);

  // Priority: 20 scored, 21 waiting for a second opinion, 22 not scored. Rank gives the top work score.
  const prio = db.prepare(`INSERT INTO main.item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('${R}', ?, ?, 'high', 50, ?, '${T0}')`);
  prio.run(20, "e20", "jev"); prio.run(21, "e21", "jev-unsure");
  db.prepare(`INSERT INTO main.item_rank (repo, number, score, breakdown, computed_at) VALUES ('${R}', 20, 30277, '{}', '${T0}')`).run();

  // Fix: issue 1 is a candidate (settled bugfix, no attempt) once the repo is public; 31 to 34 have attempts.
  db.prepare(`INSERT INTO main.repos (name, visibility) VALUES ('${R}', 'public')`).run();
  const attempt = db.prepare(`INSERT INTO main.fix_attempts (repo, number, main_sha, text_hash, state, created_at, updated_at) VALUES ('${R}', ?, 'm', 'h', ?, '${T0}', '${T0}')`);
  for (const [n, st] of [[31, "testing"], [32, "skipped"], [33, "pr-opened"], [34, "retry"]] as const) { item.run(n, "issue", "OPEN", null, null); attempt.run(n, st); }
  assert.deepEqual(counts(node("fix")), { candidates: 0, retry: 1, testing: 1, passed: 0, "pr-opened": 1, skipped: 1, failed: 0, unapproved: 1 });
  setting(`fixissue_approved:${R}`);
  assert.deepEqual(counts(node("fix")), { candidates: 1, retry: 1, testing: 1, passed: 0, "pr-opened": 1, skipped: 1, failed: 0, unapproved: 0 });
  assert.equal(node("fix").branches.find((b) => b.id === "testing")!.waitsOn, "sandbox");

  // Fix-up: 13 can be pushed to, 40 cannot (closed to maintainers), 41 was pushed.
  const checks = db.prepare(`INSERT INTO main.pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('${R}', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', ?, '2026-01-02T00:00:00Z')`);
  const review = db.prepare(`INSERT INTO main.reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes) VALUES ('${R}', ?, ?, 'rv', '${T0}', 'sonnet', 'S', ?, 'why', ?)`);
  const fixes = '[{"file":"src/a.rs","change":"rename"}]';
  db.prepare("UPDATE main.reviews SET fixes = ? WHERE number = 13").run(fixes);
  checks.run(13, "h13", 1);
  item.run(40, "pr", "OPEN", "h40", null); review.run(40, "h40", "take-fix", fixes); checks.run(40, "h40", 0);
  item.run(41, "pr", "OPEN", "h41", null); review.run(41, "h41", "take", null); checks.run(41, "h41", 1);
  finalizeReviews(db);
  db.prepare(`INSERT INTO main.fixups (repo, number, from_head, to_head, state, attempt, created_at) VALUES ('${R}', 41, 'g41', 'h41', 'pushed', 1, ?)`).run(NOW);
  assert.deepEqual(counts(node("fixup")), { fix: 0, pushed: 1, hold: 1, unapproved: 1, asked: 0 });
  setting(`push_approved:${R}`);
  assert.deepEqual(counts(node("fixup")), { fix: 1, pushed: 1, hold: 1, unapproved: 0, asked: 0 });

  // Act: scope decision 4 and the duplicate decision 24 are answered close by an operator.
  dec.run(`${R}#4:scope`, "scope", 4, "close", "op", NOW, null);
  db.prepare(`INSERT INTO main.actions (decision_id, repo, number, kind, state, created_at) VALUES ('${R}#25:duplicate@20', '${R}', 25, 'comment-close', 'done', ?)`).run(NOW);
  assert.deepEqual(counts(node("act")), { todo: 0, failed: 0, unapproved: 2, done: 1 });
  setting(`comment_approved:${R}`);
  db.prepare(`INSERT INTO main.actions (decision_id, repo, number, kind, state, created_at) VALUES ('${R}#4:scope', '${R}', 4, 'comment-close', 'failed', ?)`).run(NOW);
  assert.deepEqual(counts(node("act")), { todo: 1, failed: 1, unapproved: 0, done: 1 });

  refreshSummary(db);
  assert.deepEqual(counts(node("dupes")), { checking: 2, waiting: 1, held: 1, closed: 1 });
  assert.deepEqual(counts(node("priority")), { scored: 1, unsure: 1, todo: 2 });
  assert.deepEqual(node("priority").facts[0], { label: "Top level", value: "P1" });
  assert.deepEqual(counts(node("fixup")), { fix: 1, pushed: 1, hold: 1, unapproved: 0, asked: 0 });

  // The Items browser lists a branch's items.
  const req = (qs: string) => ({ query: new URLSearchParams(qs), user: { login: "op", role: "operator" } }) as unknown as Req;
  const numbers = async (flow: string) => (await listItems(db, req(`flow=${flow}`))).rows.map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(await numbers("dupes.checking"), [20, 21]);
  assert.deepEqual(await numbers("fixup.hold"), [40]);
  assert.deepEqual(await numbers("act.failed"), [4]);
});

test("every count that links to a flow filter opens exactly its items", async () => {
  const db = build();
  refreshSummary(db);
  const req = (p: Record<string, string>) => ({ query: new URLSearchParams(p), user: { login: "op", role: "operator" } }) as unknown as Req;
  let linked = 0;
  for (const n of flowOf(db, null).nodes)
    for (const b of n.branches) {
      if (!b.link?.params.flow || b.count === null) continue;
      linked++;
      const rows = b.link.page === "queue" ? (await queue(db, req(b.link.params))).total : (await listItems(db, req(b.link.params))).total;
      assert.equal(rows, b.count, `${n.id}.${b.id}`);
    }
  assert.ok(linked >= 30);
});
