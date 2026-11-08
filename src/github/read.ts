// The environment of a child process that reads from GitHub (gh api, gh pr, git fetch over HTTPS).
// Under the `box` identity nothing is added: the child inherits this process's environment and the box account's
// login. Under `app` the child's whole environment is the inherited basics plus an installation token (never the
// box account's credentials), and a failure to mint one is an error, not a fallback to the box account.
// The setting is read at every call, so a switch takes effect in the runner and the dashboard without a restart.
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../db.ts";
import { DEFAULT_OWNER, OWNER } from "../owners.ts";
import { AppNotInstalledError, TOKEN_ENV, appChildEnv, installationToken } from "./install-token.ts";

export type ReadEnv = Record<string, string>;
export type ReadDeps = { db?: DatabaseSync; mint?: (owner: string) => Promise<string>; defaultOwner?: () => string };

let shared: { path: string; db: DatabaseSync } | null = null;
/** A read-only handle on the instance database, opened on first use; null when the database cannot be opened. */
function sharedDb(): DatabaseSync | null {
  const path = dbPath();
  if (shared?.path === path) return shared.db;
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    shared = { path, db };
    return db;
  } catch {
    return null;
  }
}

function settingOf(db: DatabaseSync): string | undefined {
  try {
    return (db.prepare("SELECT value FROM main.settings WHERE key = 'github_identity'").get() as { value: string } | undefined)?.value;
  } catch {
    return undefined;
  }
}

/** Whether reads go through the GitHub App right now. */
export function readsUseApp(db?: DatabaseSync): boolean {
  const d = db ?? sharedDb();
  return d !== null && settingOf(d) === "app";
}

/** The owner of the first tracked repo: the installation that reads not tied to one owner go through. */
export function trackedOwner(db?: DatabaseSync): string {
  const d = db ?? sharedDb();
  try {
    const r = d?.prepare("SELECT r.owner FROM main.tracked_repos t JOIN main.repos r ON r.name = t.name WHERE r.owner IS NOT NULL ORDER BY t.added_at LIMIT 1").get() as { owner: string } | undefined;
    if (r?.owner && OWNER.test(r.owner)) return r.owner;
  } catch { /* fall through to the default owner */ }
  return DEFAULT_OWNER;
}

/** The owner a gh or git command is about, when its arguments name one (`repos/O/…`, `--repo O/…`, `owner=O`, `github.com/O/…`). */
export function ownerOfArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^(?:repos|orgs)\/([^/]+)/.exec(a) ?? /github\.com\/([^/]+)\//.exec(a) ?? /^owner=(.+)$/.exec(a);
    if (m && OWNER.test(m[1]!)) return m[1]!;
    if (a === "--repo" && args[i + 1]?.includes("/")) { const o = args[i + 1]!.split("/")[0]!; if (OWNER.test(o)) return o; }
  }
  return undefined;
}

/**
 * The whole child environment for a read as the app, or undefined under `box` (the child inherits). `owner` picks the
 * installation; without one the tracked owner's is used. Throws when no installation token can be minted.
 */
export async function readEnv(owner?: string, deps: ReadDeps = {}): Promise<ReadEnv | undefined> {
  // A process that was started with an identity of its own (a merge child that acts as a person) keeps it.
  if (process.env[TOKEN_ENV]) return undefined;
  if (!readsUseApp(deps.db)) return undefined;
  const o = owner && OWNER.test(owner) ? owner : (deps.defaultOwner ?? (() => trackedOwner(deps.db)))();
  try {
    return appChildEnv(await (deps.mint ?? installationToken)(o));
  } catch (e) {
    const why = e instanceof AppNotInstalledError ? `the GitHub App is not installed on ${o}` : `no installation token for ${o}: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}`;
    throw new Error(`app identity: ${why}`);
  }
}

/** The environment for spawning `cmd args`: the app's for gh and git under `app`, else undefined (inherit). */
export async function readEnvFor(cmd: string, args: readonly string[]): Promise<ReadEnv | undefined> {
  if (cmd !== "gh" && cmd !== "git") return undefined;
  return readEnv(ownerOfArgs(args));
}
