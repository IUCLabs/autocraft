// The item snapshot: a read-only SQLite file with only GitHub-sourced data
// (items, comments, reviews, their full-text index, item embeddings) plus the
// outcome of each decision (kind, chosen option, date). Sandboxed model calls
// read it through the item tools (src/itemtools/server). Nothing written on the
// dashboard (notes, opinions, comments), no settings, audit, accounts, access
// lists, tokens or host paths goes in. Only public repositories are copied.
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../db.ts";

export function snapshotDir(): string {
  return process.env.CRAFT_AUTO_SNAPSHOT_DIR ?? join(dirname(dbPath()), "item-snapshot");
}
export const snapshotFile = (): string => join(snapshotDir(), "items.db");

const ITEM_COLUMNS = ["repo", "number", "kind", "state", "title", "body", "url", "author", "author_association", "created_at", "updated_at",
  "closed_at", "merged_at", "state_reason", "is_draft", "labels", "comments_count", "additions", "deletions", "changed_files",
  "head_ref", "head_oid", "head_repo", "base_ref", "review_decision", "mergeable", "ci_state"];
const COMMENT_COLUMNS = ["id", "repo", "number", "kind", "author", "created_at", "body", "review_state", "commit_oid"];

/** Bumped when the snapshot's tables change; a file with another version is rebuilt. */
export const SCHEMA_VERSION = "2";

const cols = (names: string[], types: Record<string, string> = {}) => names.map((c) => `${c} ${types[c] ?? ""}`.trim()).join(", ");

// The full-text index follows the rows through triggers, so refreshing is plain inserts and deletes.
const DDL = `
CREATE TABLE items (${cols(ITEM_COLUMNS, { repo: "TEXT NOT NULL", number: "INTEGER NOT NULL" })}, PRIMARY KEY (repo, number));
CREATE TABLE comments (${cols(COMMENT_COLUMNS, { id: "TEXT PRIMARY KEY", number: "INTEGER NOT NULL" })});
CREATE INDEX comments_item ON comments(repo, number);
CREATE TABLE item_embeddings (repo TEXT NOT NULL, number INTEGER NOT NULL, model TEXT NOT NULL, at TEXT, vec BLOB NOT NULL, PRIMARY KEY (repo, number));
CREATE TABLE decision_outcomes (repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, answer TEXT NOT NULL, answer_label TEXT, answered_at TEXT);
CREATE INDEX decision_outcomes_item ON decision_outcomes(repo, number);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE comments_fts USING fts5(body, content='comments', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
`;

const KEY = /^[A-Za-z0-9_.-]{1,60}$/;

type DecisionRow = { kind: string; repo: string | null; number: number | null; items: string | null; options: string; answer: string; exceptions: string | null; answered_at: string | null };

function outcomes(rows: DecisionRow[]): { repo: string; number: number; kind: string; answer: string; label: string | null; at: string | null }[] {
  const out: { repo: string; number: number; kind: string; answer: string; label: string | null; at: string | null }[] = [];
  const parse = <T>(s: string | null): T | null => {
    try { return s ? (JSON.parse(s) as T) : null; } catch { return null; }
  };
  for (const r of rows) {
    const options = parse<{ key?: unknown; label?: unknown }[]>(r.options) ?? [];
    const labelOf = (k: string) => {
      const o = options.find((x) => x.key === k);
      return o && typeof o.label === "string" ? o.label.slice(0, 120) : null;
    };
    const push = (repo: string, number: number, answer: string) => {
      // Only a chosen option's key goes in: an answer that is not a plain key could be free text.
      if (!KEY.test(answer) || !Number.isInteger(number)) return;
      out.push({ repo, number, kind: r.kind, answer, label: labelOf(answer), at: r.answered_at });
    };
    if (r.repo && r.number !== null) push(r.repo, r.number, r.answer);
    else {
      const ex = new Map((parse<{ repo: string; number: number; answer: string }[]>(r.exceptions) ?? []).map((e) => [`${e.repo}#${e.number}`, e.answer]));
      for (const it of parse<{ repo: string; number: number }[]>(r.items) ?? []) push(it.repo, it.number, ex.get(`${it.repo}#${it.number}`) ?? r.answer);
    }
  }
  return out;
}

export type SnapshotStats = { items: number; comments: number; bytes: number; rebuilt: boolean; changed: { items: number; comments: number; embeddings: number } };

const differs = (a: string, b: string, names: string[]) => names.filter((c) => c !== "id").map((c) => `${a}.${c} IS NOT ${b}.${c}`).join(" OR ");

/**
 * Brings the snapshot at `dest` up to date with the mirror at `src`: rows
 * added, changed or gone since the last refresh are applied in one
 * transaction, so a refresh that finds nothing new writes nothing. The file is
 * built from scratch (in a temporary file renamed into place) only when it is
 * missing or has another schema version. Only repositories with visibility
 * `public` are copied. The source is only read.
 */
export function writeSnapshot(src: string = dbPath(), dest: string = snapshotFile()): SnapshotStats {
  mkdirSync(dirname(dest), { recursive: true });
  let rebuilt = false;
  let target = dest;
  if (!existsSync(dest) || !hasVersion(dest)) {
    rebuilt = true;
    target = `${dest}.${process.pid}.tmp`;
    rmSync(target, { force: true });
    const fresh = new DatabaseSync(target);
    fresh.exec("PRAGMA journal_mode=DELETE");
    fresh.exec(DDL);
    fresh.prepare("INSERT INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    fresh.close();
  }
  const db = new DatabaseSync(target, { timeout: 30_000 });
  try {
    db.prepare("ATTACH DATABASE ? AS src").run(`file:${encodeURI(src).replace(/\?/g, "%3F").replace(/#/g, "%23")}?mode=ro`);
    const changed = { items: 0, comments: 0, embeddings: 0 };
    db.exec("BEGIN IMMEDIATE");
    const pub = "repo IN (SELECT name FROM src.repos WHERE visibility = 'public')";
    db.exec(`CREATE TEMP VIEW pub_items AS SELECT * FROM src.items WHERE ${pub}`);
    db.exec(`CREATE TEMP VIEW pub_comments AS SELECT * FROM src.comments WHERE ${pub}`);
    db.exec(`CREATE TEMP VIEW pub_embeddings AS SELECT * FROM src.item_embeddings WHERE ${pub}`);
    // Items: the new or changed ones are replaced as a whole; the gone ones are deleted.
    db.exec(`CREATE TEMP TABLE chg AS SELECT s.repo, s.number FROM pub_items s LEFT JOIN main.items m ON m.repo = s.repo AND m.number = s.number
      WHERE m.number IS NULL OR ${differs("m", "s", ITEM_COLUMNS)}`);
    db.exec(`CREATE TEMP TABLE gone AS SELECT repo, number FROM main.items WHERE (repo, number) NOT IN (SELECT repo, number FROM pub_items)`);
    changed.items = (db.prepare("SELECT (SELECT COUNT(*) FROM chg) + (SELECT COUNT(*) FROM gone) AS n").get() as { n: number }).n;
    if (changed.items) {
      db.exec("DELETE FROM main.items WHERE (repo, number) IN (SELECT repo, number FROM chg) OR (repo, number) IN (SELECT repo, number FROM gone)");
      db.exec(`INSERT INTO main.items (${ITEM_COLUMNS.join(",")}) SELECT ${ITEM_COLUMNS.map((c) => `s.${c}`).join(",")} FROM pub_items s JOIN chg USING (repo, number)`);
    }
    // Comments and reviews, by id.
    const cc = COMMENT_COLUMNS.filter((c) => c !== "id");
    db.exec(`CREATE TEMP TABLE cchg AS SELECT s.id FROM pub_comments s LEFT JOIN main.comments m ON m.id = s.id WHERE m.id IS NULL OR ${differs("m", "s", cc)}`);
    db.exec("CREATE TEMP TABLE cgone AS SELECT id FROM main.comments WHERE id NOT IN (SELECT id FROM pub_comments)");
    changed.comments = (db.prepare("SELECT (SELECT COUNT(*) FROM cchg) + (SELECT COUNT(*) FROM cgone) AS n").get() as { n: number }).n;
    if (changed.comments) {
      db.exec("DELETE FROM main.comments WHERE id IN (SELECT id FROM cchg) OR id IN (SELECT id FROM cgone)");
      db.exec(`INSERT INTO main.comments (${COMMENT_COLUMNS.join(",")}) SELECT ${COMMENT_COLUMNS.map((c) => `s.${c}`).join(",")} FROM pub_comments s JOIN cchg USING (id)`);
    }
    // Embeddings, by item and write time.
    db.exec(`CREATE TEMP TABLE echg AS SELECT s.repo, s.number FROM pub_embeddings s LEFT JOIN main.item_embeddings m ON m.repo = s.repo AND m.number = s.number
      WHERE m.number IS NULL OR m.at IS NOT s.at OR m.model IS NOT s.model`);
    db.exec("CREATE TEMP TABLE egone AS SELECT repo, number FROM main.item_embeddings WHERE (repo, number) NOT IN (SELECT repo, number FROM pub_embeddings)");
    changed.embeddings = (db.prepare("SELECT (SELECT COUNT(*) FROM echg) + (SELECT COUNT(*) FROM egone) AS n").get() as { n: number }).n;
    if (changed.embeddings) {
      db.exec("DELETE FROM main.item_embeddings WHERE (repo, number) IN (SELECT repo, number FROM echg) OR (repo, number) IN (SELECT repo, number FROM egone)");
      db.exec("INSERT INTO main.item_embeddings (repo, number, model, at, vec) SELECT s.repo, s.number, s.model, s.at, s.vec FROM pub_embeddings s JOIN echg USING (repo, number)");
    }
    // Decision outcomes are few: replaced when the set differs.
    const rows = db.prepare(`SELECT kind, repo, number, items, options, answer, exceptions, answered_at FROM src.decisions
      WHERE answer IS NOT NULL AND answered_at IS NOT NULL`).all() as unknown as DecisionRow[];
    const have = new Set((db.prepare("SELECT repo, number FROM main.items").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
    const want = outcomes(rows).filter((o) => have.has(`${o.repo}#${o.number}`)).map((o) => [o.repo, o.number, o.kind, o.answer, o.label, o.at] as const);
    const key = (xs: readonly (readonly unknown[])[]) => JSON.stringify([...xs].map((x) => JSON.stringify(x)).sort());
    const current = (db.prepare("SELECT repo, number, kind, answer, answer_label, answered_at FROM main.decision_outcomes").all() as Record<string, unknown>[]).map((r) => Object.values(r));
    if (key(want) !== key(current)) {
      db.exec("DELETE FROM main.decision_outcomes");
      const ins = db.prepare("INSERT INTO main.decision_outcomes (repo, number, kind, answer, answer_label, answered_at) VALUES (?,?,?,?,?,?)");
      for (const w of want) ins.run(...w);
      changed.items += 1;
    }
    if (changed.items || changed.comments || changed.embeddings) db.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshed_at', ?)").run(new Date().toISOString());
    const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n);
    const counts = { items: n("items"), comments: n("comments") };
    db.exec("COMMIT");
    db.close();
    if (rebuilt) renameSync(target, dest);
    return { ...counts, bytes: statSync(dest).size, rebuilt, changed };
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    if (rebuilt) rmSync(target, { force: true });
    throw e;
  }
}

function hasVersion(file: string): boolean {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value === SCHEMA_VERSION;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Rebuilds the snapshot after a sync that changed something; a failure is logged, never thrown into the sync. */
export function refreshSnapshot(log: (line: string) => void = console.log): void {
  try {
    const r = writeSnapshot();
    log(`item snapshot${r.rebuilt ? " (rebuilt)" : ""}: ${r.items} items, ${r.comments} comments, changed ${r.changed.items}/${r.changed.comments}/${r.changed.embeddings} (items/comments/embeddings), ${Math.round(r.bytes / 1e6)} MB`);
  } catch (e) {
    log(`item snapshot failed: ${String((e as Error).message).slice(0, 200)}`);
  }
}
