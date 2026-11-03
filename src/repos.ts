// Tracked repos: the admin-chosen subset of the org that sync, the pipeline and
// the dashboard work on. `repos` holds every org repo; `tracked_repos` selects.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";
import { connect } from "./db.ts";

export class RepoError extends Error {}

export const trackedNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM main.tracked_repos ORDER BY name").all() as { name: string }[]).map((r) => r.name);

export const isTracked = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(name) !== undefined;

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function trackRepo(db: DatabaseSync, by: string, name: string): boolean {
  if (!NAME.test(name)) throw new RepoError("Not a repo name.");
  const r = db.prepare("INSERT OR IGNORE INTO main.tracked_repos (name, added_by, added_at) VALUES (?, ?, ?)")
    .run(name, by, new Date().toISOString());
  if (r.changes) {
    // Items updated while the repo was untracked were never read; the next sync reads the repo in full.
    db.prepare("UPDATE main.repos SET high_water = NULL, synced_at = NULL, reconciled_at = NULL WHERE name = ?").run(name);
    audit(db, by, "repo-track", name);
  }
  return r.changes > 0;
}

export function untrackRepo(db: DatabaseSync, by: string, name: string): boolean {
  const r = db.prepare("DELETE FROM main.tracked_repos WHERE name = ?").run(name);
  if (r.changes) audit(db, by, "repo-untrack", name);
  return r.changes > 0;
}

// Deletes the mirrored items and comments of one untracked repo.
export function purgeRepo(db: DatabaseSync, name: string): { items: number; comments: number } {
  if (isTracked(db, name)) throw new RepoError(`${name} is tracked; untrack it first.`);
  db.exec("BEGIN");
  try {
    const comments = Number(db.prepare("DELETE FROM main.comments WHERE repo = ?").run(name).changes);
    const items = Number(db.prepare("DELETE FROM main.items WHERE repo = ?").run(name).changes);
    db.prepare("UPDATE main.repos SET high_water = NULL, synced_at = NULL, reconciled_at = NULL WHERE name = ?").run(name);
    db.exec("COMMIT");
    return { items, comments };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type RepoRow = {
  name: string; tracked: number; open_prs: number | null; open_issues: number | null; rows: number; synced_at: string | null;
};

// Every known repo, tracked first.
export function listAll(db: DatabaseSync): RepoRow[] {
  return db.prepare(`
    SELECT r.name, EXISTS (SELECT 1 FROM main.tracked_repos t WHERE t.name = r.name) AS tracked,
           r.open_prs, r.open_issues, r.synced_at,
           (SELECT COUNT(*) FROM main.items i WHERE i.repo = r.name) AS rows
    FROM main.repos r
    UNION ALL
    SELECT t.name, 1, NULL, NULL, NULL, (SELECT COUNT(*) FROM main.items i WHERE i.repo = t.name)
    FROM main.tracked_repos t WHERE t.name NOT IN (SELECT name FROM main.repos)
    ORDER BY 2 DESC, 1`).all() as RepoRow[];
}

// Temp views that shadow the mirror and work tables on this connection, so every
// dashboard query sees tracked repos only. Writers (sync, CLI) use plain
// connect() and never call this. Rows of untracked repos stay in the database.
// Views carry rowid explicitly because queries order by it. Code that must see
// everything or write through a shadowed name qualifies it with `main.`.
const SCOPED: [string, string][] = [
  ["repos", "name"], ["items", "repo"], ["comments", "repo"], ["stages", "repo"], ["classifications", "repo"],
];
export function scopeToTracked(db: DatabaseSync): void {
  const inList = "IN (SELECT name FROM main.tracked_repos)";
  for (const [t, col] of SCOPED) {
    db.exec(`CREATE TEMP VIEW IF NOT EXISTS ${t} AS SELECT rowid AS rowid, * FROM main.${t} WHERE ${col} ${inList}`);
  }
  // A batch (repo NULL) is hidden when any of its items is in an untracked repo.
  db.exec(`CREATE TEMP VIEW IF NOT EXISTS decisions AS SELECT rowid AS rowid, * FROM main.decisions
    WHERE repo ${inList} OR (repo IS NULL AND NOT EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
      WHERE json_extract(j.value, '$.repo') NOT ${inList}))`);
  db.exec(`CREATE TEMP VIEW IF NOT EXISTS token_usage AS SELECT rowid AS rowid, * FROM main.token_usage
    WHERE repo IS NULL OR repo ${inList}`);
}

function list(): void {
  const db = connect();
  console.log(`${"repo".padEnd(28)} ${"tracked".padEnd(7)} ${"open PRs".padStart(8)} ${"open iss".padStart(8)} ${"mirrored".padStart(8)}  synced_at`);
  for (const r of listAll(db)) {
    console.log(`${r.name.padEnd(28)} ${(r.tracked ? "yes" : "-").padEnd(7)} ${String(r.open_prs ?? "-").padStart(8)} ${String(r.open_issues ?? "-").padStart(8)} ${String(r.rows).padStart(8)}  ${r.synced_at ?? "-"}`);
  }
}

function need(args: string[], usage: string): string {
  if (!args[0]) {
    console.error(`usage: craft-auto repos ${usage}`);
    process.exit(1);
  }
  return args[0];
}

const sub: Record<string, (args: string[]) => void> = {
  list,
  track: (a) => {
    const name = need(a, "track <name>");
    console.log(trackRepo(connect(), "cli", name) ? `tracking ${name}; it syncs at the next sync` : `${name} was already tracked`);
  },
  untrack: (a) => {
    const name = need(a, "untrack <name>");
    console.log(untrackRepo(connect(), "cli", name) ? `untracked ${name}; its rows stay in the mirror (repos purge ${name} deletes them)` : `${name} was not tracked`);
  },
  purge: (a) => {
    const name = need(a, "purge <name>");
    try {
      const r = purgeRepo(connect(), name);
      console.log(`deleted ${r.items} items and ${r.comments} comments of ${name}`);
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      console.error(e.message);
      process.exit(1);
    }
  },
};

export const commands = {
  repos: {
    summary: "tracked repos: list | track <name> | untrack <name> | purge <name>",
    run: (args: string[]) => {
      const f = args[0] ? sub[args[0]] : undefined;
      if (!f) {
        console.error(`usage: craft-auto repos ${Object.keys(sub).join("|")}`);
        process.exit(1);
      }
      f(args.slice(1));
    },
  },
};
