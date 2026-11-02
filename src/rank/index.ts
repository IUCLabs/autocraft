// craft-auto rank [show <repo> <n>]: the work score of open items (src/rank/score.ts).
//
// Reads the stored priority, the settled classification and the size; calls no model. The rank step
// rewrites the item_rank row of every open item in a tracked repo and removes the rows of the others.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { connect } from "../db.ts";
import { isSize, rankOf, sizeOfLines, type RankBreakdown, type RankInput, type Size } from "./score.ts";

const now = () => new Date().toISOString();

/** A rank older than this is recomputed even when nothing is missing, so size and priority changes arrive. */
export const RANK_STALE_MS = 30 * 60_000;

/** Open tracked items without a rank row, or the oldest row older than RANK_STALE_MS. Read-only, for the autopilot. */
export function rankDue(db: DatabaseSync, nowMs: number = Date.now()): boolean {
  const missing = db.prepare(`SELECT 1 FROM items i JOIN tracked_repos t ON t.name = i.repo LEFT JOIN item_rank r ON r.repo = i.repo AND r.number = i.number
    WHERE i.state = 'OPEN' AND r.repo IS NULL LIMIT 1`).get();
  if (missing) return true;
  const oldest = (db.prepare("SELECT MIN(computed_at) AS at FROM item_rank").get() as { at: string | null }).at;
  return oldest !== null && nowMs - Date.parse(oldest) > RANK_STALE_MS;
}

type ItemRow = { repo: string; number: number; kind: string; lines: number | null; priority: number | null; fix_size: string | null };

/** Size of an item: the fix triage's estimate for an issue, the changed lines for a PR. */
export function sizeOfItem(kind: string, lines: number | null, fixSize: string | null): Pick<RankInput, "size" | "sizeSource"> {
  if (kind === "issue") return isSize(fixSize) ? { size: fixSize, sizeSource: "triage" } : { size: null, sizeSource: "default" };
  return lines === null ? { size: null, sizeSource: "default" } : { size: sizeOfLines(lines), sizeSource: "lines" };
}

/** Recomputes the rank of every open item in a tracked repo. Returns the number of rows written or changed. */
export function runRank(db: DatabaseSync, nowMs: number = Date.now()): { items: number; changed: number; removed: number } {
  const settled = settledLookup(db, latestRun(db));
  const rows = db.prepare(`SELECT i.repo, i.number, i.kind,
      CASE WHEN i.kind = 'pr' AND (i.additions IS NOT NULL OR i.deletions IS NOT NULL) THEN COALESCE(i.additions, 0) + COALESCE(i.deletions, 0) END AS lines,
      p.score AS priority, f.size AS fix_size
    FROM items i JOIN tracked_repos t ON t.name = i.repo
    LEFT JOIN item_priority p ON p.repo = i.repo AND p.number = i.number
    LEFT JOIN fix_attempts f ON f.repo = i.repo AND f.number = i.number
    WHERE i.state = 'OPEN'`).all() as unknown as ItemRow[];
  const old = new Map((db.prepare("SELECT repo, number, score, breakdown FROM item_rank").all() as { repo: string; number: number; score: number; breakdown: string }[])
    .map((r) => [`${r.repo}#${r.number}`, r]));
  const put = db.prepare(`INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET score = excluded.score, breakdown = excluded.breakdown, computed_at = excluded.computed_at`);
  const at = new Date(nowMs).toISOString();
  let changed = 0;
  const keep = new Set<string>();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      const s = settled(r.repo, r.number);
      const { score, breakdown } = rankOf({ priority: r.priority, label: s.label, security: s.flags.includes("security"), ...sizeOfItem(r.kind, r.lines, r.fix_size) });
      const k = `${r.repo}#${r.number}`, json = JSON.stringify(breakdown);
      keep.add(k);
      const prev = old.get(k);
      if (!prev || prev.score !== score || prev.breakdown !== json) changed++;
      put.run(r.repo, r.number, score, json, at);
    }
    let removed = 0;
    const del = db.prepare("DELETE FROM item_rank WHERE repo = ? AND number = ?");
    for (const [k, r] of old) if (!keep.has(k)) { del.run(r.repo, r.number); removed++; }
    db.exec("COMMIT");
    return { items: rows.length, changed, removed };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type RankRow = { repo: string; number: number; score: number; breakdown: RankBreakdown; computedAt: string };

export function rankOfItem(db: DatabaseSync, repo: string, number: number): RankRow | null {
  const r = db.prepare("SELECT score, breakdown, computed_at FROM item_rank WHERE repo = ? AND number = ?").get(repo, number) as { score: number; breakdown: string; computed_at: string } | undefined;
  return r ? { repo, number, score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown, computedAt: r.computed_at } : null;
}

export const commands = {
  rank: {
    summary: "rank [show <repo> <n>]: recompute the work score of open items; show prints one item's score and its parts",
    run(args: string[]): void {
      const db = connect();
      if (args[0] === "show") {
        const repo = args[1], n = Number(args[2]);
        if (!repo || !Number.isInteger(n)) throw new Error("usage: rank show <repo> <n>");
        const r = rankOfItem(db, repo, n);
        if (!r) { console.log(`${repo}#${n}: no rank (not open, or the rank step has not run)`); return; }
        console.log(`${repo}#${n}: ${r.score} (computed ${r.computedAt})`);
        const b = r.breakdown;
        console.log(`  priority  ${String(b.priority.value ?? "none")} -> ${b.priority.points}`);
        console.log(`  type      ${String(b.type.value ?? "none")} -> ${b.type.points}`);
        console.log(`  size      ${String(b.size.value)} (${b.size.source}) -> ${b.size.points}`);
        console.log(`  security  ${String(b.security.value)} -> ${b.security.points}`);
        return;
      }
      if (args.length) throw new Error("usage: rank | rank show <repo> <n>");
      const r = runRank(db);
      console.log(`${r.items} open items ranked, ${r.changed} changed, ${r.removed} removed`);
    },
  },
};

export type { Size };
