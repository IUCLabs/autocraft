// What the Fix stage reads about issues from the local tables. Which issues it works on is the Plans' (core/decide-item.ts).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ATTEMPT_STATES = ["retry", "testing", "passed", "pr-opened", "skipped", "failed"] as const;

export type IssueCandidate = { repo: string; number: number; title: string; body: string; hash: string; score: number | null };

/** Setting that marks a repo without a Rust workspace at its root, set by the step when it finds out. */
export const notRustKey = (repo: string): string => `fixissue_not_rust:${repo}`;

export const textHash = (title: string, body: string): string => createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 16);

/** Issue numbers an open PR in the repo closes or mentions by number. */
export function issuesWithOpenPr(db: DatabaseSync, repo: string): Set<number> {
  const prs = db.prepare("SELECT body, title, closing_issues FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN'").all(repo) as { body: string | null; title: string | null; closing_issues: string | null }[];
  const out = new Set<number>();
  for (const p of prs) {
    try {
      for (const n of JSON.parse(p.closing_issues ?? "[]") as unknown[]) if (typeof n === "number") out.add(n);
    } catch { /* fall through to the text */ }
    for (const m of `${p.title ?? ""}\n${p.body ?? ""}`.matchAll(/(?<![\w/])#(\d+)/g)) out.add(Number(m[1]));
  }
  return out;
}

/** Whether an open PR in the repo closes issue `n` or mentions it by number. */
export const hasOpenPr = (db: DatabaseSync, repo: string, n: number): boolean => issuesWithOpenPr(db, repo).has(n);
