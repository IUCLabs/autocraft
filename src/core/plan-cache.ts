// The Plan cache: `item_plans` holds what the planner decided for each PR and item at the end of its last pass, for the
// dashboard to read. The planner is its only writer. A pass writes the rows that changed, and deletes the rows of items that
// left the Plans, in one transaction.
import type { DatabaseSync } from "node:sqlite";
import type { PlanSet } from "./plan-set.ts";

export type PlanRow = {
  repo: string; number: number; kind: "pr" | "issue"; head: string | null; state: string; item_state: string | null;
  actions: string; wait: string | null; reasons: string; note: string | null;
};

/** One row per PR or item of the set. A PR with item facts gets both its plans in one row. */
export function planRows(plans: PlanSet): PlanRow[] {
  const prs = new Map(plans.prs.map((p) => [`${p.facts.repo}#${p.facts.number}`, p]));
  const rows: PlanRow[] = [];
  for (const { facts: f, plan: item } of plans.items) {
    const ref = `${f.repo}#${f.number}`;
    const pr = prs.get(ref) ?? null;
    prs.delete(ref);
    const actions = [...item.actions, ...(pr?.plan.actions ?? [])];
    rows.push({
      repo: f.repo, number: f.number, kind: f.kind, head: pr?.facts.head ?? null, state: pr ? pr.plan.state : item.state, item_state: item.state,
      actions: JSON.stringify(actions), wait: actions.length ? null : pr?.plan.wait ?? item.wait, reasons: JSON.stringify(pr?.plan.reasons ?? []), note: pr?.plan.note ?? null,
    });
  }
  // PRs outside the item facts: merged ones with a take review, and PRs of repos that are not tracked.
  for (const { facts: f, plan } of prs.values()) {
    rows.push({ repo: f.repo, number: f.number, kind: "pr", head: f.head, state: plan.state, item_state: null, actions: JSON.stringify(plan.actions), wait: plan.wait, reasons: JSON.stringify(plan.reasons), note: plan.note });
  }
  return rows;
}

const sig = (r: PlanRow): string => JSON.stringify([r.kind, r.head, r.state, r.item_state, r.actions, r.wait, r.reasons, r.note]);

/** Writes the rows that differ from the stored ones and deletes the stored rows with no Plan. Returns the numbers written and deleted. */
export function writePlanCache(db: DatabaseSync, plans: PlanSet, plannedAt: string = new Date().toISOString()): { written: number; deleted: number } {
  const rows = planRows(plans);
  const stored = new Map<string, string>();
  for (const r of db.prepare("SELECT repo, number, kind, head, state, item_state, actions, wait, reasons, note FROM main.item_plans").all() as PlanRow[]) stored.set(`${r.repo}#${r.number}`, sig(r));
  const changed = rows.filter((r) => stored.get(`${r.repo}#${r.number}`) !== sig(r));
  const keep = new Set(rows.map((r) => `${r.repo}#${r.number}`));
  const gone = [...stored.keys()].filter((k) => !keep.has(k));
  if (!changed.length && !gone.length) return { written: 0, deleted: 0 };
  const put = db.prepare(`INSERT INTO main.item_plans (repo, number, kind, head, state, item_state, actions, wait, reasons, note, planned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET kind = excluded.kind, head = excluded.head, state = excluded.state, item_state = excluded.item_state,
      actions = excluded.actions, wait = excluded.wait, reasons = excluded.reasons, note = excluded.note, planned_at = excluded.planned_at`);
  const del = db.prepare("DELETE FROM main.item_plans WHERE repo = ? AND number = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of changed) put.run(r.repo, r.number, r.kind, r.head, r.state, r.item_state, r.actions, r.wait, r.reasons, r.note, plannedAt);
    for (const k of gone) { const i = k.lastIndexOf("#"); del.run(k.slice(0, i), Number(k.slice(i + 1))); }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { written: changed.length, deleted: gone.length };
}
