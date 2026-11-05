import type { DatabaseSync } from "node:sqlite";
import type { Step } from "../conversations/cards.ts";

const ALL: Step["kind"][] = ["comment", "label", "unlabel", "close", "duplicate", "reopen", "open_issue", "transfer", "assign", "request_reviewers", "review", "fixup"];

/** The step kinds that apply to the item. TODO: replaced by the `applicableSteps` export of src/conversations/cards.ts at merge; until then every kind is listed. */
export function applicableSteps(_db: DatabaseSync, _repo: string, _n: number): string[] {
  return [...ALL];
}
