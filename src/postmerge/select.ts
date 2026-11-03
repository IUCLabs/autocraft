// Which merged PRs still need a post-merge review and which defects still need an issue, from the local tables only.
import type { DatabaseSync } from "node:sqlite";
import { pilotSqlFor } from "../pilot.ts";
import type { Finding } from "./parse.ts";

/** A review that failed with a `retry:` error is tried again after this long. */
export const RETRY_AFTER_MS = 3600_000;
export const SINCE_KEY = "postmerge_since";

export type MergedPr = { repo: string; number: number; head_oid: string; merged_at: string; method: string | null };

export const sinceOf = (db: DatabaseSync): string =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(SINCE_KEY) as { value: string } | undefined)?.value ?? "9999";

/**
 * PRs a pipeline merge landed (`merges` rows with outcome merged) since the `postmerge_since` setting, in the pilot, without a
 * stored review, oldest merge first. A review stored with a `retry:` error counts as missing an hour after it failed.
 */
export function selectPostmerge(db: DatabaseSync, repo: string, now = Date.now()): MergedPr[] {
  return db.prepare(`SELECT m.repo, m.number,
      (SELECT x.head_oid FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS head_oid,
      MIN(m.at) AS merged_at,
      (SELECT x.method FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS method
    FROM merges m
    WHERE m.repo = :repo AND m.outcome = 'merged' AND m.at >= :since AND ${pilotSqlFor("m.repo", "m.number")}
      AND NOT EXISTS (SELECT 1 FROM postmerge_reviews r WHERE r.repo = m.repo AND r.number = m.number
        AND (r.error IS NULL OR r.error NOT LIKE 'retry:%' OR r.at > :retry))
    GROUP BY m.repo, m.number ORDER BY merged_at, m.number`).all({ repo, since: sinceOf(db), retry: new Date(now - RETRY_AFTER_MS).toISOString() }) as MergedPr[];
}

/** The merged PR `repo#number`, whatever its review state, or null when the pipeline did not merge it. */
export function mergedPr(db: DatabaseSync, repo: string, number: number): MergedPr | null {
  return (db.prepare(`SELECT m.repo, m.number,
      (SELECT x.head_oid FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS head_oid,
      MIN(m.at) AS merged_at,
      (SELECT x.method FROM merges x WHERE x.repo = m.repo AND x.number = m.number AND x.outcome = 'merged' ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS method
    FROM merges m WHERE m.repo = ? AND m.number = ? AND m.outcome = 'merged' GROUP BY m.repo, m.number`).get(repo, number) as MergedPr | undefined) ?? null;
}

export type StoredReview = { repo: string; number: number; merge_sha: string; at: string; model: string | null; error: string | null; findings: Finding[] };

export function parseStored(json: string | null): Finding[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch { return []; }
}

export function reviewOf(db: DatabaseSync, repo: string, number: number): StoredReview | null {
  const r = db.prepare("SELECT repo, number, merge_sha, at, model, error, findings FROM postmerge_reviews WHERE repo = ? AND number = ?").get(repo, number) as
    { repo: string; number: number; merge_sha: string; at: string; model: string | null; error: string | null; findings: string | null } | undefined;
  return r ? { ...r, findings: parseStored(r.findings) } : null;
}

export type FollowupState = "filed" | "skipped-duplicate" | "skipped-limit" | "skipped-minor";
export type Followup = { repo: string; number: number; review_at: string; finding: number; title: string; issue_number: number | null; url: string | null; state: FollowupState; at: string };

export function followupsOf(db: DatabaseSync, repo: string, number: number): Followup[] {
  return db.prepare("SELECT repo, number, review_at, finding, title, issue_number, url, state, at FROM postmerge_followups WHERE repo = ? AND number = ? ORDER BY review_at, finding").all(repo, number) as Followup[];
}

export type PendingDefect = { repo: string; number: number; review_at: string; finding: number; f: Finding; model: string | null };

/**
 * Defects with no duplicate that no issue was filed for yet, oldest review first. A PR whose review was replaced
 * (`--again`) is judged by its latest review; a defect whose title an issue was already filed for is not filed again.
 */
export function pendingDefects(db: DatabaseSync, repo: string): PendingDefect[] {
  const rows = db.prepare(`SELECT r.repo, r.number, r.at, r.model, r.findings FROM postmerge_reviews r
    WHERE r.repo = ? AND r.error IS NULL AND ${pilotSqlFor("r.repo", "r.number")} ORDER BY r.at, r.number`).all(repo) as { repo: string; number: number; at: string; model: string | null; findings: string | null }[];
  const out: PendingDefect[] = [];
  for (const r of rows) {
    const rows2 = followupsOf(db, r.repo, r.number);
    const filedTitles = new Set(rows2.filter((x) => x.state === "filed").map((x) => x.title.toLowerCase()));
    parseStored(r.findings).forEach((f, i) => {
      if (f.severity !== "defect" || f.duplicate_of !== null) return;
      if (rows2.some((x) => x.review_at === r.at && x.finding === i && x.state === "filed")) return;
      if (filedTitles.has(f.title.toLowerCase())) return;
      out.push({ repo: r.repo, number: r.number, review_at: r.at, finding: i, f, model: r.model });
    });
  }
  return out;
}
