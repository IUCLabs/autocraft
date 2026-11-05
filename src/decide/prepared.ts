// When an open decision counts as prepared. Only items in scope (pipeline on for the repo, not our own integration PR) are prepared.
import type { DatabaseSync } from "node:sqlite";
import { pilotSql } from "../pilot.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { RECOMMEND_MAX_FAILURES, RECOMMEND_RETRY_MS } from "../core/item-rules.ts";

/** The columns of a decision that say what its prepare step did. */
export type PrepareColumns = {
  prepared_at: string | null; prepared_head: string | null;
  recommend_failures: number | null; recommend_failed_at: string | null; prepare_failed_head: string | null;
};

/** A prepare covers the decision's current state: it ran, and for a PR at the head the PR has now. */
export const isPrepared = (d: PrepareColumns, head: string | null): boolean => d.prepared_at !== null && (d.prepared_head ?? null) === (head ?? null);

/** Failed tries at the current head; a new head starts again. */
const triesAt = (d: PrepareColumns, head: string | null): number => ((d.prepare_failed_head ?? null) === (head ?? null) ? d.recommend_failures ?? 0 : 0);

/** The decision is open, has no prepare for its current state and has tries left. */
export const isPreparing = (d: PrepareColumns, head: string | null): boolean => !isPrepared(d, head) && triesAt(d, head) < RECOMMEND_MAX_FAILURES;

/** Preparing, and the wait after the last failed try is over. */
export const prepareDue = (d: PrepareColumns, head: string | null, nowMs: number): boolean =>
  isPreparing(d, head) && (triesAt(d, head) === 0 || d.recommend_failed_at === null || Date.parse(d.recommend_failed_at) < nowMs - RECOMMEND_RETRY_MS);

/** Whether the decision is open and waits for its prepare (the dashboard's `preparing`). */
/**
 * The decision is still about something open: its item, or for a duplicate group (whose item is the kept one, often
 * already closed or merged) any member it would close.
 */
export const openSubjectSql = (d: string, i: string): string => `(${i}.state = 'OPEN' OR (${d}.id LIKE '%:dupegroup:%' AND EXISTS (SELECT 1 FROM dupe_group_items gi
  JOIN items m ON m.repo = ${d}.repo AND m.number = gi.number WHERE gi.decision_id = ${d}.id AND gi.role = 'close' AND m.state = 'OPEN')))`;

export function preparing(db: DatabaseSync, d: Partial<PrepareColumns> & { id: string; answer: string | null; repo: string | null; number: number | null }): boolean {
  if (d.answer !== null || d.number === null) return false;
  const it = db.prepare(`SELECT i.kind, i.head_oid FROM decisions d JOIN items i ON i.repo = d.repo AND i.number = d.number
    WHERE d.id = ? AND ${openSubjectSql("d", "i")} AND ${pilotSql("i")} AND ${notOwnIntegrationSql("i")}`).get(d.id) as { kind: string; head_oid: string | null } | undefined;
  if (!it) return false;
  return isPreparing({ prepared_at: d.prepared_at ?? null, prepared_head: d.prepared_head ?? null, prepare_failed_head: d.prepare_failed_head ?? null, recommend_failures: d.recommend_failures ?? null, recommend_failed_at: d.recommend_failed_at ?? null }, it.kind === "pr" ? it.head_oid : null);
}
