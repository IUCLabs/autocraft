// The item snapshot: a read-only SQLite file with only GitHub-sourced data
// (items, comments, reviews, their full-text index, item embeddings) plus the
// outcome of each decision (kind, chosen option, date). Sandboxed model calls
// read it through the item tools (src/itemtools/server). Nothing written on the
// dashboard (notes, opinions, comments), no settings, audit, accounts, access
// lists, tokens or host paths goes in.
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
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

const DDL = `
CREATE TABLE items (${ITEM_COLUMNS.map((c) => (c === "repo" || c === "number" ? `${c} ${c === "repo" ? "TEXT" : "INTEGER"} NOT NULL` : c)).join(", ")}, PRIMARY KEY (repo, number));
CREATE TABLE comments (${COMMENT_COLUMNS.map((c) => (c === "id" ? "id TEXT PRIMARY KEY" : c === "number" ? "number INTEGER NOT NULL" : c)).join(", ")});
CREATE INDEX comments_item ON comments(repo, number);
CREATE TABLE item_embeddings (repo TEXT NOT NULL, number INTEGER NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (repo, number));
CREATE TABLE decision_outcomes (repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, answer TEXT NOT NULL, answer_label TEXT, answered_at TEXT);
CREATE INDEX decision_outcomes_item ON decision_outcomes(repo, number);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE comments_fts USING fts5(body, content='comments', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
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

/**
 * Copies the GitHub-sourced data of the mirror at `src` into a new file and
 * renames it over `dest`, so a reader sees the old or the new file, never a
 * half-written one. The source is only read.
 */
export function writeSnapshot(src: string = dbPath(), dest: string = snapshotFile()): { items: number; comments: number; bytes: number } {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    // A rollback journal keeps the file self-contained: a reader on a read-only mount needs no -wal or -shm file.
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec(DDL);
    db.prepare("ATTACH DATABASE ? AS src").run(`file:${encodeURI(src).replace(/\?/g, "%3F").replace(/#/g, "%23")}?mode=ro`);
    db.exec("BEGIN");
    db.exec(`INSERT INTO items (${ITEM_COLUMNS.join(",")}) SELECT ${ITEM_COLUMNS.join(",")} FROM src.items`);
    db.exec(`INSERT INTO comments (${COMMENT_COLUMNS.join(",")}) SELECT ${COMMENT_COLUMNS.join(",")} FROM src.comments`);
    db.exec(`INSERT INTO item_embeddings (repo, number, model, vec) SELECT repo, number, model, vec FROM src.item_embeddings`);
    const decisions = db.prepare(`SELECT kind, repo, number, items, options, answer, exceptions, answered_at FROM src.decisions
      WHERE answer IS NOT NULL AND answered_at IS NOT NULL`).all() as unknown as DecisionRow[];
    const ins = db.prepare("INSERT INTO decision_outcomes (repo, number, kind, answer, answer_label, answered_at) VALUES (?,?,?,?,?,?)");
    for (const o of outcomes(decisions)) ins.run(o.repo, o.number, o.kind, o.answer, o.label, o.at);
    db.exec("INSERT INTO items_fts (items_fts) VALUES ('rebuild')");
    db.exec("INSERT INTO comments_fts (comments_fts) VALUES ('rebuild')");
    db.prepare("INSERT INTO meta VALUES ('built_at', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
    db.exec("DETACH DATABASE src");
    const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const counts = { items: n("items"), comments: n("comments") };
    db.close();
    renameSync(tmp, dest);
    return { ...counts, bytes: statSync(dest).size };
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Rebuilds the snapshot after a sync that changed something; a failure is logged, never thrown into the sync. */
export function refreshSnapshot(log: (line: string) => void = console.log): void {
  try {
    const r = writeSnapshot();
    log(`item snapshot: ${r.items} items, ${r.comments} comments, ${Math.round(r.bytes / 1e6)} MB`);
  } catch (e) {
    log(`item snapshot failed: ${String((e as Error).message).slice(0, 200)}`);
  }
}
