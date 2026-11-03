// The discussion on a PR as the review prompts show it: top-level comments and review bodies from the
// mirror, plus unresolved inline review threads read live from GitHub. Our own posts are left out.
// Also decides when a PR's reviews are stale because someone else wrote on it after them.
// All text here is written by outsiders and is passed on as untrusted data.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import type { Querier } from "../mirror.ts";
import { ENTRY_LIMIT, TOTAL_LIMIT, type DiscussionEntry } from "./parse.ts";

/** Setting that holds the pipeline account's login (also read by src/merge/queue.ts). */
const LOGIN_KEY = "pipeline_login";
/** Prefix of the setting that marks a PR's reviews stale on an operator's request; the value is the time. */
const STALE_KEY = "review_stale:";
const ORG = "storytold";

const MAX_THREADS = 50;

/** Sections whose text is tool output or instructions for other tools, not a claim about the change. */
const NOISE_SUMMARY = /prompt for|analysis chain|scripts? executed|fingerprint|committable|additional context|learnings|ai agents|review info|walkthrough|sequence diagram|related pull requests|suggested labels/i;

/** Markup removed, noisy collapsible sections dropped, the rest kept as plain text. */
export function cleanBody(s: string | null | undefined): string {
  let t = (s ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const inner = /<details[^>]*>((?:(?!<details)[\s\S])*?)<\/details>/i;
  for (let m = inner.exec(t); m; m = inner.exec(t)) {
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(m[1]!)?.[1] ?? "";
    const rest = m[1]!.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, "");
    const text = NOISE_SUMMARY.test(summary) ? "" : `${summary.replace(/<[^>]+>/g, "").trim()}\n${rest}`;
    t = t.slice(0, m.index) + text + t.slice(m.index + m[0].length);
  }
  return t.replace(/<\/?(?:details|summary|sub|sup|br|p|div|picture|source|img|a|b|i|strong|em|blockquote)\b[^>]*>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s);

export function pipelineLogin(db: DatabaseSync): string {
  return (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(LOGIN_KEY) as { value: string } | undefined)?.value ?? "";
}

/** SQL for "written by someone other than us": not the pipeline's login and not a review we posted (`c` is the comments table alias). */
const NOT_OURS = `COALESCE(c.author, '') <> :own
  AND c.id NOT IN (SELECT review_id FROM review_posts WHERE repo = c.repo AND number = c.number)`;

/** Comments and review bodies on the PR by others, oldest first, cleaned and clipped; reviews without a body are left out. */
export function mirrorDiscussion(db: DatabaseSync, repo: string, number: number): DiscussionEntry[] {
  const rows = db.prepare(`SELECT c.kind, c.author, c.created_at, c.body, c.review_state FROM comments c
    WHERE c.repo = :repo AND c.number = :number AND ${NOT_OURS} ORDER BY c.created_at`).all({ repo, number, own: pipelineLogin(db) }) as
    { kind: string; author: string | null; created_at: string | null; body: string | null; review_state: string | null }[];
  const out: DiscussionEntry[] = [];
  for (const r of rows) {
    const body = cleanBody(r.body);
    if (!body) continue;
    out.push({ kind: r.kind === "review" ? "review" : "comment", author: r.author, at: r.created_at, ...(r.kind === "review" ? { state: r.review_state } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return out;
}

export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_THREADS}) { nodes { isResolved isOutdated path line originalLine comments(first: 1) { nodes { author { login } createdAt body } } } }
    }
  }
}`;

type ThreadNode = {
  isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; originalLine?: number | null;
  comments?: { nodes?: { author?: { login?: string } | null; createdAt?: string; body?: string }[] };
};

/** The unresolved inline review threads of the PR, read from GitHub (a read, never a write), excluding threads we started. */
export async function liveThreads(q: Querier, db: DatabaseSync, repo: string, number: number): Promise<DiscussionEntry[]> {
  const res = await q.query(THREADS_QUERY, { owner: ORG, name: repo, number });
  const own = pipelineLogin(db);
  const out: DiscussionEntry[] = [];
  for (const t of (res?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as ThreadNode[]) {
    const c = t.comments?.nodes?.[0];
    if (!c || t.isResolved) continue;
    const author = c.author?.login ?? null;
    if (own && author === own) continue;
    const body = cleanBody(c.body);
    if (!body) continue;
    out.push({ kind: "thread", author, at: c.createdAt ?? null, path: t.path, line: t.line ?? t.originalLine ?? null, ...(t.isOutdated ? { outdated: true } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return out;
}

/**
 * Entries kept within the total budget: threads first, then reviews, then comments (newest first within
 * each), so a noisy bot cannot push out the findings. The kept entries are returned oldest first.
 */
export function fitBudget(entries: DiscussionEntry[], total = TOTAL_LIMIT): DiscussionEntry[] {
  const rank = { thread: 0, review: 1, comment: 2, note: 3 } as const;
  const order = entries.map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.kind] - rank[b.e.kind] || b.i - a.i);
  let used = 0;
  const kept = new Set<number>();
  for (const { e, i } of order) {
    const n = e.body.length + (e.path?.length ?? 0) + 40;
    if (used + n > total) continue;
    used += n;
    kept.add(i);
  }
  const out = entries.filter((_, i) => kept.has(i));
  const dropped = entries.length - out.length;
  if (dropped) out.push({ kind: "note", body: `${dropped} more entries left out for length` });
  return out;
}

/** The discussion of a PR for a review prompt: the mirror's comments and reviews, then `threads`, within the budget. */
export function discussionOf(db: DatabaseSync, repo: string, number: number, threads: DiscussionEntry[] = []): DiscussionEntry[] {
  return fitBudget([...mirrorDiscussion(db, repo, number), ...threads]);
}

const staleKey = (repo: string, number: number) => `${STALE_KEY}${repo}#${number}`;

/**
 * PRs, as "repo#n@head", whose review (Sonnet's row at that head) is older than the newest comment or review
 * by someone else on the PR, or older than an operator's stale mark. One query for a repo or every repo.
 */
export function staleReviews(db: DatabaseSync, repo?: string): Set<string> {
  const rows = db.prepare(`SELECT r.repo, r.number, r.head_oid FROM reviews r
    WHERE (:repo IS NULL OR r.repo = :repo) AND (
      (SELECT MAX(c.created_at) FROM comments c WHERE c.repo = r.repo AND c.number = r.number AND ${NOT_OURS}) > r.at
      OR COALESCE((SELECT value FROM main.settings WHERE key = 'review_stale:' || r.repo || '#' || r.number), '') > r.at)`)
    .all({ repo: repo ?? null, own: pipelineLogin(db) }) as { repo: string; number: number; head_oid: string }[];
  return new Set(rows.map((r) => `${r.repo}#${r.number}@${r.head_oid}`));
}

/** Operator request: every review of the PR counts as older than now, so Sonnet and then Opus review it again. */
export function markReviewsStale(db: DatabaseSync, by: string, repo: string, number: number): void {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(staleKey(repo, number), at);
  audit(db, by, "review-again", `${repo}#${number}`, { stale: true });
}
