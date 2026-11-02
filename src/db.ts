import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fillClassHashes, fillEmbedHashes } from "./itemhash.ts";

export const DEFAULT_DB = join(homedir(), ".local/share/craft-automation/mirror.db");

export function dbPath(): string {
  return process.env.CRAFT_AUTO_DB ?? DEFAULT_DB;
}

// Columns added to existing tables after their first release. CREATE TABLE IF
// NOT EXISTS leaves an older table as it was, so these are added here.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["decisions", "summary", "TEXT"],
  ["decisions", "summary_by", "TEXT"],
  ["decisions", "summary_at", "TEXT"],
  ["decisions", "adopted_opinion", "TEXT"],
  ["classifications", "probs", "TEXT"],
  ["token_usage", "cost_usd", "REAL"],
  ["classifications", "input_hash", "TEXT"],
  ["jobs", "items", "INTEGER"],
  ["merges", "ci", "TEXT"],
  ["merges", "mergeable", "TEXT"],
  ["items", "embed_hash", "TEXT"],
  ["items", "class_hash", "TEXT"],
  ["items", "class_scheme", "TEXT"],
];

function addColumns(db: DatabaseSync): void {
  const have = new Map<string, Set<string>>();
  for (const [table, column, type] of ADDED_COLUMNS) {
    let cols = have.get(table);
    if (!cols) {
      cols = new Set((db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      have.set(table, cols);
    }
    if (!cols.has(column)) db.exec(`ALTER TABLE main.${table} ADD COLUMN ${column} ${type}`);
  }
}

// Values renamed after their first release, rewritten on every connect.
function migrateValues(db: DatabaseSync): void {
  db.exec("UPDATE main.access SET role = 'operator' WHERE role = 'admin'");
}

// Fills the full-text tables once, for a database that had items before they existed.
function buildSearchIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM main.settings WHERE key = 'fts_built'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM main.settings WHERE key = 'fts_built'").get()) {
      db.exec("INSERT INTO main.items_fts (items_fts) VALUES ('rebuild')");
      db.exec("INSERT INTO main.comments_fts (comments_fts) VALUES ('rebuild')");
      // ORDER BY rank: a title match weighs ten times one in the body
      db.exec("INSERT INTO main.items_fts (items_fts, rank) VALUES ('rank', 'bm25(10.0, 1.0)')");
      db.exec("INSERT INTO main.settings (key, value) VALUES ('fts_built', '1')");
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Indexes on columns added above, so they cannot live in schema.sql (it runs before addColumns).
// Covering indexes: the planner compares stored hashes without reading item rows.
function hashIndexes(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS main.items_class ON items(state, repo, number, class_scheme, class_hash);
    CREATE INDEX IF NOT EXISTS main.items_embed ON items(repo, number, embed_hash);
    CREATE INDEX IF NOT EXISTS main.items_embed_missing ON items(repo, number) WHERE embed_hash IS NULL;
    -- An edit of the hashed fields that does not bring its own hashes (sync does) clears them; the readers refill them.
    CREATE TRIGGER IF NOT EXISTS main.items_hash_stale AFTER UPDATE OF title, body, additions, deletions, changed_files, author_association, kind ON items
    WHEN new.embed_hash IS old.embed_hash AND new.class_hash IS old.class_hash AND new.class_scheme IS old.class_scheme
      AND (old.title IS NOT new.title OR old.body IS NOT new.body OR old.additions IS NOT new.additions OR old.deletions IS NOT new.deletions
        OR old.changed_files IS NOT new.changed_files OR old.author_association IS NOT new.author_association OR old.kind IS NOT new.kind)
    BEGIN
      UPDATE items SET embed_hash = NULL, class_hash = NULL, class_scheme = NULL WHERE rowid = new.rowid;
    END`);
}

// Fills the stored hashes once, for a database whose items were written before they existed.
function buildHashes(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM main.settings WHERE key = 'hashes_built'").get()) return;
  fillEmbedHashes(db);
  fillClassHashes(db);
  db.exec("INSERT OR IGNORE INTO main.settings (key, value) VALUES ('hashes_built', '1')");
}

export function connect(path: string = dbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 30_000 });
  // WAL so the dashboard can read while a sync writes
  db.exec("PRAGMA journal_mode=WAL");
  // INSERT OR REPLACE then runs delete triggers, which keep the full-text index right
  db.exec("PRAGMA recursive_triggers=ON");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  addColumns(db);
  migrateValues(db);
  buildSearchIndex(db);
  hashIndexes(db);
  buildHashes(db);
  // Progress counts from here: the first sync, or now for a new database.
  db.exec(`INSERT OR IGNORE INTO main.settings (key, value) SELECT 'tracking_started_at',
    COALESCE((SELECT MIN(synced_at) FROM main.repos), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  return db;
}
