// Each user's own repo picks for their user-local helpers, stored in `user_settings` under `repos` as a JSON list. Empty means
// every repo. The per-repo Pipeline switch stays the operators' control: a picked repo whose pipeline is off has no calls.
import type { DatabaseSync } from "node:sqlite";
import { prep } from "../sql-cache.ts";
import { audit } from "../dash/audit.ts";
import { trackedNames } from "../repos.ts";

const KEY = "repos";
/** The most repos one user may pick. */
export const MAX_PICKS = 500;

/** The user's picked repos, sorted; empty when they never picked any (every repo). */
export function userRepos(db: DatabaseSync, login: string): string[] {
  const row = prep(db, "SELECT value FROM main.user_settings WHERE login = ? AND key = ?").get(login, KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").sort() : [];
  } catch {
    return [];
  }
}

/** Repo picks from a request body, checked against the tracked repos; throws with the reason for a bad list. */
export function parseRepos(db: DatabaseSync, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_PICKS || !raw.every((x) => typeof x === "string")) throw new Error(`repos must be a list of at most ${MAX_PICKS} repo names`);
  const tracked = new Set(trackedNames(db));
  const unknown = raw.filter((x) => !tracked.has(x));
  if (unknown.length) throw new Error(`not tracked: ${unknown.slice(0, 5).join(", ")}`);
  return [...new Set(raw as string[])].sort();
}

/** Stores the user's picks; a change is audited. */
export function setUserRepos(db: DatabaseSync, login: string, repos: string[]): string[] {
  const was = userRepos(db, login);
  prep(db, "INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(login, KEY, JSON.stringify(repos), new Date().toISOString());
  if (was.join("\n") !== repos.join("\n")) audit(db, login, "my-repos", login, { repos, was });
  return repos;
}

/**
 * The repos a claim may take calls from: the user's picks narrowed by the helper's own list, never widened by it. Null when
 * neither limits it. A call that names no repo is not limited by this (claimOrder checks only the repos a call names).
 */
export function claimRepos(db: DatabaseSync, login: string, helperRepos: readonly string[] | undefined): Set<string> | null {
  const picks = userRepos(db, login);
  if (!picks.length) return helperRepos ? new Set(helperRepos) : null;
  if (!helperRepos) return new Set(picks);
  const own = new Set(helperRepos);
  return new Set(picks.filter((r) => own.has(r)));
}
