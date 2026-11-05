// Who a GitHub write is made as. A grant carries `as`, decided where the guard makes it:
//  - a decision answered by an operator gives `user:<login>` (the person who pressed the button acts under their own
//    name, with their own token from the vault);
//  - everything else (rules, reviews, fix-ups, pushes, automatic labels, CI) gives `app`.
// The per-repo setting `repo_identity` decides whether that is used at all: under `legacy` (the default) the box
// account makes every write as before, and `as` only appears in the audit row as a record of what it would be.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import type { Grant, Guarded } from "../core/guard.ts";
import { ownerOf } from "../owners.ts";
import { AppError } from "./app.ts";
import { AppNotInstalledError, installationToken, RepoNotInInstallationError } from "./install-token.ts";

export type Identity = "app" | `user:${string}`;
export type RepoIdentity = "legacy" | "app";
export const REPO_IDENTITIES: readonly RepoIdentity[] = ["legacy", "app"];

const key = (repo: string): string => `repo_identity:${repo}`;

export function repoIdentity(db: DatabaseSync, repo: string): RepoIdentity {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key(repo)) as { value: string } | undefined;
  return row?.value === "app" ? "app" : "legacy";
}

/** Returns false when nothing changed. */
export function setRepoIdentity(db: DatabaseSync, by: string, repo: string, value: unknown): boolean {
  if (value !== "legacy" && value !== "app") throw new Error("the repo identity must be legacy or app");
  if (!db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  const was = repoIdentity(db, repo);
  if (was === value) return false;
  if (value === "legacy") db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  else db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key(repo), value);
  audit(db, by, "repo-identity", repo, { identity: value, was });
  return true;
}

/** The identity a write made for `decisionId` has: the login that answered it, or the app (no decision, not answered yet). */
export function identityOfDecision(db: DatabaseSync, decisionId: string | undefined): Identity {
  if (decisionId === undefined) return "app";
  const row = db.prepare("SELECT answered_by FROM decisions WHERE id = ? AND answer IS NOT NULL").get(decisionId) as { answered_by: string | null } | undefined;
  return row?.answered_by ? `user:${row.answered_by}` : "app";
}

/** The identity a grant was made for. */
export const identityFor = (g: Guarded | Grant): Identity => g.as;

/** What an audit row records: `legacy` while the repo is on the box account, else the grant's identity. */
export function auditIdentity(db: DatabaseSync, g: Guarded | Grant): "legacy" | Identity {
  return repoIdentity(db, g.repo) === "legacy" ? "legacy" : identityFor(g);
}

/** Why a repo cannot use the app identity (no app registered, not installed, repo outside the installation), or null when it can. */
export async function appIdentityBlocker(repo: string, mint: (owner: string, repo: string) => Promise<string> = installationToken): Promise<string | null> {
  const owner = ownerOf(repo);
  try {
    await mint(owner, repo);
    return null;
  } catch (e) {
    if (e instanceof AppNotInstalledError) return `The GitHub App is not installed on ${owner}.`;
    if (e instanceof RepoNotInInstallationError) return `${owner}/${repo} is not in the GitHub App's installation.`;
    if (e instanceof AppError && e.message === "no GitHub App is registered") return "No GitHub App is registered.";
    return `GitHub could not confirm the installation: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160)}`;
  }
}

/** Sets a repo's identity after checking that the app can act there (checked for `app` only). Returns false when nothing changed. */
export async function setRepoIdentityChecked(db: DatabaseSync, by: string, repo: string, value: unknown, mint?: (owner: string, repo: string) => Promise<string>): Promise<boolean> {
  if (value === "app") {
    const why = await appIdentityBlocker(repo, mint);
    if (why) throw new Error(why);
  }
  return setRepoIdentity(db, by, repo, value);
}
