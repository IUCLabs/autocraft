// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable, unless the
// branch is a long-lived one (the default branch, another PR's base, a release branch).
import type { DatabaseSync } from "node:sqlite";
import { slugOf } from "../owners.ts";
import { PIPELINE_LOGIN_KEY } from "../core/rules.ts";

/** Branch names that are long-lived whatever the repository says. */
const TRUSTED = "('OWNER', 'MEMBER', 'COLLABORATOR')";
const LONG_LIVED = /^(release|main|master|develop|stable|hotfix|integration|next|staging|production|beta|trunk|gh-pages)([/._-].*)?$|^v?\d+(\.\d+)*(\.x)?$/i;

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${slugOf(repo)}`.toLowerCase();
}

/**
 * Whether the PR's author can write to the base repository: an owner, member or collaborator, a bot, the pipeline's own account,
 * or a login with a stored write permission. A same-repo head branch is the author's to push to only then; anyone else can
 * open a PR from a branch they cannot write.
 */
export function authorWrites(db: DatabaseSync, repo: string, number: number): boolean {
  const r = db.prepare("SELECT author, author_type, author_association FROM items WHERE repo = ? AND number = ?").get(repo, number) as { author: string | null; author_type: string | null; author_association: string | null } | undefined;
  if (!r?.author) return false;
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(r.author_association ?? "") || r.author_type === "Bot") return true;
  const me = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(PIPELINE_LOGIN_KEY) as { value: string } | undefined)?.value;
  if (me && me.toLowerCase() === r.author.toLowerCase()) return true;
  return !!db.prepare("SELECT 1 FROM main.repo_permissions WHERE login = ? AND repo = ? AND permission IN ('write', 'maintain', 'admin')").get(r.author, repo);
}

export type LongLived = (branch: string) => boolean;

/** Decides whether a branch of `repo` is long-lived: its default branch, the base of any PR, a release-like name, or a head shared by several open PRs. */
export function longLivedOf(db: DatabaseSync, repo: string): LongLived {
  const names = new Set<string>();
  const d = (db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch;
  if (d) names.add(d);
  // Only PRs of people tied to the repository name long-lived branches: an outsider retargeting a PR, or opening a second PR from a branch, cannot make another PR unpushable.
  for (const r of db.prepare(`SELECT DISTINCT base_ref FROM items WHERE repo = ? AND kind = 'pr' AND base_ref IS NOT NULL AND author_association IN ${TRUSTED}`).all(repo) as { base_ref: string }[]) names.add(r.base_ref);
  // A same-repo branch that several open PRs use as their head is shared, not one contributor's.
  for (const r of db.prepare(`SELECT head_ref FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN' AND lower(head_repo) = ? AND head_ref IS NOT NULL AND author_association IN ${TRUSTED} GROUP BY head_ref HAVING COUNT(*) > 1`).all(repo, `${slugOf(repo)}`.toLowerCase()) as { head_ref: string }[]) names.add(r.head_ref);
  return (branch) => names.has(branch) || LONG_LIVED.test(branch);
}

/**
 * A PR is pushable when its head is in the base repository (on a branch that isn't long-lived) or maintainers may
 * modify it. `branch` is the head branch name; a same-repo head without one is not pushable, nor is one whose author cannot write to the repository.
 */
export function pushable(headRepo: string | null | undefined, repo: string, canModify: boolean | number | null | undefined, branch: string | null | undefined, longLived: LongLived = (b) => LONG_LIVED.test(b), protectedBranch = false, authorCanWrite = false): boolean {
  if (sameRepo(headRepo, repo)) return authorCanWrite && !!branch && !protectedBranch && !longLived(branch);
  return !!canModify;
}
