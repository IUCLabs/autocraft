// When an open decision counts as prepared. Only items in scope (pipeline on for the repo, not our own integration PR) are prepared.
import type { DatabaseSync } from "node:sqlite";
import { pilotSql } from "../pilot.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { RECOMMEND_MAX_FAILURES, RECOMMEND_RETRY_MS } from "../core/item-rules.ts";

/** The columns of a decision that say what its prepare step did. */
export type PrepareColumns = {
  prepared_at: string | null; prepared_head: string | null;
  recommend_failures: number | null; recommend_failed_at: string | null; prepare_failed_head: string | null;
  /** Without `kind` a prepare is tied to the head, as a Merge? decision's is. */
  kind?: string; id?: string;
  /** Newest counted comment or operator message on the item (`discussedAtSql`). */
  discussed_at?: string | null;
  /** Set by an operator's Re-prepare; such a prepare is exempt from the daily cap. */
  prepare_requested_at?: string | null;
  /** Automatic prepares of this decision since UTC midnight. */
  prepares_today?: number;
};

/** Automatic prepares per decision per UTC day; an operator's Re-prepare is exempt. */
export const PREPARE_DAILY_CAP = 3;

/** SQL for the newest counted comment (src/review/discussion.ts isCounted, stored as `comments.counted`) or operator message of decision alias `d`'s item. */
export const discussedAtSql = (d: string): string => `(SELECT max(m) FROM (
  SELECT max(c.created_at) AS m FROM comments c WHERE c.repo = ${d}.repo AND c.number = ${d}.number AND c.counted = 1
  UNION ALL SELECT max(t.at) FROM conversation_turns t WHERE t.repo = ${d}.repo AND t.number = ${d}.number AND t.kind = 'operator'))`;

/** SQL for the automatic prepares of decision alias `d` since the UTC day start bound to `?`. */
export const preparesTodaySql = (d: string): string => `(SELECT count(*) FROM decision_prepares p WHERE p.decision_id = ${d}.id AND p.manual = 0 AND p.at >= ?)`;

export const utcDayStart = (nowMs: number): string => `${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * A prepare covers the decision's current state. A Merge? decision (or one of unknown kind) is tied to the PR head it was prepared for.
 * Any other kind stays prepared across head pushes until the discussion changes; a change of the decision itself or an operator's
 * Re-prepare clears `prepared_at`.
 */
export const isPrepared = (d: PrepareColumns, head: string | null): boolean => {
  if (d.prepared_at === null) return false;
  if (d.kind === undefined || d.kind === "merge") return (d.prepared_head ?? null) === (head ?? null);
  return !(d.discussed_at && d.discussed_at > d.prepared_at);
};

/** Failed tries at the current head; a new head starts again. */
const triesAt = (d: PrepareColumns, head: string | null): number => ((d.prepare_failed_head ?? null) === (head ?? null) ? d.recommend_failures ?? 0 : 0);

/** The decision is open, has no prepare for its current state and has tries left. */
export const isPreparing = (d: PrepareColumns, head: string | null): boolean => !isPrepared(d, head) && triesAt(d, head) < RECOMMEND_MAX_FAILURES;

/** Preparing, and the wait after the last failed try is over. */
export const prepareDue = (d: PrepareColumns, head: string | null, nowMs: number): boolean => {
  // A Merge? decision for an older head is about to be withdrawn.
  const at = d.kind === "merge" ? d.id?.indexOf(":merge@") ?? -1 : -1;
  if (at >= 0 && d.id!.slice(at + ":merge@".length) !== head) return false;
  if (!d.prepare_requested_at && (d.prepares_today ?? 0) >= PREPARE_DAILY_CAP) return false;
  return isPreparing(d, head) && (triesAt(d, head) === 0 || d.recommend_failed_at === null || Date.parse(d.recommend_failed_at) < nowMs - RECOMMEND_RETRY_MS);
};

/** Whether the decision is open and waits for its prepare (the dashboard's `preparing`). */
/**
 * The decision is still about something open: its item, or for a duplicate group (whose item is the kept one, often
 * already closed or merged) any member it would close.
 */
export const openSubjectSql = (d: string, i: string): string => `(${i}.state = 'OPEN' OR (${d}.id LIKE '%:dupegroup:%' AND EXISTS (SELECT 1 FROM dupe_group_items gi
  JOIN items m ON m.repo = ${d}.repo AND m.number = gi.number WHERE gi.decision_id = ${d}.id AND gi.role = 'close' AND m.state = 'OPEN')))`;

export function preparing(db: DatabaseSync, d: Partial<PrepareColumns> & { id: string; answer: string | null; repo: string | null; number: number | null }): boolean {
  if (d.answer !== null || d.number === null) return false;
  const it = db.prepare(`SELECT i.kind, i.head_oid, d.kind AS dkind, ${discussedAtSql("d")} AS discussed_at FROM decisions d JOIN items i ON i.repo = d.repo AND i.number = d.number
    WHERE d.id = ? AND ${openSubjectSql("d", "i")} AND ${pilotSql("i")} AND ${notOwnIntegrationSql("i")}`).get(d.id) as { kind: string; head_oid: string | null; dkind: string; discussed_at: string | null } | undefined;
  if (!it) return false;
  return isPreparing({ prepared_at: d.prepared_at ?? null, prepared_head: d.prepared_head ?? null, prepare_failed_head: d.prepare_failed_head ?? null, recommend_failures: d.recommend_failures ?? null, recommend_failed_at: d.recommend_failed_at ?? null, kind: it.dkind, discussed_at: it.discussed_at }, it.kind === "pr" ? it.head_oid : null);
}
