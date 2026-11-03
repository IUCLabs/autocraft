// Which open PRs the Review stage looks at, and at which head commit.
import { fastScoreSql } from "../fasttrack.ts";
import { notHeldSql } from "../dupes/held.ts";
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup, settledTable } from "../classify/settled.ts";
import { SCOPE_OPTIONS } from "../decide/decision.ts";
import { staleReviews } from "./discussion.ts";

/** Type labels whose PRs get a code review; plugin candidates do not. */
export const REVIEW_LABELS = ["bugfix", "performance", "missing feature", "small extra", "infra"];

export type Size = "S" | "M" | "L";

/** Same S and M bounds as the dashboard's size column; its L and XL are both L here. */
export function sizeOf(linesChanged: number): Size {
  return linesChanged <= 50 ? "S" : linesChanged <= 300 ? "M" : "L";
}

/** Scope answers that keep a PR in core. */
const KEEP_IN_CORE: string[] = [SCOPE_OPTIONS.take.key, SCOPE_OPTIONS["small-extra"].key];

/**
 * The operator's answer to the latest scope decision on this PR, or null.
 * A batch decision applies its answer to every item except those listed in
 * its exceptions.
 */
export function scopeAnswer(db: DatabaseSync, repo: string, number: number): string | null {
  return scopeAnswerIn(scopeRows(db, repo), repo, number);
}

type ScopeRow = { number: number | null; items: string | null; answer: string; exceptions: string | null };

/** The answered scope decisions that can apply to `repo`, newest first: read once per repo, then ask scopeAnswerIn() per PR. */
function scopeRows(db: DatabaseSync, repo: string): ScopeRow[] {
  return db.prepare(`SELECT number, items, answer, exceptions FROM decisions
    WHERE kind = 'scope' AND answer IS NOT NULL AND (repo = ? OR repo IS NULL) ORDER BY answered_at DESC`).all(repo) as ScopeRow[];
}

function scopeAnswerIn(rows: ScopeRow[], repo: string, number: number): string | null {
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
  /** Work score (src/rank), null before the item was ranked. */
  score?: number | null;
};

type Row = {
  repo: string; number: number; title: string | null; body: string | null; author: string | null;
  author_association: string | null; head_oid: string | null; additions: number | null; deletions: number | null;
  changed_files: number | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null; score: number | null;
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
 * carry no `needs decision` flag unless a scope decision answered `take` or `small-extra`, and
 * that have no Opus review at their current head commit, or whose review there is older than a comment or review by someone else. Any other scope answer keeps a PR out.
 */
export function selectCandidates(db: DatabaseSync, repo: string, run: string | null = latestRun(db)): Candidate[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.body, i.author, i.author_association, i.head_oid,
      i.additions, i.deletions, i.changed_files, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, ${fastScoreSql("i.repo", "i.number", "p.score")} AS score
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY ${fastScoreSql("i.repo", "i.number", "p.score")} IS NULL, ${fastScoreSql("i.repo", "i.number", "p.score")} DESC, i.number`).all(repo) as Row[];
  const reviewed = db.prepare("SELECT 1 FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL");
  const stale = staleReviews(db, repo, true);
  const settled = settledLookup(db, run);
  let scope: ScopeRow[] | undefined;
  const out: Candidate[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head) continue;
    const s = settled(r.repo, r.number);
    if (!s.label || !REVIEW_LABELS.includes(s.label)) continue;
    const answer = scopeAnswerIn(scope ??= scopeRows(db, repo), r.repo, r.number);
    if (answer !== null ? !KEEP_IN_CORE.includes(answer) : s.flags.includes("needs decision")) continue;
    if (reviewed.get(r.repo, r.number, head) && !stale.has(`${r.repo}#${r.number}@${head}`)) continue;
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    out.push({
      repo: r.repo, number: r.number, title: r.title ?? "", body: r.body ?? "", author: r.author,
      author_association: r.author_association, head_oid: head, lines_changed: lines,
      files_changed: r.changed_files ?? 0, size: sizeOf(lines), label: s.label, score: r.score,
    });
  }
  return out;
}

/**
 * The answer of the latest answered scope decision per item ("repo#n"), for
 * every item at once: the same rule as scopeAnswer(), in one query.
 */
export function scopeAnswers(db: DatabaseSync, operatorsOnly = false): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare(`SELECT repo, number, items, answer, exceptions FROM decisions
    WHERE kind = 'scope' AND answer IS NOT NULL ${operatorsOnly ? "AND answered_by IN (SELECT login FROM access WHERE role = 'operator')" : ""} ORDER BY answered_at DESC`).all() as
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
 * Refs ("repo#n") of the PRs selectCandidates() would return, for one repo or
 * every repo, from one query over the settled table: for counting, where
 * selectCandidates() reads each PR on its own.
 */
export function candidateRefs(db: DatabaseSync, repo?: string, run: string | null = latestRun(db)): Set<string> {
  settledTable(db, run);
  const answers = scopeAnswers(db);
  const rows = db.prepare(`SELECT i.repo, i.number, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, s.label, s.flags
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN temp.item_settled s ON s.repo = i.repo AND s.number = i.number
    WHERE i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ${repo ? "AND i.repo = :repo" : ""}`).all(repo ? { repo } : {}) as
    (Pick<Row, "repo" | "number" | "head_oid" | "updated_at" | "is_draft" | "c_head" | "c_state" | "c_draft" | "c_at"> & { label: string | null; flags: string | null })[];
  const reviewed = new Set((db.prepare(`SELECT repo, number, head_oid FROM opus_reviews WHERE verdict IS NOT NULL ${repo ? "AND repo = ?" : ""}`).all(...(repo ? [repo] : [])) as
    { repo: string; number: number; head_oid: string }[]).map((r) => `${r.repo}#${r.number}@${r.head_oid}`));
  const stale = staleReviews(db, repo, true);
  const out = new Set<string>();
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || !r.label || !REVIEW_LABELS.includes(r.label)) continue;
    const ref = `${r.repo}#${r.number}`;
    const answer = answers.get(ref) ?? null;
    const flags = r.flags ? (JSON.parse(r.flags) as string[]) : [];
    if (answer !== null ? !KEEP_IN_CORE.includes(answer) : flags.includes("needs decision")) continue;
    if (reviewed.has(`${ref}@${head}`) && !stale.has(`${ref}@${head}`)) continue;
    out.add(ref);
  }
  return out;
}
