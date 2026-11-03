// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable, unless the
// branch is a long-lived one (the default branch, another PR's base, a release branch).
import type { DatabaseSync } from "node:sqlite";

/** The organization whose repositories the pipeline tracks. */
export const BASE_ORG = "storytold";

/** Branch names that are long-lived whatever the repository says. */
const LONG_LIVED = /^(release|main|master|develop|stable|hotfix|integration)([/._-].*)?$/i;

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${BASE_ORG}/${repo}`.toLowerCase();
}

export type LongLived = (branch: string) => boolean;

/** Decides whether a branch of `repo` is long-lived: its default branch, the base of an open PR, or a release-like name. */
export function longLivedOf(db: DatabaseSync, repo: string): LongLived {
  const names = new Set<string>();
  const d = (db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch;
  if (d) names.add(d);
  for (const r of db.prepare("SELECT DISTINCT base_ref FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN' AND base_ref IS NOT NULL").all(repo) as { base_ref: string }[]) names.add(r.base_ref);
  return (branch) => names.has(branch) || LONG_LIVED.test(branch);
}

/**
 * A PR is pushable when its head is in the base repository (on a branch that isn't long-lived) or maintainers may
 * modify it. `branch` is the head branch name; a same-repo head without one is not pushable.
 */
export function pushable(headRepo: string | null | undefined, repo: string, canModify: boolean | number | null | undefined, branch: string | null | undefined, longLived: LongLived = (b) => LONG_LIVED.test(b)): boolean {
  if (sameRepo(headRepo, repo)) return !!branch && !longLived(branch);
  return !!canModify;
}
