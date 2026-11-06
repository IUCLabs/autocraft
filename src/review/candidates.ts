// The head commit of a PR as best known, the scope answers per item.
import { SETTLER_LOGINS_SQL } from "../settlers.ts";
import type { DatabaseSync } from "node:sqlite";
import { REVIEW_LABELS, sizeOf, type Size } from "../core/rules.ts";
export { REVIEW_LABELS, sizeOf, type Size };


function parseRefs(s: string | null): { repo: string; number: number; answer?: string }[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as { repo: string; number: number }[]) : [];
  } catch { return []; }
}

/**
 * The PR's head commit as best known: the checks table's when it was fetched
 * after the mirror last saw the PR change, else the mirror's.
 */
export function headOf(r: { head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null }): string | null {
  if (r.c_head && r.c_at && (!r.updated_at || r.c_at > r.updated_at)) return r.c_head;
  return r.head_oid ?? r.c_head;
}

/**
 * The answer of the latest answered scope decision per item ("repo#n"), for
 * every item at once: one query.
 */
export function scopeAnswers(db: DatabaseSync, operatorsOnly = false): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare(`SELECT repo, number, items, answer, exceptions FROM decisions
    WHERE kind = 'scope' AND answer IS NOT NULL AND NOT (answer = 'withdrawn' AND answered_by = 'pipeline') ${operatorsOnly ? "AND answered_by IN ${SETTLER_LOGINS_SQL}" : ""} ORDER BY answered_at DESC`).all() as
    { repo: string | null; number: number | null; items: string | null; answer: string; exceptions: string | null }[];
  for (const r of rows) {
    if (r.number !== null) {
      const k = `${r.repo}#${r.number}`;
      if (!out.has(k)) out.set(k, r.answer);
      continue;
    }
    const ex = new Map(parseRefs(r.exceptions).map((e) => [`${e.repo}#${e.number}`, e.answer]));
    for (const i of parseRefs(r.items)) {
      const k = `${i.repo}#${i.number}`;
      if (!out.has(k)) out.set(k, ex.get(k) ?? r.answer);
    }
  }
  return out;
}
