// Which open PRs the Review stage looks at, and at which head commit.
import type { DatabaseSync } from "node:sqlite";

/** Type labels whose PRs get a code review; plugin candidates do not. */
export const REVIEW_LABELS = ["bugfix", "performance", "missing feature", "small extra", "infra"];

export type Size = "S" | "M" | "L";

/** Same S and M bounds as the dashboard's size column; its L and XL are both L here. */
export function sizeOf(linesChanged: number): Size {
  return linesChanged <= 50 ? "S" : linesChanged <= 300 ? "M" : "L";
}

// --- Settled label: temporary -------------------------------------------------
// TEMPORARY until the shared settled-classification function (src/classify/
// settled.ts, branch dash-items) lands; then replace settledLabel with a call
// to it. Same rule: Jev's label when its top probability is at least 0.9,
// else the label when Haiku agrees with Jev, else unsettled. Flags: Jev's when
// it is sure, otherwise every flag either classifier raised.
export const SURE = 0.9;

export type SettledLabel = { label: string | null; flags: string[] };

const jsonArr = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
const topOf = (probs: string | null): number => {
  try {
    const t = (JSON.parse(probs ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : 0;
  } catch { return 0; }
};

export function settledLabel(db: DatabaseSync, repo: string, number: number): SettledLabel {
  const run = (db.prepare("SELECT run_id FROM classifications WHERE classifier = 'jev' ORDER BY at DESC LIMIT 1").get() as { run_id: string } | undefined)?.run_id;
  if (!run) return { label: null, flags: [] };
  const q = db.prepare("SELECT type_label, flags, probs FROM classifications WHERE repo = ? AND number = ? AND classifier = ? AND run_id = ?");
  const j = q.get(repo, number, "jev", run) as { type_label: string; flags: string | null; probs: string | null } | undefined;
  if (!j) return { label: null, flags: [] };
  if (topOf(j.probs) >= SURE) return { label: j.type_label, flags: jsonArr(j.flags) };
  const h = q.get(repo, number, "haiku", run) as { type_label: string; flags: string | null } | undefined;
  const flags = [...new Set([...jsonArr(j.flags), ...jsonArr(h?.flags ?? null)])];
  return { label: h && h.type_label === j.type_label ? j.type_label : null, flags };
}
// -------------------------------------------------------------------------------

/**
 * The operator's answer to the latest scope decision on this PR, or null.
 * A batch decision applies its answer to every item except those listed in
 * its exceptions.
 */
export function scopeAnswer(db: DatabaseSync, repo: string, number: number): string | null {
  const rows = db.prepare(`SELECT number, items, answer, exceptions FROM decisions
    WHERE kind = 'scope' AND answer IS NOT NULL AND (repo = ? OR repo IS NULL) ORDER BY answered_at DESC`).all(repo) as
    { number: number | null; items: string | null; answer: string; exceptions: string | null }[];
  for (const r of rows) {
    if (r.number === number) return r.answer;
    if (r.number !== null) continue;
    const items = parseRefs(r.items);
    if (!items.some((i) => i.repo === repo && i.number === number)) continue;
    const ex = parseRefs(r.exceptions).find((i) => i.repo === repo && i.number === number) as { answer?: string } | undefined;
    return ex?.answer ?? r.answer;
  }
  return null;
}

function parseRefs(s: string | null): { repo: string; number: number; answer?: string }[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as { repo: string; number: number }[]) : [];
  } catch { return []; }
}

export type Candidate = {
  repo: string; number: number; title: string; body: string;
  author: string | null; author_association: string | null;
  head_oid: string; lines_changed: number; files_changed: number;
  size: Size; label: string;
};

type Row = {
  repo: string; number: number; title: string | null; body: string | null; author: string | null;
  author_association: string | null; head_oid: string | null; additions: number | null; deletions: number | null;
  changed_files: number | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null;
};

/**
 * The PR's head commit as best known: the checks table's when it was fetched
 * after the mirror last saw the PR change, else the mirror's.
 */
export function headOf(r: { head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null }): string | null {
  if (r.c_head && r.c_at && (!r.updated_at || r.c_at > r.updated_at)) return r.c_head;
  return r.head_oid ?? r.c_head;
}

/**
 * Open, non-draft PRs of `repo` whose settled label is one we review, that
 * carry no `needs decision` flag unless a scope decision answered `take`, and
 * that have no review at their current head commit. A scope answer other than
 * `take` keeps a PR out.
 */
export function selectCandidates(db: DatabaseSync, repo: string): Candidate[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.body, i.author, i.author_association, i.head_oid,
      i.additions, i.deletions, i.changed_files, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' ORDER BY i.number`).all(repo) as Row[];
  const reviewed = db.prepare("SELECT 1 FROM reviews WHERE repo = ? AND number = ? AND head_oid = ?");
  const out: Candidate[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head) continue;
    const s = settledLabel(db, r.repo, r.number);
    if (!s.label || !REVIEW_LABELS.includes(s.label)) continue;
    const answer = scopeAnswer(db, r.repo, r.number);
    if (answer !== null ? answer !== "take" : s.flags.includes("needs decision")) continue;
    if (reviewed.get(r.repo, r.number, head)) continue;
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    out.push({
      repo: r.repo, number: r.number, title: r.title ?? "", body: r.body ?? "", author: r.author,
      author_association: r.author_association, head_oid: head, lines_changed: lines,
      files_changed: r.changed_files ?? 0, size: sizeOf(lines), label: s.label,
    });
  }
  return out;
}
