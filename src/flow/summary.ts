// The per-repo flowchart summary (table flow_summary): refreshed by the runner
// for repos whose data changed, read and added up by GET /api/flow.
import type { DatabaseSync } from "node:sqlite";
import { trackedNames } from "../repos.ts";
import { countAll, type Counts } from "./count.ts";

/** A row older than this is counted again even when nothing changed: the 24-hour windows move. */
export const MAX_AGE_MS = 10 * 60_000;
const MARKS_KEY = "flow_summary_marks";

type Marks = { items: string; cls: number; stages: number; reviews: number; merges: number; checks: string; global: string };

const getMarks = (db: DatabaseSync): Marks | null => {
  const v = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(MARKS_KEY) as { value: string } | undefined)?.value;
  try { return v ? (JSON.parse(v) as Marks) : null; } catch { return null; }
};

/** Per repo, a signature of its decisions; a batch (repo NULL) counts for each repo it names. */
function decisionSigs(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare(`SELECT COALESCE(d.repo, json_extract(j.value, '$.repo')) AS repo,
      COUNT(*) || ':' || COUNT(d.answer) || ':' || COALESCE(MAX(d.answered_at), '') || ':' || COALESCE(MAX(d.asked_at), '') || ':' || COALESCE(SUM(length(d.answer)), 0) AS sig
    FROM main.decisions d LEFT JOIN json_each(CASE WHEN d.repo IS NULL AND json_valid(d.items) THEN d.items ELSE '[]' END) j
    GROUP BY 1`).all() as { repo: string | null; sig: string }[];
  return new Map(rows.filter((r) => r.repo).map((r) => [r.repo!, r.sig]));
}

/** Settings that change every repo's counts: the classification run, label approvals and the tracked set. */
const globalSig = (db: DatabaseSync): string => JSON.stringify(db.prepare(`SELECT
    (SELECT value FROM main.settings WHERE key = 'classify_run') AS run,
    (SELECT group_concat(key || '=' || value) FROM main.settings WHERE key LIKE 'labels_approved:%') AS approvals,
    (SELECT group_concat(name) FROM (SELECT name FROM main.tracked_repos ORDER BY name)) AS tracked,
    (SELECT run_id FROM main.classifications WHERE classifier = 'jev' ORDER BY at DESC LIMIT 1) AS jev`).get());

/** Marks the repos whose data changed since the last call as stale, and moves the marks. */
export function markChanged(db: DatabaseSync): number {
  const prev = getMarks(db);
  const cur: Marks = db.prepare(`SELECT
      COALESCE((SELECT MAX(updated_at) FROM main.items), '') AS items,
      COALESCE((SELECT MAX(rowid) FROM main.classifications), 0) AS cls,
      COALESCE((SELECT MAX(rowid) FROM main.stages), 0) AS stages,
      COALESCE((SELECT MAX(rowid) FROM main.reviews), 0) AS reviews,
      COALESCE((SELECT MAX(rowid) FROM main.merges), 0) AS merges,
      COALESCE((SELECT MAX(fetched_at) FROM main.pr_checks), '') AS checks`).get() as Marks;
  cur.global = globalSig(db);
  const dirty = new Set<string>();
  let all = !prev || prev.global !== cur.global;
  if (!all && prev) {
    const add = (sql: string, ...p: (string | number)[]) => {
      for (const r of db.prepare(sql).all(...p) as { repo: string }[]) dirty.add(r.repo);
    };
    add("SELECT DISTINCT repo FROM main.items INDEXED BY items_updated WHERE updated_at > ?", prev.items);
    add("SELECT DISTINCT repo FROM main.classifications WHERE rowid > ?", prev.cls);
    add("SELECT DISTINCT repo FROM main.stages WHERE rowid > ?", prev.stages);
    add("SELECT DISTINCT repo FROM main.reviews WHERE rowid > ?", prev.reviews);
    add("SELECT DISTINCT repo FROM main.merges WHERE rowid > ?", prev.merges);
    add("SELECT DISTINCT repo FROM main.pr_checks WHERE fetched_at > ?", prev.checks);
    const sigs = decisionSigs(db);
    for (const r of db.prepare("SELECT repo, decisions_sig FROM main.flow_summary").all() as { repo: string; decisions_sig: string | null }[]) {
      if ((sigs.get(r.repo) ?? null) !== r.decisions_sig) dirty.add(r.repo);
    }
  }
  if (all) db.exec("UPDATE main.flow_summary SET stale = 1");
  else if (dirty.size) db.prepare("UPDATE main.flow_summary SET stale = 1 WHERE repo IN (SELECT value FROM json_each(?))").run(JSON.stringify([...dirty]));
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MARKS_KEY, JSON.stringify(cur));
  return all ? -1 : dirty.size;
}

/** Counts one repo and stores its row. */
export function countRepo(db: DatabaseSync, repo: string, now = Date.now()): Counts {
  const counts = countAll(db, repo, now).counts;
  db.prepare(`INSERT INTO main.flow_summary (repo, counts, counted_at, stale, decisions_sig) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (repo) DO UPDATE SET counts = excluded.counts, counted_at = excluded.counted_at, stale = 0, decisions_sig = excluded.decisions_sig`)
    .run(repo, JSON.stringify(counts), new Date(now).toISOString(), decisionSigs(db).get(repo) ?? null);
  return counts;
}

/**
 * One refresh pass for the runner: marks changed repos, then counts the
 * missing, stale and oldest rows (beyond MAX_AGE_MS) until `budgetMs` is used.
 * Returns the repos counted.
 */
export function refreshSummary(db: DatabaseSync, budgetMs = 1500): string[] {
  const start = Date.now();
  markChanged(db);
  db.exec("DELETE FROM main.flow_summary WHERE repo NOT IN (SELECT name FROM main.tracked_repos)");
  const have = new Map((db.prepare("SELECT repo, counted_at, stale FROM main.flow_summary").all() as { repo: string; counted_at: string; stale: number }[]).map((r) => [r.repo, r]));
  const old = new Date(start - MAX_AGE_MS).toISOString();
  const due = trackedNames(db)
    .map((repo) => ({ repo, row: have.get(repo) }))
    .filter((x) => !x.row || x.row.stale || x.row.counted_at < old)
    .sort((a, b) => (a.row ? (a.row.stale ? 1 : 2) : 0) - (b.row ? (b.row.stale ? 1 : 2) : 0) || (a.row?.counted_at ?? "").localeCompare(b.row?.counted_at ?? ""));
  const done: string[] = [];
  for (const { repo } of due) {
    if (done.length && Date.now() - start > budgetMs) break;
    countRepo(db, repo);
    done.push(repo);
  }
  return done;
}

/**
 * The summed counts of every tracked repo, or of one. A repo without a row yet
 * is counted here while `budgetMs` lasts; the rest are left to the runner and
 * listed in `uncounted`.
 */
export function readSummary(db: DatabaseSync, repo: string | null, budgetMs = 150): { counts: Counts; countedAt: string | null; uncounted: string[] } {
  const start = Date.now();
  const want = repo ? [repo] : trackedNames(db);
  const rows = new Map((db.prepare("SELECT repo, counts, counted_at FROM main.flow_summary").all() as { repo: string; counts: string; counted_at: string }[]).map((r) => [r.repo, r]));
  const sum: Counts = {};
  const uncounted: string[] = [];
  let oldest: string | null = null;
  for (const r of want) {
    const row = rows.get(r);
    if (!row && Date.now() - start > budgetMs) {
      uncounted.push(r);
      continue;
    }
    const counts = row ? (JSON.parse(row.counts) as Counts) : countRepo(db, r);
    const at = row?.counted_at ?? new Date().toISOString();
    if (!oldest || at < oldest) oldest = at;
    for (const [k, v] of Object.entries(counts)) sum[k] = (sum[k] ?? 0) + v;
  }
  return { counts: sum, countedAt: oldest, uncounted };
}
