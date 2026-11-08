// The head commit of a PR as best known, the scope answers per item.
import { settledBySql } from "../settlers.ts";
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

const MAINTAINER_ANSWER = "answered_by IN (SELECT login FROM main.access WHERE role = 'maintainer')";

function scopeRows(db: DatabaseSync, extra: string): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare(`SELECT repo, number, items, answer, exceptions FROM decisions
    WHERE kind = 'scope' AND answer IS NOT NULL AND NOT (answer = 'withdrawn' AND answered_by = 'pipeline') ${extra} ORDER BY answered_at DESC`).all() as
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

/**
 * The answer of the latest answered scope decision per item ("repo#n"), for every item at once. A maintainer's answer
 * counts only while it is settled (src/settlers.ts); `operatorsOnly` keeps only answers whose answerer settles.
 */
export function scopeAnswers(db: DatabaseSync, operatorsOnly = false): Map<string, string> {
  // A disputed answer does not count until it is kept.
  return scopeRows(db, `AND decisions.exec_state IS NOT 'disputed' ${operatorsOnly ? `AND ${settledBySql("decisions")}` : `AND NOT (${MAINTAINER_ANSWER} AND NOT ${settledBySql("decisions")})`}`);
}

/** Items whose latest scope answer is a maintainer's that no longer counts: the item waits for a decision again instead of being reviewed on it. */
export function unsettledScope(db: DatabaseSync): Set<string> {
  return new Set(scopeRows(db, `AND ${MAINTAINER_ANSWER} AND NOT ${settledBySql("decisions")}`).keys());
}
