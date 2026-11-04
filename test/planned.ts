// The items an item step takes from the Plans, as their facts (for tests of the steps' inputs).
import type { DatabaseSync } from "node:sqlite";
import { plannedItems, type PlannedOptions } from "../src/core/select-items.ts";
import type { ActionKind } from "../src/core/plan.ts";

export const dueFacts = (db: DatabaseSync, kind: ActionKind, opts: PlannedOptions = {}) => plannedItems(db, kind, opts).map((p) => p.facts);

import { itemOf } from "../src/core/select-items.ts";

/** Items the scope-decision step would ask about, optionally limited to repos. */
export const decideCandidates = (db: DatabaseSync, run: string, repos?: string[]) =>
  dueFacts(db, "decide", { run, bucket: "new" }).filter((f) => !repos?.length || repos.includes(f.repo));
export const refereeCandidates = (db: DatabaseSync, run: string) => plannedItems(db, "referee", { run }).map((p) => itemOf(db, p.facts.repo, p.facts.number));
/** The Close? questions the act step would ask in a repo. */
export const closeCandidates = (db: DatabaseSync, repo: string) => plannedItems(db, "act", { repo }).filter((p) => p.action.params?.ask).map((p) => p.facts);
/** Whether the dupes step has work (scan, pair check, group to ask, answer to apply). */
export const dupesWork = (db: DatabaseSync, model?: string): boolean => plannedItems(db, "dupes", { model }).length > 0 || plannedItems(db, "dupe-answer", { model }).length > 0;
export const compareWork = (db: DatabaseSync): boolean => plannedItems(db, "dupes-compare").length > 0;
export const scanPending = (db: DatabaseSync, model: string) => plannedItems(db, "dupes", { model }).filter((p) => p.action.params?.scan).map((p) => p.facts);

import { fixIssueApprovalOf } from "../src/fixissue/approval.ts";
import { textHash } from "../src/fixissue/candidates.ts";
/** The issues the fix-issue step triages first in a repo approved for it. */
export const selectIssues = (db: DatabaseSync, repo: string) => !fixIssueApprovalOf(db, repo) ? [] : plannedItems(db, "fixissue", { repo, bucket: "new" }).map((p) => {
  const t = db.prepare("SELECT title, body FROM items WHERE repo = ? AND number = ?").get(repo, p.facts.number) as { title: string | null; body: string | null };
  return { number: p.facts.number, hash: textHash(t.title ?? "", t.body ?? "") };
});
