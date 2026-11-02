import type { DatabaseSync } from "node:sqlite";
import type { PriorityInfo } from "../../web/src/api/types.ts";
import type { Impact } from "./score.ts";

/** The badge data for one item, or null before it was rated. */
export function priorityOf(db: DatabaseSync, repo: string, number: number): PriorityInfo | null {
  const r = db.prepare("SELECT impact, score, model, reason FROM item_priority WHERE repo = ? AND number = ?").get(repo, number) as
    { impact: Impact; score: number; model: string; reason: string | null } | undefined;
  return r ? { impact: r.impact, score: r.score, model: r.model, reason: r.reason } : null;
}
