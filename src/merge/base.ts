// The base branch a review read its diff against, and what may merge into which base.
import type { DatabaseSync } from "node:sqlite";

/** The base branch the review of this head read its diff against; null when none was recorded. */
export function reviewedBaseOf(db: DatabaseSync, repo: string, number: number, head: string): string | null {
  return (db.prepare("SELECT base_ref FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, number, head) as { base_ref: string | null } | undefined)?.base_ref ?? null;
}

export function defaultBranchOf(db: DatabaseSync, repo: string): string | null {
  return (db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch ?? null;
}

/**
 * Why a PR may not merge into its current base, or null: the merge goes into the branch the review read the diff against.
 * A review that recorded none (stored earlier) allows only the default branch.
 */
export function baseRefusal(db: DatabaseSync, repo: string, head: string, number: number, liveBase: string): string | null {
  const reviewed = reviewedBaseOf(db, repo, number, head) ?? defaultBranchOf(db, repo);
  if (!reviewed) return null;
  return liveBase === reviewed ? null : `the base branch is ${liveBase}, but the review read the diff against ${reviewed}`;
}

/** Whether another branch may be merged into a PR: the default branch or the base its review read. */
export function mergeInAllowed(db: DatabaseSync, repo: string, number: number, head: string, branch: string): boolean {
  return branch === defaultBranchOf(db, repo) || branch === reviewedBaseOf(db, repo, number, head);
}
