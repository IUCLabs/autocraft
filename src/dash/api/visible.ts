// Which tracked repos a viewer may see. Public repos are visible to everyone
// signed in; a repo that is not public (private, internal, or unknown) is
// visible to operators and to users whose own GitHub token has some
// permission on it (stored in repo_permissions, refreshed by the server).
// Every query that spans repos must go through this.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { trackedNames } from "../../repos.ts";
import { DEFAULT_OWNER, ownerOf } from "../../owners.ts";
import { HttpError } from "../server/util.ts";
import type { Req, User } from "../types.ts";
import { SECURITY_PREFIX, securityRepo } from "../../security/rules.ts";
import { canSeeInternals } from "./staff.ts";

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

/** Owner of each visible repo that is not storytold's; the web app builds GitHub links from it. */
export async function repoOwners(db: DatabaseSync, req: Req): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await visibleRepos(db, req)) if (ownerOf(r) !== DEFAULT_OWNER) out[r] = ownerOf(r);
  return out;
}

/** Tables the dashboard lists without scoping them to tracked repos; their rows outlive untracking. */
const UNSCOPED_REPO_TABLES = ["jobs", "build_tasks", "merges", "agent_run_items", "main_ci", "merge_batches"];

/** Every repo name the database knows, tracked or not, with `(security):<repo>` pseudo repos reduced to their repo. */
function knownRepos(db: DatabaseSync): Set<string> {
  const sql = ["SELECT name AS repo FROM main.repos", "SELECT name AS repo FROM main.tracked_repos", ...UNSCOPED_REPO_TABLES.map((t) => `SELECT DISTINCT repo FROM main.${t} WHERE repo IS NOT NULL`)].join(" UNION ");
  const out = new Set<string>();
  for (const { repo } of db.prepare(sql).all() as { repo: string }[]) out.add(repo.startsWith(SECURITY_PREFIX) ? repo.slice(SECURITY_PREFIX.length) : repo);
  return out;
}

/**
 * Every known repo the requester may not see: all repos in the mirror and in the pipeline tables, tracked or not (rows
 * of an untracked repo stay in jobs, tasks and runs, and are for operators only). Empty for operators. The pseudo repo
 * of a repo's security scans (`(security):<repo>`, where its jobs and agent runs are recorded) is hidden from viewers
 * and from maintainers who cannot see the repo, so every listing that leaves out hidden repos leaves the scans out too.
 */
export async function hiddenRepos(db: DatabaseSync, req: Req): Promise<string[]> {
  if (req.user.role === "operator") return [];
  const visible = new Set(await visibleRepos(db, req));
  const known = [...knownRepos(db)].sort();
  const staff = canSeeInternals(req);
  const hidden = known.filter((r) => !visible.has(r));
  return [...hidden, ...known.filter((r) => !staff || !visible.has(r)).map(securityRepo)];
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

/** Free text from the pipeline (breaker, pause and status reasons) can quote an item of a repo the caller may not see: it is left out whole then. */
export function blankIfHidden<T extends string | null | undefined>(text: T, hidden: string[]): T | "" {
  return text && hidden.some((h) => text.includes(h)) ? "" : text;
}
