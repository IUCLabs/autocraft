import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  ["jobs", "repo", "TEXT"],
];

// Indexes on added columns: they can only be created once the column exists.
const ADDED_INDEXES = ["CREATE INDEX IF NOT EXISTS main.jobs_step_repo ON jobs(step, repo, id)"];

// Bump when migrateValues() or backfill() change what they do.
const MIGRATION_VERSION = 2;

// Rows written before their column existed.
function backfill(db: DatabaseSync): void {
  db.exec("UPDATE main.jobs SET repo = json_extract(params, '$.repo') WHERE repo IS NULL AND json_valid(params) AND json_type(params, '$.repo') = 'text'");
}

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
  // Looked up first: an UPDATE that changes nothing still takes the write lock.
  if (!db.prepare("SELECT 1 FROM main.access WHERE role = 'admin'").get()) return;
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

/** Identifies the schema this code expects; the database stores the stamp it was last migrated with. */
function schemaStamp(sql: string): string {
  return createHash("sha256").update(sql).update(JSON.stringify([ADDED_COLUMNS, ADDED_INDEXES, MIGRATION_VERSION])).digest("hex").slice(0, 16);
}

function stampOf(db: DatabaseSync): string | null {
  try {
    return (db.prepare("SELECT value FROM main.settings WHERE key = 'schema_stamp'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    return null; // no settings table yet
  }
}

export function connect(path: string = dbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 30_000 });
  // WAL so the dashboard can read while a sync writes
  db.exec("PRAGMA journal_mode=WAL");
  // WAL needs no fsync per commit for consistency; a power cut can lose the last commits, not corrupt the file
  db.exec("PRAGMA synchronous=NORMAL");
  // INSERT OR REPLACE then runs delete triggers, which keep the full-text index right
  db.exec("PRAGMA recursive_triggers=ON");
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const stamp = schemaStamp(schema);
  // A current database takes no write lock here: opening a connection must not wait for a sync.
  if (stampOf(db) === stamp) {
    migrateValues(db);
    return db;
  }
  db.exec(schema);
  addColumns(db);
  for (const ix of ADDED_INDEXES) db.exec(ix);
  migrateValues(db);
  backfill(db);
  buildSearchIndex(db);
  // Progress counts from here: the first sync, or now for a new database.
  db.exec(`INSERT OR IGNORE INTO main.settings (key, value) SELECT 'tracking_started_at',
    COALESCE((SELECT MIN(synced_at) FROM main.repos), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  db.prepare("INSERT INTO main.settings (key, value) VALUES ('schema_stamp', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(stamp);
  return db;
}
