// Which open PRs the Verify stage plans: taken at their current head commit, CI not failing, not planned yet.
import { fastScoreSql } from "../fasttrack.ts";
import { notHeldSql } from "../dupes/held.ts";
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { headOf } from "../review/candidates.ts";
import { staleReviews } from "../review/discussion.ts";
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

type Scanned = { c: VerifyCandidate; unavailable: string | null };

/** Why Verify cannot run for the repo's PRs, or null: it builds only public Rust workspaces. */
export const PRIVATE_REASON = "the repo is private";
export const NOT_RUST_REASON = "the repo is not a Rust workspace";

function scan(db: DatabaseSync, repo: string, run: string | null, rust: RustCheck): Scanned[] {
  const pub = !!db.prepare("SELECT 1 FROM repos WHERE name = ? AND visibility = 'public'").get(repo);
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.body, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.overall AS c_overall,
      r.verdict AS r_verdict, r.reason AS r_reason, r.risks AS r_risks, r.fixes AS r_fixes
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN final_reviews r ON r.final = 1 AND r.repo = i.repo AND r.number = i.number AND r.head_oid = COALESCE(
      CASE WHEN c.fetched_at IS NOT NULL AND (i.updated_at IS NULL OR c.fetched_at > i.updated_at) THEN c.head_oid END, i.head_oid, c.head_oid)
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY ${fastScoreSql("i.repo", "i.number", "p.score")} IS NULL, ${fastScoreSql("i.repo", "i.number", "p.score")} DESC, i.number`).all(repo) as Row[];
  const done = db.prepare("SELECT 1 FROM verifications WHERE repo = ? AND number = ? AND head_sha = ? AND state != 'stale'");
  const settled = settledLookup(db, run);
  const stale = staleReviews(db, repo);
  const out: Scanned[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || r.r_verdict !== "take") continue;
    if (r.c_head === head && r.c_overall === "failure") continue;
    if (done.get(r.repo, r.number, head)) continue;
    if (stale.has(`${r.repo}#${r.number}@${head}`)) continue;
    const unavailable = !pub ? PRIVATE_REASON : rust(r.repo, head) === false ? NOT_RUST_REASON : null;
    out.push({
      unavailable,
      c: {
        repo: r.repo, number: r.number, title: r.title ?? "", body: r.body ?? "", head_oid: head, label: settled(r.repo, r.number).label ?? null,
        review: { verdict: r.r_verdict, reason: r.r_reason ?? "", risks: list<string>(r.r_risks), fixes: list<{ file: string; change: string }>(r.r_fixes) },
      },
    });
  }
  return out;
}

/**
 * Open, non-draft PRs of a public repo whose review at the current head is `take` (take-fix gets a fix-up
 * push first, which is reviewed again), whose CI does not fail at that head, and that have no verification
 * at that head (a `stale` one does not count). A repo known to have no Cargo.toml at the root is left out.
 */
export function selectCandidates(db: DatabaseSync, repo: string, run: string | null = latestRun(db), rust: RustCheck = cachedRust): VerifyCandidate[] {
  return scan(db, repo, run, rust).filter((x) => !x.unavailable).map((x) => x.c);
}

/** The PRs selectCandidates leaves out only because Verify cannot build the repo (private, or no Cargo.toml at the root), with why. */
export function unavailableCandidates(db: DatabaseSync, repo: string, run: string | null = latestRun(db), rust: RustCheck = cachedRust): { c: VerifyCandidate; reason: string }[] {
  return scan(db, repo, run, rust).flatMap((x) => (x.unavailable ? [{ c: x.c, reason: x.unavailable }] : []));
}
