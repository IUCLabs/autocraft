// The shared repositories (framework, language packs) that Opus calls may read
// beside the item's own repository: the setting, and read-only checkouts of
// their default branches.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { ghApi } from "../verify/crates.ts";
import { SHARED_NAME } from "./command.ts";
import { checkoutForCommit, ORG } from "./index.ts";

export const SHARED_REPOS_KEY = "shared_repos";
export const SHARED_REPOS_DEFAULT = ["craft-i18n", "craft-libs"];
export const SHARED_REPOS_MAX = 8;

/** Repository names in the mirror's form, sorted and without duplicates. */
function clean(names: unknown[]): string[] {
  return [...new Set(names.map((n) => String(n).trim()))].sort();
}

/** The shared repositories (sorted). The default applies until the setting is saved; a saved list may be empty. */
export function sharedRepos(db: DatabaseSync): string[] {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(SHARED_REPOS_KEY) as { value: string } | undefined;
  if (!row) return SHARED_REPOS_DEFAULT;
  try {
    const v = JSON.parse(row.value) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && SHARED_NAME.test(x))) return clean(v);
  } catch { /* unreadable: use the default */ }
  return SHARED_REPOS_DEFAULT;
}

export function setSharedRepos(db: DatabaseSync, names: unknown, by: string): string[] {
  if (!Array.isArray(names) || names.length > SHARED_REPOS_MAX || !names.every((x) => typeof x === "string" && SHARED_NAME.test(x.trim()))) {
    throw new Error(`shared repositories must be a list of at most ${SHARED_REPOS_MAX} repository names (letters, digits, . _ -)`);
  }
  const list = clean(names);
  const was = sharedRepos(db);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(SHARED_REPOS_KEY, JSON.stringify(list));
  if (JSON.stringify(list) !== JSON.stringify(was)) audit(db, by, "shared-repos", "sandbox", { repos: list, was });
  return list;
}

/** A read-only checkout of `name`'s default branch head, or null. The branch comes from the mirror when the repo is tracked, else from GitHub. */
export async function sharedCheckout(db: DatabaseSync, name: string, log: (line: string) => void = () => {}): Promise<string | null> {
  const { defaultDeps } = await import("../fixissue/index.ts");
  const row = db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(name) as { default_branch: string | null } | undefined;
  const branch = row?.default_branch ?? (await ghApi(`repos/${ORG}/${name}`, ".default_branch")).trim();
  if (!branch) return null;
  const sha = await defaultDeps().mainHead(name, branch);
  return sha ? checkoutForCommit(name, branch, sha, log) : null;
}

/** Checkouts of every shared repository that could be checked out; the others are left out. */
export async function sharedCheckouts(db: DatabaseSync, log: (line: string) => void = console.log): Promise<{ name: string; dir: string }[]> {
  const out: { name: string; dir: string }[] = [];
  for (const name of sharedRepos(db)) {
    try {
      const dir = await sharedCheckout(db, name, log);
      if (dir) out.push({ name, dir });
      else log(`  shared repository ${name}: no checkout; left out`);
    } catch (e) {
      log(`  shared repository ${name}: ${String((e as Error).message).slice(0, 150)}; left out`);
    }
  }
  return out;
}

export const commands = {
  "shared-repos": {
    summary: "shared-repos [NAME...|none]: show or set the repositories Opus calls may read beside the item's own (default craft-libs craft-i18n)",
    async run(args: string[]): Promise<void> {
      const { connect } = await import("../db.ts");
      const db = connect();
      if (args.length) setSharedRepos(db, args[0] === "none" && args.length === 1 ? [] : args, "cli");
      console.log(`shared repositories: ${sharedRepos(db).join(" ") || "none"}`);
    },
  },
};
