// The Label stage: the plan, the approval gate and apply, with a fake Querier (nothing reaches GitHub).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { applyLabels, BATCH, LabelsError } from "../src/labels/github.ts";
import { setApproval } from "../src/labels/approval.ts";
import { ALL_LABELS } from "../src/labels/set.ts";
import { countPlan, planLabels } from "../src/labels/plan.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "labels-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const RUN = "org-1";
function setup(name: string) {
  const db = connect(join(dir, `${name}.db`));
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, url, labels) VALUES ('app', ?, 'pr', 'OPEN', 't', 'u', ?)");
  const cls = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, ?, ?, '2026-01-01T00:00:00Z', ?, ?, ?)");
  const jev = (n: number, type: string, top: number, flags: string[] = []) => cls.run(n, "jev", RUN, type, JSON.stringify(flags), JSON.stringify({ top }));
  const haiku = (n: number, type: string, flags: string[] = []) => cls.run(n, "haiku", RUN, type, JSON.stringify(flags), null);
  return { db, item, jev, haiku };
}

describe("labels plan", () => {
  test("skips unsettled, conflicting and already-labelled items; adds flags only when settled", () => {
    const { db, item, jev, haiku } = setup("plan");
    item.run(1, "[]"); jev(1, "bugfix", 0.95, ["security"]);              // settled by Jev: bugfix + security
    item.run(2, "[]"); jev(2, "infra", 0.6); haiku(2, "infra");            // settled by agreement
    item.run(3, "[]"); jev(3, "infra", 0.6); haiku(3, "bugfix");           // unsettled
    item.run(4, '["performance"]'); jev(4, "bugfix", 0.99);                // person set another type: conflict
    item.run(5, '["Bugfix","security"]'); jev(5, "bugfix", 0.99, ["security"]); // already there (case-insensitive)
    item.run(6, '["help wanted"]'); jev(6, "small extra", 0.99, ["needs decision"]); // other labels are left alone
    item.run(7, "[]");                                                     // never classified
    const rows = planLabels(db, "app", RUN);
    const by = Object.fromEntries(rows.map((r) => [r.number, r]));
    assert.deepEqual(by[1]!.add, ["bugfix", "security"]);
    assert.deepEqual(by[2]!.add, ["infra"]);
    assert.equal(by[3]!.status, "unsettled");
    assert.equal(by[4]!.status, "conflict");
    assert.deepEqual(by[4]!.add, []);
    assert.equal(by[5]!.status, "already");
    assert.deepEqual(by[6]!.add, ["small extra", "needs decision"]);
    assert.equal(by[7]!.status, "unsettled");
    assert.deepEqual(countPlan(rows), { toAdd: 3, already: 1, unsettled: 2, conflicts: 1 });
  });
});

type Call = { query: string; variables: Record<string, unknown> };
function fakeClient(opts: { failNumber?: number } = {}) {
  const calls: Call[] = [];
  return {
    calls, spent: 0, remaining: 5000 as number | null,
    async query(query: string, variables: Record<string, unknown>) {
      calls.push({ query, variables });
      if (query.includes("label(name:")) {
        const l: Record<string, unknown> = { id: "R1" };
        ALL_LABELS.map((x) => x.name).forEach((n, i) => (l[`l${i}`] = { id: `L-${n}`, name: n }));
        return { repository: l };
      }
      if (query.includes("issueOrPullRequest")) {
        const r: Record<string, unknown> = {};
        for (const m of query.matchAll(/n(\d+): issueOrPullRequest/g)) r[`n${m[1]}`] = { id: `N${m[1]}` };
        return { repository: r };
      }
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/m(\d+): addLabelsToLabelable/g)) {
        const id = variables[`i${m[1]}`] as string;
        out[`m${m[1]}`] = id === `N${opts.failNumber}` ? null : { clientMutationId: null };
      }
      return out;
    },
  };
}

describe("labels apply", () => {
  test("refuses an unapproved repo and writes nothing", async () => {
    const { db, item, jev } = setup("refuse");
    item.run(1, "[]"); jev(1, "bugfix", 0.99);
    const c = fakeClient();
    await assert.rejects(applyLabels(db, c, "app", { runId: RUN, apply: true, wait: async () => {} }), LabelsError);
    assert.equal(c.calls.length, 0);
  });

  test("dry run by default: no calls, no rows", async () => {
    const { db, item, jev } = setup("dry");
    item.run(1, "[]"); jev(1, "bugfix", 0.99);
    const c = fakeClient();
    const r = await applyLabels(db, c, "app", { runId: RUN, apply: false, wait: async () => {} });
    assert.deepEqual([r.dryRun, r.planned, c.calls.length], [true, 1, 0]);
  });

  test("approved: batches mutations, writes stages and one audit row per batch, and resumes", async () => {
    const { db, item, jev } = setup("apply");
    db.exec("INSERT INTO tracked_repos (name) VALUES ('app')");
    const n = BATCH + 3;
    for (let i = 1; i <= n; i++) { item.run(i, "[]"); jev(i, "bugfix", 0.99, i === 1 ? ["security"] : []); }
    setApproval(db, "boss", "app", true);
    const waits: number[] = [];
    const c = fakeClient({ failNumber: 2 });
    const r = await applyLabels(db, c, "app", { runId: RUN, apply: true, wait: async (ms) => void waits.push(ms) });
    assert.deepEqual([r.planned, r.labeled, r.failed, r.batches], [n, n - 1, [2], 2]);
    const mutations = c.calls.filter((x) => x.query.startsWith("mutation"));
    assert.equal(mutations.length, 2);
    assert.equal((mutations[0]!.query.match(/addLabelsToLabelable/g) ?? []).length, BATCH);
    assert.deepEqual(mutations[0]!.variables.l0, ["L-bugfix", "L-security"]);
    assert.ok(waits.some((w) => w > 0), "paced between batches");
    const stages = db.prepare("SELECT number, note FROM stages WHERE stage = 'labeled' ORDER BY number").all() as { number: number; note: string }[];
    assert.equal(stages.length, n - 1);
    assert.equal(stages[0]!.note, "added: bugfix, security");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'labels-apply'").get() as { n: number }).n, 2);

    // second run: only the failed item remains
    const again = fakeClient();
    const r2 = await applyLabels(db, again, "app", { runId: RUN, apply: true, wait: async () => {} });
    assert.deepEqual([r2.planned, r2.labeled], [1, 1]);
  });
});
