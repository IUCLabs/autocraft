// The conflict step's candidate shape, tries and per-head bucket (the PRs come from their Plans, fixup/select.ts).
import type { DatabaseSync } from "node:sqlite";
import { BASE_NAME, conflictNote as coreConflictNote } from "../core/rules.ts";

/** Base branch names the merge accepts as a fetch ref. */
export { BASE_NAME };

/** Merge tries per head (pushed, failed, refused or rejected) before the PR is left to a person. */
export const MAX_CONFLICT_TRIES = 2;

export const CONFLICT_STATES = ["pushing", "merged", "failed", "refused", "rejected", "asked", "skipped", "cannot-push", "push-denied", "superseded"] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];
const TRY_STATES: ConflictState[] = ["pushing", "merged", "failed", "refused", "rejected"];

export type ConflictCandidate = {
  repo: string; number: number; head: string; /** The PR's base branch name. */ base: string; title: string;
  /** The final review's reason. */ reason: string; attempt: number; pushable: boolean;
};
/** merge: we will merge the base in; ask: comment once asking the contributor; asked: that comment is posted; held: nothing to do without a person (two tries used, a deterministic skip recorded at this head, or no comment approval for a branch we can't push to); unapproved: pushable but the repo has no push approval; done: merged at this head already. */
export type ConflictBucket = "merge" | "ask" | "asked" | "held" | "unapproved" | "done";

export function conflictTries(db: DatabaseSync, repo: string, number: number, head: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM conflict_merges WHERE repo = ? AND number = ? AND from_head = ? AND state IN (${TRY_STATES.map(() => "?").join(",")})`)
    .get(repo, number, head, ...TRY_STATES) as { n: number }).n;
}

export function conflictBucket(db: DatabaseSync, p: { repo: string; number: number; head: string; pushable: boolean }, approvals: { push: boolean; comment: boolean }): ConflictBucket {
  const has = (state: string) => !!db.prepare("SELECT 1 FROM conflict_merges WHERE repo = ? AND number = ? AND from_head = ? AND state = ?").get(p.repo, p.number, p.head, state);
  if (has("merged")) return "done";
  if (has("skipped") || has("push-denied")) return "held";
  if (!p.pushable || has("cannot-push")) return has("asked") ? "asked" : approvals.comment ? "ask" : "held";
  if (conflictTries(db, p.repo, p.number, p.head) >= MAX_CONFLICT_TRIES) return "held";
  return approvals.push ? "merge" : "unapproved";
}

export const conflictNote = (bucket: ConflictBucket, base: string): string | null => coreConflictNote(bucket, base);
