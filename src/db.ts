import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fillClassHashes, fillEmbedHashes } from "./itemhash.ts";
import { JEV_USD_PER_INPUT_TOKEN } from "./prompts/index.ts";

export const DEFAULT_DB = join(homedir(), ".local/share/craft-automation/mirror.db");

export function dbPath(): string {
  return process.env.CRAFT_AUTO_DB ?? DEFAULT_DB;
}

// Columns added to existing tables after their first release. CREATE TABLE IF
// NOT EXISTS leaves an older table as it was, so these are added here.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["access", "github_id", "INTEGER"],
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
  ["jobs", "repo", "TEXT"],
  ["build_tasks", "patch", "TEXT"],
  ["build_tasks", "warm_key", "TEXT"],
  ["build_tasks", "warm_role", "TEXT"],
  ["verifications", "note", "TEXT"],
  ["fix_attempts", "size", "TEXT"],
  ["repos", "reconciled_at", "TEXT"],
  ["opus_reviews", "public_review", "TEXT"],
  ["merge_batches", "fork", "TEXT"],
];

// Indexes on added columns: they can only be created once the column exists.
// Covering indexes on the hash columns let the planner compare stored hashes without reading item rows.
// The trigger clears the hashes of an item whose hashed fields were edited without bringing its own (sync does).
const ADDED_INDEXES = [
  "CREATE INDEX IF NOT EXISTS main.jobs_step_repo ON jobs(step, repo, id)",
  "CREATE INDEX IF NOT EXISTS main.items_class ON items(state, repo, number, class_scheme, class_hash)",
  "CREATE INDEX IF NOT EXISTS main.items_embed ON items(repo, number, embed_hash)",
  "CREATE INDEX IF NOT EXISTS main.items_embed_missing ON items(repo, number) WHERE embed_hash IS NULL",
  `CREATE TRIGGER IF NOT EXISTS main.items_hash_stale AFTER UPDATE OF title, body, additions, deletions, changed_files, author_association, kind ON items
    WHEN new.embed_hash IS old.embed_hash AND new.class_hash IS old.class_hash AND new.class_scheme IS old.class_scheme
      AND (old.title IS NOT new.title OR old.body IS NOT new.body OR old.additions IS NOT new.additions OR old.deletions IS NOT new.deletions
        OR old.changed_files IS NOT new.changed_files OR old.author_association IS NOT new.author_association OR old.kind IS NOT new.kind)
    BEGIN
      UPDATE items SET embed_hash = NULL, class_hash = NULL, class_scheme = NULL WHERE rowid = new.rowid;
    END`,
];

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
  if (db.prepare("SELECT 1 FROM main.access WHERE role = 'admin'").get()) db.exec("UPDATE main.access SET role = 'operator' WHERE role = 'admin'");
  // Priority rows written with the impact names (critical, high, normal, low) become levels.
  const OLD = "('critical', 'high', 'normal', 'low')";
  if (db.prepare(`SELECT 1 FROM main.item_priority WHERE impact IN ${OLD} OR jev_impact IN ${OLD} OR haiku_impact IN ${OLD} LIMIT 1`).get()) {
    const lv = (c: string) => `CASE ${c} WHEN 'critical' THEN 'P0' WHEN 'high' THEN 'P1' WHEN 'normal' THEN 'P2' WHEN 'low' THEN 'P3' ELSE ${c} END`;
    db.exec(`UPDATE main.item_priority SET impact = ${lv("impact")}, jev_impact = ${lv("jev_impact")}, haiku_impact = ${lv("haiku_impact")}`);
  }
  // Jev usage saved without a cost is priced from its input tokens.
  const JEV_UNPRICED = "model LIKE 'jev%' AND cost_usd IS NULL AND input_tokens IS NOT NULL";
  if (db.prepare(`SELECT 1 FROM main.token_usage WHERE ${JEV_UNPRICED} LIMIT 1`).get()) {
    db.prepare(`UPDATE main.token_usage SET cost_usd = input_tokens * ? WHERE ${JEV_UNPRICED}`).run(JEV_USD_PER_INPUT_TOKEN);
  }
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

// Fills the stored hashes once, for a database whose items were written before they existed.
// Batched (src/itemhash.ts), so other processes can write between batches.
function buildHashes(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM main.settings WHERE key = 'hashes_built'").get()) return;
  fillEmbedHashes(db);
  fillClassHashes(db);
  db.exec("INSERT OR IGNORE INTO main.settings (key, value) VALUES ('hashes_built', '1')");
}

// Fills item_stage once, for a database that had stages before the table existed.
function buildItemStage(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM main.settings WHERE key = 'item_stage_built'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM main.settings WHERE key = 'item_stage_built'").get()) {
      db.exec(`INSERT OR REPLACE INTO main.item_stage (repo, number, stage, at, reviewed)
        SELECT repo, number, stage, at, reviewed FROM (
          SELECT repo, number, stage, at, MAX(stage = 'reviewed') OVER (PARTITION BY repo, number) AS reviewed,
            ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) AS rn FROM main.stages
        ) WHERE rn = 1`);
      db.exec("INSERT INTO main.settings (key, value) VALUES ('item_stage_built', '1')");
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
  buildHashes(db);
  buildItemStage(db);
  // Progress counts from here: the first sync, or now for a new database.
  db.exec(`INSERT OR IGNORE INTO main.settings (key, value) SELECT 'tracking_started_at',
    COALESCE((SELECT MIN(synced_at) FROM main.repos), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  db.prepare("INSERT INTO main.settings (key, value) VALUES ('schema_stamp', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(stamp);
  return db;
}
