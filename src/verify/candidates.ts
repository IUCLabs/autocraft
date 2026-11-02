// Which open PRs the Verify stage plans: taken at their current head commit, CI not failing, not planned yet.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { headOf } from "../review/candidates.ts";
import { cachedCratesOf } from "./crates.ts";

export type ReviewInfo = { verdict: string; reason: string; risks: string[]; fixes: { file: string; change: string }[] };
export type VerifyCandidate = {
  repo: string; number: number; title: string; body: string; head_oid: string; label: string | null; review: ReviewInfo;
};

type Row = {
  repo: string; number: number; title: string | null; body: string | null; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null; c_overall: string | null;
  r_verdict: string | null; r_reason: string | null; r_risks: string | null; r_fixes: string | null;
};

const list = <T>(s: string | null): T[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
};

/** Whether the repo has a Cargo.toml at its root at `sha`: true or false once known, null before the tree was fetched. */
export type RustCheck = (repo: string, sha: string) => boolean | null;
export const cachedRust: RustCheck = (repo, sha) => cachedCratesOf(repo, sha)?.rust ?? null;

/**
 * Open, non-draft PRs of a public repo whose review at the current head is `take` (take-fix gets a fix-up
 * push first, which is reviewed again), whose CI does not fail at that head, and that have no verification
 * at that head. A repo known to have no Cargo.toml at the root is left out.
 */
export function selectCandidates(db: DatabaseSync, repo: string, run: string | null = latestRun(db), rust: RustCheck = cachedRust): VerifyCandidate[] {
  const pub = db.prepare("SELECT 1 FROM repos WHERE name = ? AND visibility = 'public'").get(repo);
  if (!pub) return [];
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.body, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.overall AS c_overall,
      r.verdict AS r_verdict, r.reason AS r_reason, r.risks AS r_risks, r.fixes AS r_fixes
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN reviews r ON r.repo = i.repo AND r.number = i.number AND r.head_oid = COALESCE(
      CASE WHEN c.fetched_at IS NOT NULL AND (i.updated_at IS NULL OR c.fetched_at > i.updated_at) THEN c.head_oid END, i.head_oid, c.head_oid)
    LEFT JOIN item_priority p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' ORDER BY p.score IS NULL, p.score DESC, i.number`).all(repo) as Row[];
  const done = db.prepare("SELECT 1 FROM verifications WHERE repo = ? AND number = ? AND head_sha = ?");
  const settled = settledLookup(db, run);
  const out: VerifyCandidate[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || r.r_verdict !== "take") continue;
    if (r.c_head === head && r.c_overall === "failure") continue;
    if (done.get(r.repo, r.number, head)) continue;
    if (rust(r.repo, head) === false) continue;
    out.push({
      repo: r.repo, number: r.number, title: r.title ?? "", body: r.body ?? "", head_oid: head, label: settled(r.repo, r.number).label ?? null,
      review: { verdict: r.r_verdict, reason: r.r_reason ?? "", risks: list<string>(r.r_risks), fixes: list<{ file: string; change: string }>(r.r_fixes) },
    });
  }
  return out;
}
