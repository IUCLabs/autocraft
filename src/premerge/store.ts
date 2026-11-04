// Pre-merge review results (table premerge_reviews): one row per PR head, read by the merge queue.
import type { DatabaseSync } from "node:sqlite";
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";

/** A failed head counts as failed after this many tries. */
export { PREMERGE_MAX_TRIES };

export type { PremergeFinding } from "./types.ts";
import type { PremergeFinding } from "./types.ts";
import type { StatementConflict } from "../review/opus-parse.ts";

export type PremergeRow = {
  repo: string; number: number; head_oid: string;
  /** When the row was last written (a review or a failed try). */
  at: string;
  run_id: string | null; model: string | null;
  /** JSON PremergeFinding[]; null while no try has produced a review. */
  findings: string | null;
  /** What the reviewer searched, as free text. */
  searched: string | null;
  /** JSON StatementConflict[]; null when none. */
  conflicts: string | null;
  /** Why the last try stored no review; null once a review is stored. */
  error: string | null;
  tries: number;
};

export type PremergeSave = {
  repo: string; number: number; head: string; at: string;
  runId?: string | null; model?: string | null;
  /** A stored review. Without it, `error` records a failed try. */
  findings?: PremergeFinding[];
  searched?: string | null;
  /** The statements the review named as conflicts (a stored review only). */
  conflicts?: StatementConflict[];
  error?: string | null;
  /** The failure is final: no more tries (the head cannot be reviewed at all). */
  final?: boolean;
};

/** Stores a review (clears the error) or counts a failed try. */
export function savePremerge(db: DatabaseSync, s: PremergeSave): void {
  const args = [s.repo, s.number, s.head, s.at, s.runId ?? null, s.model ?? null] as const;
  if (s.findings) {
    db.prepare(`INSERT INTO premerge_reviews (repo, number, head_oid, at, run_id, model, findings, searched, conflicts, error, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT (repo, number, head_oid) DO UPDATE SET at = excluded.at, run_id = excluded.run_id, model = excluded.model,
        findings = excluded.findings, searched = excluded.searched, conflicts = excluded.conflicts, error = NULL`).run(...args, JSON.stringify(s.findings), s.searched ?? null, s.conflicts?.length ? JSON.stringify(s.conflicts) : null);
    return;
  }
  db.prepare(`INSERT INTO premerge_reviews (repo, number, head_oid, at, run_id, model, error, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number, head_oid) DO UPDATE SET at = excluded.at, run_id = excluded.run_id, model = excluded.model,
      error = excluded.error, tries = CASE WHEN ? THEN excluded.tries ELSE tries + 1 END`).run(...args, s.error ?? "failed", s.final ? PREMERGE_MAX_TRIES : 1, s.final ? 1 : 0);
}

export function premergeAt(db: DatabaseSync, repo: string, number: number, head: string): PremergeRow | null {
  return (db.prepare("SELECT * FROM premerge_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, number, head) as PremergeRow | undefined) ?? null;
}

/** The PR already had a pre-merge fix round (any fixups row with source premerge, pushed or not). */
export function premergeFixUsed(db: DatabaseSync, repo: string, number: number): boolean {
  return !!db.prepare("SELECT 1 FROM fixups WHERE repo = ? AND number = ? AND source = 'premerge' AND state NOT IN ('linting', 'superseded') LIMIT 1").get(repo, number);
}

/** Findings of a stored row; empty when none or unreadable. */
export function findingsOf(row: PremergeRow | null): PremergeFinding[] {
  try { return row?.findings ? (JSON.parse(row.findings) as PremergeFinding[]) : []; } catch { return []; }
}
