// The write permission of a same-repo PR's author, from GitHub, cached per (repo, login) in repo_permissions.
// Planning reads only the cache; the jobs that push refresh a missing or old entry first.
import type { DatabaseSync } from "node:sqlite";
import { PIPELINE_LOGIN_KEY } from "../core/rules.ts";
import { slugOf } from "../owners.ts";
import { gh } from "../review/diff.ts";
import { sameRepo } from "./pushable.ts";

export const AUTHOR_PERMISSION_TTL_MS = 24 * 3600_000;
const WRITE = new Set(["write", "maintain", "admin"]);
const KNOWN = new Set(["admin", "maintain", "write", "triage", "read", "none"]);

/** "yes" and "no" are known; "unknown" means the permission has not been read yet (a missing entry). */
export type AuthorWrite = "yes" | "no" | "unknown";

type Row = { author: string | null; author_type: string | null };
const authorOf = (db: DatabaseSync, repo: string, number: number): Row | undefined =>
  db.prepare("SELECT author, author_type FROM items WHERE repo = ? AND number = ?").get(repo, number) as Row | undefined;

/** The pipeline's own account and bots write to the repository by construction. */
function writesByRole(db: DatabaseSync, r: Row): boolean {
  if (r.author_type === "Bot") return true;
  const me = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(PIPELINE_LOGIN_KEY) as { value: string } | undefined)?.value;
  return !!me && !!r.author && me.toLowerCase() === r.author.toLowerCase();
}

const cached = (db: DatabaseSync, repo: string, login: string): { permission: string; checked_at: string } | undefined =>
  db.prepare("SELECT permission, checked_at FROM main.repo_permissions WHERE login = ? AND repo = ?").get(login, repo) as { permission: string; checked_at: string } | undefined;

/** Database only: whether the PR's author can write to the repository, as last read (a stale entry still counts until it is refreshed). */
export function authorWrites(db: DatabaseSync, repo: string, number: number): AuthorWrite {
  const r = authorOf(db, repo, number);
  if (!r?.author) return "no";
  if (writesByRole(db, r)) return "yes";
  const c = cached(db, repo, r.author);
  return !c ? "unknown" : WRITE.has(c.permission) ? "yes" : "no";
}

export type PermissionReader = (repo: string, login: string) => Promise<string | null>;

/** The login's permission on the repository from GitHub; null when it cannot be told. */
export const ghPermission: PermissionReader = async (repo, login) => {
  const r = await gh(["api", `repos/${slugOf(repo)}/collaborators/${encodeURIComponent(login)}/permission`, "--jq", '.role_name // .permission']);
  const p = r.out.trim().toLowerCase();
  return r.code === 0 && KNOWN.has(p) ? p : null;
};

/**
 * For a job about to push: reads the author's permission from GitHub when it is missing or over a day old, stores it, and
 * answers like `authorWrites`. A PR whose head is in another repository needs no author permission. A failed read keeps an old
 * entry, and without one the answer is "unknown": the caller leaves the PR for a later run.
 */
export async function ensureAuthorWrites(db: DatabaseSync, repo: string, number: number, headRepo: string | null | undefined, read: PermissionReader = ghPermission): Promise<AuthorWrite> {
  if (!sameRepo(headRepo, repo)) return "yes";
  const r = authorOf(db, repo, number);
  if (!r?.author) return "no";
  if (!writesByRole(db, r)) {
    const c = cached(db, repo, r.author);
    if (!c || Date.now() - Date.parse(c.checked_at) > AUTHOR_PERMISSION_TTL_MS) {
      const p = await read(repo, r.author).catch(() => null);
      if (p) db.prepare(`INSERT INTO main.repo_permissions (login, repo, permission, checked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (login, repo) DO UPDATE SET permission = excluded.permission, checked_at = excluded.checked_at`).run(r.author, repo, p, new Date().toISOString());
    }
  }
  return authorWrites(db, repo, number);
}
