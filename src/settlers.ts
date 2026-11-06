// Who may settle a decision (answer, undo their own answer, Backlog, press a conversation card). An operator always may.
// A maintainer may when `settings.maintainer_writes` is on, every repo the decision covers has the app's identity (the
// GitHub writes then run as that person through the user lane, never as the box account) and the person has write
// permission on every one of those repos.
import type { DatabaseSync } from "node:sqlite";
import { repoIdentity } from "./github/identity.ts";

export const MAINTAINER_WRITES_KEY = "maintainer_writes";

export const maintainerWritesOn = (db: DatabaseSync): boolean =>
  (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(MAINTAINER_WRITES_KEY) as { value: string } | undefined)?.value === "1";

export function setMaintainerWrites(db: DatabaseSync, on: boolean): boolean {
  if (maintainerWritesOn(db) === on) return false;
  if (on) db.prepare("INSERT INTO main.settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = '1'").run(MAINTAINER_WRITES_KEY);
  else db.prepare("DELETE FROM main.settings WHERE key = ?").run(MAINTAINER_WRITES_KEY);
  return true;
}

/** SQL for the logins whose answers the pipeline acts on: operators, and maintainers while `maintainer_writes` is on. */
export const SETTLER_LOGINS_SQL = `(SELECT login FROM main.access WHERE role = 'operator'
  OR (role = 'maintainer' AND EXISTS (SELECT 1 FROM main.settings WHERE key = '${MAINTAINER_WRITES_KEY}' AND value = '1')))`;

export function settlerLogins(db: DatabaseSync): Set<string> {
  return new Set((db.prepare(`SELECT login FROM ${SETTLER_LOGINS_SQL}`).all() as { login: string }[]).map((r) => r.login));
}

/** Every repo has the app's identity, so a maintainer's GitHub writes run as that maintainer. */
export const allAppIdentity = (db: DatabaseSync, repos: string[]): boolean => repos.every((r) => repoIdentity(db, r) === "app");

const WRITE = "('write', 'maintain', 'admin')";

/** The sync form for views and the planner: write permission from the cached `repo_permissions` value. */
export function canSettleCached(db: DatabaseSync, login: string, role: string, repos: string[]): boolean {
  if (role === "operator") return true;
  if (role !== "maintainer" || !maintainerWritesOn(db) || !allAppIdentity(db, repos)) return false;
  const has = db.prepare(`SELECT 1 FROM main.repo_permissions WHERE login = ? AND repo = ? AND permission IN ${WRITE}`);
  return repos.every((r) => !!has.get(login, r));
}

/** The request form: write permission is read live (the session's `canWrite`). An operator's write access is checked by the caller. */
export async function canSettle(db: DatabaseSync, user: { login: string; role: string; canWrite: (repo: string) => Promise<boolean> }, repos: string[]): Promise<boolean> {
  if (user.role === "operator") return true;
  if (user.role !== "maintainer" || !maintainerWritesOn(db) || !allAppIdentity(db, repos)) return false;
  const ok = await Promise.all(repos.map((r) => user.canWrite(r).catch(() => false)));
  return ok.every(Boolean);
}

/** The DB-side form for the pipeline: the login's current role, and the cached write permission for a maintainer. Write access is read live again when the write is made. */
export function settlesNow(db: DatabaseSync, login: string | null, repos: string[]): boolean {
  if (!login) return false;
  const row = db.prepare("SELECT role FROM main.access WHERE login = ?").get(login) as { role: string } | undefined;
  return !!row && canSettleCached(db, login, row.role, repos);
}
