// Applies the operator's duplicate answers (no GitHub write), for the dupes and act steps. A Plan's dupe-answer action calls for
// the job (pilot items only); once it runs it applies every actionable answer, in or out of the pilot.
import type { DatabaseSync } from "node:sqlite";
import { applyDuplicateAnswers } from "./decide.ts";

export function applyPlannedAnswers(db: DatabaseSync, at: string): number {
  return applyDuplicateAnswers(db, at);
}
