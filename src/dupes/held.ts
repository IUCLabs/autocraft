// Items held back from the later stages while a duplicate decision about them
// is open or was answered "close as duplicate". An answer of "not a duplicate"
// or "keep both" releases them. No Node imports besides the type.
import type { DatabaseSync } from "node:sqlite";
import { pilotSql } from "../pilot.ts";

/** The fact line that names the original; the act step reads it. */
export const DUP_FACT = "duplicate of ";
/** Option keys of a duplicate decision. */
export const DUP_OPTIONS = {
  close: { key: "close", label: "Close as duplicate", hint: "Post a short comment naming the original and close the item." },
  distinct: { key: "distinct", label: "Not a duplicate", hint: "The two are different; do not ask about this pair again." },
  keep: { key: "keep", label: "Keep both", hint: "They overlap but both stay open; do not ask about this pair again." },
} as const;

/** SQL condition, true when the item `alias` (a row of items) is not an integration batch PR the pipeline opened itself (see src/merge/batch.ts). Such PRs only carry reviewed PRs and never enter the pipeline as contributor PRs. */
export const notOwnIntegrationSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM main.merge_batches mb WHERE mb.repo = ${alias}.repo AND mb.pr_number = ${alias}.number
    AND ${alias}.author = (SELECT value FROM main.settings WHERE key = 'pipeline_login'))`;

/** SQL condition, true when the item `alias` (a row of items) is not held by a duplicate decision, is not one of our integration PRs and is in the pilot (when one is set). For WHERE clauses of candidate queries. */
export const notHeldSql = (alias: string): string =>
  `${notOwnIntegrationSql(alias)} AND ${pilotSql(alias)} AND NOT EXISTS (SELECT 1 FROM decisions dh WHERE dh.kind = 'duplicate' AND dh.repo = ${alias}.repo AND dh.number = ${alias}.number AND (dh.answer IS NULL OR dh.answer = 'close'))`;

export function duplicateHeld(db: DatabaseSync, repo: string, number: number): boolean {
  return !!db.prepare(`SELECT 1 FROM decisions WHERE kind = 'duplicate' AND repo = ? AND number = ? AND (answer IS NULL OR answer = 'close')`).get(repo, number);
}

/** Open duplicates pointing at the canonical item: items held by a decision that names it as the original. */
export function duplicateCount(db: DatabaseSync, repo: string, canonical: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'duplicate' AND repo = ? AND (answer IS NULL OR answer = 'close')
    AND EXISTS (SELECT 1 FROM json_each(facts) WHERE value = ?)`).get(repo, `${DUP_FACT}${repo}#${canonical}`) as { n: number }).n;
}
