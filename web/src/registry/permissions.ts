import type { User } from "../api/types";
import type { Permission } from "./types";

export function can(user: User, p: Permission): boolean {
  if (p === "viewer") return true;
  if (p === "operator") return user.role === "operator";
  return user.writeRepos.includes(p.slice("write:".length));
}

/**
 * What the user can do with a decision about these repos (docs/dashboard-spec.md,
 * Trust boundary): operators answer, maintainers propose while maintainer
 * writes are on, everyone else reads. GitHub write access is needed on every repo.
 */
export type DecisionAccess = { mode: "answer" } | { mode: "propose" } | { mode: "read"; reason: string };

export function decisionAccess(user: User, repos: string[]): DecisionAccess {
  if (user.role === "viewer") return { mode: "read", reason: "Viewers can read decisions but not answer them." };
  if (user.role === "maintainer" && !user.maintainerWrites)
    return { mode: "read", reason: "Maintainer proposals are off in this deployment; an operator decides." };
  const missing = [...new Set(repos)].filter((r) => !user.writeRepos.includes(r));
  if (missing.length) return { mode: "read", reason: `You don't have write access to ${missing.join(", ")} on GitHub.` };
  return user.role === "operator" ? { mode: "answer" } : { mode: "propose" };
}

export const canComment = (user: User, repo: string) => decisionAccess(user, [repo]).mode !== "read";

export function roleLabel(user: User) {
  if (user.role === "operator") return "Operator";
  if (user.role === "viewer") return "Viewer";
  return user.maintainerWrites ? "Maintainer · proposes" : "Maintainer · read-only";
}
