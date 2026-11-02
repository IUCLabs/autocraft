// Shared queries for the Progress, Repo and Run and cost pages.
import type { DatabaseSync } from "node:sqlite";
import { getRule, STATS_SQL, TIER_LABEL, TIER_SQL, type Tier } from "../../whitelist.ts";

// Latest stage row per item (latest wins; rowid breaks ties at the same time).
export const LATEST_SQL = `latest AS (
  SELECT repo, number, stage FROM (
    SELECT repo, number, stage, ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) AS rn FROM stages %W
  ) WHERE rn = 1)`;

export const latestCte = (repo?: string): string => LATEST_SQL.replace("%W", repo ? "WHERE repo = :repo" : "");

// One classification per item: the owner's, else Sonnet's, else Haiku's, else the newest other.
export const PREF_ORDER = "CASE classifier WHEN 'owner' THEN 0 WHEN 'sonnet' THEN 1 WHEN 'haiku' THEN 2 ELSE 3 END, at DESC";

export function runStart(db: DatabaseSync): string {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'run_started_at'").get() as { value: string } | undefined;
  if (r?.value) return r.value;
  const s = db.prepare("SELECT MIN(at) AS at FROM stages").get() as { at: string | null };
  return s.at ?? new Date(Date.now() - 7 * 86400_000).toISOString();
}

const p = (repo?: string, extra: Record<string, string | number> = {}): Record<string, string | number> => (repo ? { repo, ...extra } : extra);

export type FunnelRow = {
  repo: string; open: number; classified: number; reviewed: number;
  take: number; hold: number; close: number; needs_decision: number; batched: number;
};

export function funnelByRepo(db: DatabaseSync, repo?: string): FunnelRow[] {
  return db.prepare(`WITH ${latestCte(repo)}
    SELECT i.repo, COUNT(*) AS open,
      SUM(EXISTS (SELECT 1 FROM classifications c WHERE c.repo = i.repo AND c.number = i.number)) AS classified,
      SUM(EXISTS (SELECT 1 FROM stages s WHERE s.repo = i.repo AND s.number = i.number AND s.stage = 'reviewed')
       OR EXISTS (SELECT 1 FROM classifications c WHERE c.repo = i.repo AND c.number = i.number AND c.classifier = 'sonnet')) AS reviewed,
      SUM(l.stage = 'take') AS take, SUM(l.stage = 'hold') AS hold, SUM(l.stage = 'close') AS close,
      SUM(l.stage = 'needs-decision') AS needs_decision, SUM(l.stage = 'batched') AS batched
    FROM items i LEFT JOIN latest l ON l.repo = i.repo AND l.number = i.number
    WHERE i.state = 'OPEN' ${repo ? "AND i.repo = :repo" : ""}
    GROUP BY i.repo`).all(p(repo)).map((r) => ({ ...r, take: r.take ?? 0, hold: r.hold ?? 0, close: r.close ?? 0, needs_decision: r.needs_decision ?? 0, batched: r.batched ?? 0 })) as FunnelRow[];
}

export type DoneRow = { repo: string; merged_pipeline: number; closed_pipeline: number; closed_others: number; total: number };

// Done since run start. Merged PRs carry closed_at too, so one range covers both.
export function doneByRepo(db: DatabaseSync, start: string, repo?: string): DoneRow[] {
  return db.prepare(`WITH ${latestCte(repo)}, d AS (
      SELECT i.repo, i.state, l.stage FROM items i LEFT JOIN latest l ON l.repo = i.repo AND l.number = i.number
      WHERE i.closed_at >= :start AND i.state <> 'OPEN' ${repo ? "AND i.repo = :repo" : ""})
    SELECT repo,
      SUM(state = 'MERGED' AND stage = 'merged') AS merged_pipeline,
      SUM(state = 'CLOSED' AND stage IN ('closed', 'fixed-by-us')) AS closed_pipeline,
      COUNT(*) AS total
    FROM d GROUP BY repo`).all(p(repo, { start })).map((r) => {
      const x = r as Omit<DoneRow, "closed_others">;
      return { ...x, closed_others: x.total - x.merged_pipeline - x.closed_pipeline };
    });
}

export function donePerHour(db: DatabaseSync, repo?: string): number {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const r = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE closed_at >= :since AND state <> 'OPEN' ${repo ? "AND repo = :repo" : ""}`).get(p(repo, { since })) as { n: number };
  return r.n / 24;
}

export type Bucket = { key: string; n: number };

export const SIZE_SQL = `CASE WHEN kind = 'issue' THEN 'issue'
  WHEN COALESCE(additions,0) + COALESCE(deletions,0) <= 50 THEN 'S'
  WHEN COALESCE(additions,0) + COALESCE(deletions,0) <= 300 THEN 'M'
  WHEN COALESCE(additions,0) + COALESCE(deletions,0) <= 1000 THEN 'L' ELSE 'XL' END`;

export const SIZE_ORDER = ["S", "M", "L", "XL", "issue"];

export function breakdowns(db: DatabaseSync, repo?: string): { type: Bucket[]; size: Bucket[]; tier: Bucket[] } {
  const w = `i.state = 'OPEN' ${repo ? "AND i.repo = :repo" : ""}`;
  const type = db.prepare(`SELECT COALESCE((SELECT type_label FROM classifications c WHERE c.repo = i.repo AND c.number = i.number
      ORDER BY ${PREF_ORDER} LIMIT 1), 'not classified') AS key, COUNT(*) AS n
    FROM items i WHERE ${w} GROUP BY key ORDER BY n DESC`).all(p(repo)) as Bucket[];
  const size = (db.prepare(`SELECT ${SIZE_SQL} AS key, COUNT(*) AS n FROM items i WHERE ${w} GROUP BY key`).all(p(repo)) as Bucket[])
    .sort((a, b) => SIZE_ORDER.indexOf(a.key) - SIZE_ORDER.indexOf(b.key));
  const rule = getRule(db);
  const tier = (db.prepare(`WITH s AS (${STATS_SQL} GROUP BY author),
      a AS (SELECT i.author, COUNT(*) AS n FROM items i WHERE ${w} GROUP BY i.author),
      j AS (SELECT a.n, COALESCE(s.merged, 0) AS merged, COALESCE(s.closed, 0) AS closed, o.status AS override
            FROM a LEFT JOIN s ON s.login = a.author LEFT JOIN whitelist_overrides o ON o.login = a.author)
    SELECT ${TIER_SQL} AS key, SUM(n) AS n FROM j GROUP BY key ORDER BY n DESC`).all(p(repo, { min_merged: rule.minMerged, min_rate: rule.minRate })) as Bucket[])
    .map((b) => ({ key: TIER_LABEL[b.key as Tier] ?? b.key, n: b.n }));
  return { type, size, tier };
}

// Open items per repo per day since run start, rebuilt backwards from the
// current open count and the created/closed dates.
export function trend(db: DatabaseSync, start: string, openNow: Map<string, number>, repo?: string): { days: string[]; series: Map<string, number[]> } {
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = [];
  for (let t = Date.parse(start.slice(0, 10)); ; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d);
    if (d >= today || days.length > 365) break;
  }
  const r = repo ? "AND repo = :repo" : "";
  const created = db.prepare(`SELECT repo, substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM items WHERE created_at >= :start ${r} GROUP BY repo, d`).all(p(repo, { start })) as { repo: string; d: string; n: number }[];
  const closed = db.prepare(`SELECT repo, substr(closed_at, 1, 10) AS d, COUNT(*) AS n FROM items WHERE closed_at >= :start AND state <> 'OPEN' ${r} GROUP BY repo, d`).all(p(repo, { start })) as { repo: string; d: string; n: number }[];
  const delta = new Map<string, Map<string, number>>();
  const add = (repo: string, d: string, n: number) => {
    if (!delta.has(repo)) delta.set(repo, new Map());
    const m = delta.get(repo)!;
    m.set(d, (m.get(d) ?? 0) + n);
  };
  for (const x of created) add(x.repo, x.d, x.n);
  for (const x of closed) add(x.repo, x.d, -x.n);
  const series = new Map<string, number[]>();
  for (const name of new Set([...openNow.keys(), ...delta.keys()])) {
    const m = delta.get(name) ?? new Map<string, number>();
    // value at the end of each day; walk back from today's open count
    const out = new Array<number>(days.length);
    let v = openNow.get(name) ?? 0;
    for (let k = days.length - 1; k >= 0; k--) {
      out[k] = v;
      v -= m.get(days[k]) ?? 0;
    }
    series.set(name, out);
  }
  return { days, series };
}

export type DecisionCount = { repo: string; n: number };

// Open decisions per repo; a batch counts once for every repo it spans.
export function openDecisionsByRepo(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare("SELECT repo, number, items FROM decisions WHERE answer IS NULL").all() as { repo: string | null; number: number | null; items: string | null }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    let repos: string[] = r.repo && r.number !== null ? [r.repo] : [];
    if (r.number === null) {
      try {
        repos = [...new Set((JSON.parse(r.items ?? "[]") as { repo: string }[]).map((x) => x.repo))];
      } catch { /* malformed batch: counted nowhere */ }
    }
    for (const x of repos) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return m;
}
