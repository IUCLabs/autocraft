// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable.

/** The organization whose repositories the pipeline tracks. */
export const BASE_ORG = "storytold";

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${BASE_ORG}/${repo}`.toLowerCase();
}

/** A PR is pushable when its head is in the base repository or maintainers may modify it. */
export function pushable(headRepo: string | null | undefined, repo: string, canModify: boolean | number | null | undefined): boolean {
  return !!canModify || sameRepo(headRepo, repo);
}
