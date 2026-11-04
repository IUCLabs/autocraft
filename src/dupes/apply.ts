// Applies the operator's duplicate answers the Plans list (action dupe-answer), for one repo or all.
import type { DatabaseSync } from "node:sqlite";
import { plannedItems } from "../core/select-items.ts";
import { applyDuplicateAnswers } from "./decide.ts";

export function applyPlannedAnswers(db: DatabaseSync, at: string, repo?: string, model?: string): number {
  const ids = new Set(plannedItems(db, "dupe-answer", { repo, model }).flatMap((p) => p.facts.dupeAnswers));
  return ids.size ? applyDuplicateAnswers(db, at, ids) : 0;
}
