// Which tracked repos a viewer may see. Public repos are visible to everyone
// signed in; a repo that is not public (private, internal, or unknown) is
// visible to operators and to users whose own GitHub token has some
// permission on it (stored in repo_permissions, refreshed by the server).
// Every query that spans repos must go through this.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { trackedNames } from "../../repos.ts";
import { HttpError } from "../server/util.ts";
import type { Req, User } from "../types.ts";

const memo = new WeakMap<Req, Promise<string[]>>();

/** The tracked repos `user` may see; also used by the server for image requests. */
export async function visibleTo(db: DatabaseSync, user: Pick<User, "role" | "canRead">): Promise<string[]> {
  const tracked = trackedNames(db);
  if (user.role === "operator") return tracked;
  const pub = new Set((db.prepare("SELECT name FROM main.repos WHERE lower(visibility) = 'public'").all() as { name: string }[]).map((r) => r.name));
  const rest = tracked.filter((r) => !pub.has(r));
  const ok = await Promise.all(rest.map((r) => user.canRead(r).catch(() => false)));
  const allowed = new Set(rest.filter((_, i) => ok[i]));
  return tracked.filter((r) => pub.has(r) || allowed.has(r));
}

/** Tracked repos the requester may see, sorted by name. */
export function visibleRepos(db: DatabaseSync, req: Req): Promise<string[]> {
  let p = memo.get(req);
  if (!p) memo.set(req, (p = visibleTo(db, req.user)));
  return p;
}

/** Tracked repos the requester may not see (empty for operators and when every repo is public). */
export async function hiddenRepos(db: DatabaseSync, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  return trackedNames(db).filter((r) => !visible.has(r));
}

/** 404 unless the repo is tracked and visible to the requester; the message is the same for both. */
export async function needVisible(db: DatabaseSync, req: Req, repo: string): Promise<void> {
  if (!(await visibleRepos(db, req)).includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
}

/**
 * SQL that leaves out the hidden repos: `<col> NOT IN (...)`, binding the names
 * into `params` under `<prefix>0`, `<prefix>1`, ... Null when nothing is hidden.
 */
export function excludeHidden(col: string, hidden: string[], params: Record<string, SQLInputValue>, prefix = "hid"): string | null {
  if (!hidden.length) return null;
  return `${col} NOT IN (${hidden.map((h, k) => ((params[`${prefix}${k}`] = h), `:${prefix}${k}`)).join(",")})`;
}
