import type { User } from "../api/types";
import type { Permission } from "./types";

export function can(user: User, p: Permission): boolean {
  if (p === "viewer") return true;
  if (p === "operator") return user.role === "operator";
  return user.writeRepos.includes(p.slice("write:".length));
}

/** Operators with GitHub write on every repo involved act on a decision; everyone else leaves feedback. */
export function canAct(user: User, repos: string[]): boolean {
  return user.role === "operator" && [...new Set(repos)].every((r) => user.writeRepos.includes(r));
}

export const repoPermission = (user: User, repo: string): "write" | "none" => (user.writeRepos.includes(repo) ? "write" : "none");

export function roleLabel(user: User) {
  return user.role === "operator" ? "Operator" : user.role === "maintainer" ? "Maintainer" : "Viewer";
}
