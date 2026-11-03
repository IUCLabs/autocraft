import type { User } from "../api/types";
import type { Permission } from "./types";

export function can(user: User, p: Permission): boolean {
  if (p === "viewer") return true;
  if (p === "operator") return user.role === "operator";
  return user.writeRepos.includes(p.slice("write:".length));
}

/**
 * What a pick on a decision means for this user (docs/dashboard-spec.md, Trust
 * boundary): an operator with GitHub write on every repo involved answers;
 * everyone else comments, which nothing acts on.
 */
export type DecisionAccess = { mode: "answer" } | { mode: "opinion"; reason: string };

export function decisionAccess(user: User, repos: string[]): DecisionAccess {
  if (user.role !== "operator") return { mode: "opinion", reason: "Operators answer. Your pick is shown with the decision." };
  const missing = [...new Set(repos)].filter((r) => !user.writeRepos.includes(r));
  if (missing.length) return { mode: "opinion", reason: `No write access to ${missing.join(", ")}.` };
  return { mode: "answer" };
}

export const repoPermission = (user: User, repo: string): "write" | "none" => (user.writeRepos.includes(repo) ? "write" : "none");

export function roleLabel(user: User) {
  return user.role === "operator" ? "Operator" : user.role === "maintainer" ? "Maintainer" : "Viewer";
}
