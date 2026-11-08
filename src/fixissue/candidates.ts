// What the Fix stage reads about issues from the local tables. Which issues it works on is the Plans' (core/decide-item.ts).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ATTEMPT_STATES = ["retry", "testing", "passed", "pr-opened", "skipped", "failed"] as const;

export type IssueCandidate = { repo: string; number: number; title: string; body: string; hash: string; score: number | null };

/** Setting that marks a repo without a Rust workspace at its root, set by the step when it finds out. */
export const notRustKey = (repo: string): string => `fixissue_not_rust:${repo}`;

export const textHash = (title: string, body: string): string => createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 16);

/** A closing keyword followed by a same-repo issue number: GitHub's own closing-reference forms. A bare mention does not count. */
const CLOSING = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+#(\d+)/gi;

/** Issue numbers an open PR in the repo closes (its closing-issue links, or a Fixes/Closes/Resolves #n in its title or body), with the lowest number of such a PR. */
export function issuesWithOpenPr(db: DatabaseSync, repo: string): Map<number, number> {
  const prs = db.prepare("SELECT number, body, title, closing_issues FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN' ORDER BY number DESC").all(repo) as { number: number; body: string | null; title: string | null; closing_issues: string | null }[];
  const out = new Map<number, number>();
  for (const p of prs) {
    const closes = new Set<number>();
    try {
      for (const n of JSON.parse(p.closing_issues ?? "[]") as unknown[]) if (typeof n === "number") closes.add(n);
    } catch { /* fall through to the text */ }
    for (const m of `${p.title ?? ""}\n${p.body ?? ""}`.matchAll(CLOSING)) closes.add(Number(m[1]));
    for (const n of closes) out.set(n, p.number);
  }
  return out;
}

/** Whether an open PR in the repo closes issue `n`. */
export const hasOpenPr = (db: DatabaseSync, repo: string, n: number): boolean => issuesWithOpenPr(db, repo).has(n);
