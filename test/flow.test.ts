// The flowchart counts (GET /api/flow) and the Items browser's flow filter, on a
// small database with one item for each branch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FlowNode } from "../web/src/api/types.ts";
import { connect } from "../src/db.ts";
import { buildFlow } from "../src/flow/shape.ts";
import { readSummary, refreshSummary } from "../src/flow/summary.ts";
import { listItems } from "../src/dash/api/items.ts";
import type { Req } from "../src/dash/types.ts";
import { scopeToTracked } from "../src/repos.ts";
import { candidateRefs, selectCandidates } from "../src/review/candidates.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const R = "photocraft";
const T0 = "2026-01-01T00:00:00Z";
const NOW = new Date().toISOString();

function build() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "flow-test-")), "f.db"));
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
  db.prepare(`INSERT INTO stages (repo, number, stage, at) VALUES ('${R}', 1, 'labeled', ?)`).run(NOW);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('labels_approved:${R}', '{"by":"op","at":"${T0}"}')`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('merge_approved:${R}', '{"by":"op","at":"${T0}"}')`).run();
  db.prepare(`INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', '${T0}')`).run();
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  scopeToTracked(db);
  return db;
}

const flowOf = (db: ReturnType<typeof build>, repo: string | null) =>
  buildFlow(readSummary(db, repo).counts, { repo, now: NOW, lastSync: null, run: null, countedAt: null, uncounted: 0, steps: [] });
const counts = (n: FlowNode) => Object.fromEntries(n.branches.map((b) => [b.id, b.count]));

test("a repo not approved for merging moves its ready PRs out of 'May merge now'", () => {
  const db = build();
  db.prepare("DELETE FROM settings WHERE key LIKE 'merge_approved:%'").run();
  refreshSummary(db);
  const merge = flowOf(db, null).nodes.find((n) => n.id === "merge")!;
  assert.deepEqual([counts(merge).eligible, counts(merge).unapproved], [0, 1]);
});

test("flowchart counts every branch by the stages' own rules", () => {
  const db = build();
  const flow = flowOf(db, null);
  const node = (id: string) => flow.nodes.find((n) => n.id === id)!;
  assert.deepEqual(counts(node("synced")), { issues: 6, prs: 5 });
  assert.deepEqual(counts(node("classify")), { settled: 8, waiting: 1, disagree: 1, unclassified: 1 });
  assert.deepEqual(counts(node("decide")), { "not-asked": 1, open: 1, take: 1, "small-extra": 0, plugin: 1, close: 0, "need-info": 0 });
  assert.deepEqual(counts(node("review")), { "not-reviewed": 1, take: 2, "take-fix": 1, hold: 1, close: 0 });
  assert.deepEqual(counts(node("merge")), { eligible: 1, unapproved: 0, "needs-decision": 0, "waiting-ci": 0, "ci-failed": 1, conflict: 0, "needs-fix-up": 1, declined: 0, merged: 1 });
  assert.deepEqual(counts(node("labels")), { labelled: 1, pending: 7, unapproved: 0 });
  assert.deepEqual(node("verify").branches.map((b) => b.count), [null, null]);
  assert.deepEqual(node("decide").waitsOn.sort(), ["model", "person"]);
  const edge = (from: string, to: string) => flow.edges.find((e) => e.from === from && e.to === to)!.count;
  assert.equal(edge("decide", "review"), 1);
  assert.equal(edge("classify", "review"), 4);
  assert.equal(edge("review", "verify"), 3);
  assert.deepEqual(node("review").recent, [{ label: "reviewed", count: 1 }]);

  // The batched candidate rule matches the Review stage's own.
  assert.deepEqual([...candidateRefs(db)], selectCandidates(db, R).map((c) => `${c.repo}#${c.number}`));

  // A repo filter that matches nothing empties every count.
  const other = flowOf(db, "pdfcraft");
  assert.ok(other.nodes.every((n) => n.branches.every((b) => !b.count)));

  // The Items browser's flow filter lists exactly a branch's items.
  const req = (qs: string) => ({ query: new URLSearchParams(qs) }) as unknown as Req;
  assert.deepEqual(listItems(db, req("flow=review.take")).rows.map((r) => r.number).sort((a, b) => a - b), [11, 14]);
  assert.deepEqual(listItems(db, req("flow=decide.not-asked")).rows.map((r) => r.number), [3]);
  assert.throws(() => listItems(db, req("flow=classify.nope")), /flow/);

  // The summary row notices an answer and is counted again on the next refresh.
  refreshSummary(db);
  db.prepare("UPDATE main.decisions SET answer = 'close', answered_by = 'op', answered_at = ? WHERE id = ?").run(NOW, `${R}#5:scope`);
  assert.equal(counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).open, 1);
  assert.deepEqual(refreshSummary(db), [R]);
  assert.deepEqual([counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).open, counts(flowOf(db, R).nodes.find((n) => n.id === "decide")!).close], [0, 1]);
  assert.deepEqual(refreshSummary(db), []);
});
