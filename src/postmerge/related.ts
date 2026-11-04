// The related items and earlier reviews of a PR that the post-merge, review and pre-merge prompts show.
import type { DatabaseSync } from "node:sqlite";
import type { PostmergeReviewRow, RelatedItem } from "./parse.ts";

/** Our earlier Opus reviews of the PR, oldest first. */
export function reviewHistory(db: DatabaseSync, repo: string, number: number): PostmergeReviewRow[] {
  const list = <T>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
  return (db.prepare("SELECT head_oid, at, verdict, sure, reason, risks, fixes FROM opus_review_history WHERE repo = ? AND number = ? AND verdict IS NOT NULL ORDER BY at, rowid").all(repo, number) as
    { head_oid: string; at: string; verdict: string; sure: number; reason: string; risks: string | null; fixes: string | null }[])
    .map((r) => ({ head: r.head_oid, verdict: r.verdict, sure: r.sure === 1, reason: r.reason, risks: list<string>(r.risks), fixes: list(r.fixes), at: r.at }));
}

/** Items closed within this long still count as related: a defect reported and closed recently is not reported again. */
export const RELATED_CLOSED_DAYS = 30;

/** Items of the repo, open or closed in the last 30 days, that mention the PR by number or one of its files by path: number, kind, state and title, for deduplication. */
export function relatedOpen(db: DatabaseSync, repo: string, number: number, files: string[], at = Date.now()): RelatedItem[] {
  const needles = [`#${number}`, ...files.slice(0, 30)];
  const where = needles.map(() => "(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')").join(" OR ");
  const args = needles.flatMap((n) => { const like = `%${n.replace(/[\\%_]/g, "\\$&")}%`; return [like, like]; });
  const since = new Date(at - RELATED_CLOSED_DAYS * 86400_000).toISOString();
  const rows = db.prepare(`SELECT i.number, i.kind, i.state, i.title, i.body FROM items i WHERE i.repo = ?
    AND (i.state = 'OPEN' OR COALESCE(i.closed_at, i.merged_at, i.updated_at) >= ?) AND i.number <> ? AND (${where}) ORDER BY i.number LIMIT 60`).all(repo, since, number, ...args) as
    { number: number; kind: "issue" | "pr"; state: string; title: string | null; body: string | null }[];
  const byNumber = new RegExp(String.raw`(?<![\w/])#${number}(?!\d)`);
  return rows
    .filter((r) => { const text = `${r.title ?? ""}\n${r.body ?? ""}`; return byNumber.test(text) || files.some((f) => text.includes(f)); })
    .slice(0, 40).map((r) => ({ number: r.number, kind: r.kind, state: r.state === "OPEN" ? "open" as const : "closed" as const, title: (r.title ?? "").slice(0, 160) }));
}
