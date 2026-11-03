// The discussion on a PR as the review prompts show it: top-level comments, review bodies and unresolved
// inline review threads, all read live from GitHub in one query. Our own posts are left out.
// Also decides when a PR's reviews are stale because someone else wrote on it after them.
// All text here is written by outsiders and is passed on as untrusted data.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import type { Querier } from "../mirror.ts";
import { refuseReviews, type ReviewFact } from "../merge/changes-requested.ts";
import { ENTRY_LIMIT, TOTAL_LIMIT, type DiscussionEntry } from "./parse.ts";

/** Setting that holds the pipeline account's login (also read by src/merge/queue.ts). */
const LOGIN_KEY = "pipeline_login";
/** Prefix of the setting that marks a PR's reviews stale on an operator's request; the value is the time. */
const STALE_KEY = "review_stale:";
const ORG = "storytold";

/** Discussion-triggered re-reviews of one PR per UTC day; a head change or an operator request is not counted. */
export const MAX_RERUNS_PER_DAY = 3;
const RERUN_KEY = "review_rerun:";

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
const sec = (t: string): string => t.slice(0, 19);

export function pipelineLogin(db: DatabaseSync): string {
  return (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(LOGIN_KEY) as { value: string } | undefined)?.value ?? "";
}

/** Authors whose words trigger a new review: the PR's author, people tied to the repository, and bot accounts. */
const COUNTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"];

type Written = { author: string | null; association?: string | null; bot?: boolean; prAuthor?: string | null; state?: string | null; body: string | null; inline?: number };

/**
 * Whether a comment or review counts as new discussion: empty bodies and bare approvals never do, strangers' do not.
 * A review with no body but inline comments counts (the findings are in the threads).
 */
export function isCounted(w: Written): boolean {
  const body = cleanBody(w.body);
  const inline = w.inline ?? 0;
  if (!body && !inline) return false;
  if (w.state === "APPROVED" && !inline && body.length < 40) return false;
  const login = w.author ?? "";
  return !!login && (login === w.prAuthor || !!w.bot || login.endsWith("[bot]") || COUNTED_ASSOCIATIONS.includes(w.association ?? ""));
}

/** A hash of the counted entries (id and cleaned text): two snapshots with the same hash read the same discussion. */
export function discussionHash(xs: { id: string; body: string | null }[]): string {
  return createHash("sha256").update(JSON.stringify(xs.map((x) => [x.id, cleanBody(x.body)]).sort())).digest("hex").slice(0, 16);
}

/** What a review read: when, and a hash of the counted entries. */
export type Snapshot = { seen: string; hash: string | null };

/** SQL for "written by someone other than us" (`c` is the comments table alias). */
const NOT_OURS = `COALESCE(c.author, '') <> :own
  AND c.id NOT IN (SELECT review_id FROM review_posts WHERE repo = c.repo AND number = c.number)`;

type MirrorRow = { id: string; kind: string; author: string | null; created_at: string | null; body: string | null; review_state: string | null; counted: number | null };
const mirrorRows = (db: DatabaseSync, repo: string, number: number): MirrorRow[] =>
  db.prepare(`SELECT c.id, c.kind, c.author, c.created_at, c.body, c.review_state, c.counted FROM comments c
    WHERE c.repo = :repo AND c.number = :number AND ${NOT_OURS} ORDER BY c.created_at`).all({ repo, number, own: pipelineLogin(db) }) as MirrorRow[];

/** Comments and review bodies from the mirror: the fallback for a call that has no GitHub connection. */
function mirrorDiscussion(db: DatabaseSync, repo: string, number: number): { entries: DiscussionEntry[]; hash: string } {
  const rows = mirrorRows(db, repo, number);
  const entries: DiscussionEntry[] = [];
  for (const r of rows) {
    const body = cleanBody(r.body);
    if (!body) continue;
    entries.push({ kind: r.kind === "review" ? "review" : "comment", author: r.author, at: r.created_at, ...(r.kind === "review" ? { state: r.review_state } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return { entries, hash: discussionHash(rows.filter((r) => r.counted === 1)) };
}

export const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login }
      comments(last: 20) { nodes { id author { login __typename } authorAssociation createdAt body } }
      reviews(last: 10) { nodes { id author { login __typename } authorAssociation createdAt body state comments { totalCount } } }
      formal: reviews(last: 100, states: [APPROVED, CHANGES_REQUESTED, DISMISSED]) { nodes { id author { login } authorAssociation createdAt submittedAt state } }
      reviewThreads(last: 50) { nodes { isResolved isOutdated path line originalLine
        head: comments(first: 1) { nodes { id author { login __typename } authorAssociation createdAt body } }
        tail: comments(last: 3) { nodes { id author { login } body } } } }
    }
  }
}`;

type Author = { login?: string; __typename?: string } | null;
type Node = { id?: string; author?: Author; authorAssociation?: string; createdAt?: string; submittedAt?: string; body?: string; state?: string; comments?: { totalCount?: number } };
type ThreadNode = {
  isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; originalLine?: number | null;
  head?: { nodes?: Node[] }; tail?: { nodes?: Node[] };
};

export type LiveDiscussion = { entries: DiscussionEntry[]; snap: Snapshot; newest: string | null; /** Reviews by others, for the changes-requested rule. */ reviews: ReviewFact[] };

/**
 * Everything others wrote on the PR, read from GitHub (a read, never a write) in one query: comments, review
 * bodies and unresolved threads, ours excluded. `snap.seen` is the time just before the read.
 */
export async function liveDiscussion(q: Querier, db: DatabaseSync, repo: string, number: number): Promise<LiveDiscussion> {
  const seen = new Date().toISOString();
  const res = await q.query(DISCUSSION_QUERY, { owner: ORG, name: repo, number });
  const pr = res?.repository?.pullRequest;
  if (!pr) throw new Error(`${repo}#${number} not found on GitHub`);
  const own = pipelineLogin(db);
  const posted = new Set((db.prepare("SELECT review_id FROM review_posts WHERE repo = ? AND number = ?").all(repo, number) as { review_id: string }[]).map((r) => r.review_id));
  const mine = (a: Author | undefined, id?: string) => (!!own && a?.login === own) || (!!id && posted.has(id));
  const prAuthor: string | null = pr.author?.login ?? null;
  const entries: DiscussionEntry[] = [];
  const counted: { id: string; body: string | null }[] = [];
  let newest: string | null = null;
  const take = (kind: "comment" | "review", n: Node) => {
    if (mine(n.author, n.id)) return;
    const body = cleanBody(n.body);
    if (body) entries.push({ kind, author: n.author?.login ?? null, at: n.createdAt ?? null, ...(kind === "review" ? { state: n.state ?? null } : {}), body: clip(body, ENTRY_LIMIT) });
    if (isCounted({ author: n.author?.login ?? null, association: n.authorAssociation, bot: n.author?.__typename === "Bot", prAuthor, state: n.state, body: n.body ?? null, inline: n.comments?.totalCount })) {
      counted.push({ id: n.id ?? "", body: n.body ?? null });
      if (n.createdAt && (!newest || n.createdAt > newest)) newest = n.createdAt;
    }
  };
  for (const n of (pr.comments?.nodes ?? []) as Node[]) take("comment", n);
  for (const n of (pr.reviews?.nodes ?? []) as Node[]) take("review", n);
  for (const t of (pr.reviewThreads?.nodes ?? []) as ThreadNode[]) {
    const c = t.head?.nodes?.[0];
    if (!c || t.isResolved || mine(c.author, c.id)) continue;
    const body = cleanBody(c.body);
    if (!body) continue;
    if (isCounted({ author: c.author?.login ?? null, association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor, body: c.body ?? null })) {
      counted.push({ id: c.id ?? "", body: c.body ?? null });
      if (c.createdAt && (!newest || c.createdAt > newest)) newest = c.createdAt;
    }
    const replies = (t.tail?.nodes ?? []).filter((r) => r.id !== c.id && !mine(r.author, r.id))
      .map((r) => ({ author: r.author?.login ?? null, body: clip(cleanBody(r.body), ENTRY_LIMIT / 2) })).filter((r) => r.body);
    entries.push({ kind: "thread", author: c.author?.login ?? null, at: c.createdAt ?? null, path: t.path, line: t.line ?? t.originalLine ?? null, ...(t.isOutdated ? { outdated: true } : {}), body: clip(body, ENTRY_LIMIT), ...(replies.length ? { replies } : {}) });
  }
  const reviews = ((pr.formal?.nodes ?? []) as Node[]).filter((n) => !mine(n.author, n.id))
    .map((n) => ({ author: n.author?.login ?? null, association: n.authorAssociation ?? null, state: n.state ?? null, at: n.submittedAt ?? n.createdAt ?? null }));
  return { entries, snap: { seen, hash: discussionHash(counted) }, newest, reviews };
}

/** Just before a merge: the reason a maintainer's changes-requested review blocks the PR, read live; null when none, undefined when the read failed. */
export async function changesRequestedChecked(db: DatabaseSync, q: Querier, repo: string, number: number, log: (line: string) => void): Promise<string | null | undefined> {
  try {
    return refuseReviews((await withRetry(() => liveDiscussion(q, db, repo, number))).reviews);
  } catch (e) {
    log(`  ${repo}#${number}: could not read its reviews (${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}); skipped this run`);
    return undefined;
  }
}

/** Retries a read a few times: a failed read must not silently drop what reviewers wrote. */
export async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries) throw e; }
  }
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
    const n = e.body.length + (e.path?.length ?? 0) + (e.replies?.reduce((t, r) => t + r.body.length, 0) ?? 0) + 40;
    if (used + n > total) continue;
    used += n;
    kept.add(i);
  }
  const out = entries.filter((_, i) => kept.has(i));
  const dropped = entries.length - out.length;
  if (dropped) out.push({ kind: "note", body: `${dropped} more entries left out for length` });
  return out;
}

/** The discussion of a PR for a review prompt and the snapshot it came from: `live` when read from GitHub, else the mirror's. */
export function discussionOf(db: DatabaseSync, repo: string, number: number, live?: LiveDiscussion): { entries: DiscussionEntry[]; snap: Snapshot } {
  if (live) return { entries: fitBudget(live.entries), snap: live.snap };
  const seen = new Date().toISOString();
  const m = mirrorDiscussion(db, repo, number);
  return { entries: fitBudget(m.entries), snap: { seen, hash: m.hash } };
}

const staleKey = (repo: string, number: number) => `${STALE_KEY}${repo}#${number}`;

/** Newest counted comment or review by someone else, and the hash of those, per "repo#n" from the mirror. */
export function discussionState(db: DatabaseSync, repo?: string): Map<string, { newest: string; hash: string }> {
  const rows = db.prepare(`SELECT c.repo, c.number, c.id, c.body, c.created_at FROM comments c
    WHERE (:repo IS NULL OR c.repo = :repo) AND c.counted = 1 AND ${NOT_OURS}`).all({ repo: repo ?? null, own: pipelineLogin(db) }) as { repo: string; number: number; id: string; body: string | null; created_at: string }[];
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.repo}#${r.number}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return new Map([...by].map(([k, v]) => [k, { newest: v.reduce((m, r) => (r.created_at > m ? r.created_at : m), ""), hash: discussionHash(v) }]));
}

/** True when the discussion has a counted entry newer than a review's snapshot and differs from what that review read (no hash: any newer entry). */
export function changedSince(state: { newest: string; hash: string } | undefined, seen: string, hash: string | null): boolean {
  return !!state && sec(state.newest) > sec(seen) && state.hash !== hash;
}

const day = () => new Date().toISOString().slice(0, 10);
const rerunKey = (repo: string, number: number) => `${RERUN_KEY}${repo}#${number}:${day()}`;
const reruns = (db: DatabaseSync, repo: string, number: number): number =>
  Number((db.prepare("SELECT value FROM main.settings WHERE key = ?").get(rerunKey(repo, number)) as { value: string } | undefined)?.value ?? 0);

/** Whether an operator request or a merge-time check marked the PR stale after `since` (such re-reviews are not counted). */
export function markedStaleSince(db: DatabaseSync, repo: string, number: number, since: string): boolean {
  const v = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(staleKey(repo, number)) as { value: string } | undefined)?.value;
  return !!v && v > since;
}

/** Counts a same-head re-review against the PR's daily cap and forgets earlier days. */
export function countRerun(db: DatabaseSync, repo: string, number: number): void {
  db.prepare("DELETE FROM main.settings WHERE key LIKE ? AND key <> ?").run(`${RERUN_KEY}${repo}#${number}:%`, rerunKey(repo, number));
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(rerunKey(repo, number), "1");
}

/**
 * PRs, as "repo#n@head", whose Sonnet review read the discussion before a counted comment or review that it
 * did not read, or that an operator marked stale. With `respectCap`, PRs that already had MAX_RERUNS_PER_DAY
 * discussion-triggered re-reviews today are left out (an operator mark is never capped).
 */
export function staleReviews(db: DatabaseSync, repo?: string, respectCap = false): Set<string> {
  const rows = db.prepare(`SELECT r.repo, r.number, r.head_oid, r.at, r.seen_at, r.disc_hash FROM reviews r WHERE (:repo IS NULL OR r.repo = :repo)`)
    .all({ repo: repo ?? null }) as { repo: string; number: number; head_oid: string; at: string; seen_at: string | null; disc_hash: string | null }[];
  const state = discussionState(db, repo);
  const marks = new Map((db.prepare("SELECT key, value FROM main.settings WHERE key LIKE ?").all(`${STALE_KEY}%`) as { key: string; value: string }[]).map((m) => [m.key.slice(STALE_KEY.length), m.value]));
  const out = new Set<string>();
  const todays = new Map<string, number>();
  const capped = (r: { repo: string; number: number }) => {
    const k = `${r.repo}#${r.number}`;
    if (!todays.has(k)) todays.set(k, reruns(db, r.repo, r.number));
    return todays.get(k)! >= MAX_RERUNS_PER_DAY;
  };
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    const marked = (marks.get(ref) ?? "") > r.at;
    const talked = changedSince(state.get(ref), r.seen_at ?? r.at, r.disc_hash);
    if (!marked && !(talked && !(respectCap && capped(r)))) continue;
    out.add(`${ref}@${r.head_oid}`);
  }
  return out;
}

/** Records the login that posts for us (the token's viewer) when no stage has yet, so our posts can be told from others'. */
export async function ensurePipelineLogin(db: DatabaseSync, q: Querier): Promise<void> {
  if (pipelineLogin(db)) return;
  const login = (await q.query("query { viewer { login } }", {}))?.viewer?.login;
  if (typeof login === "string" && login) db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").run(LOGIN_KEY, login);
}

/**
 * Just before a merge: reads the PR's discussion live and says whether a counted entry newer than the final
 * review's snapshot (and different from what it read) exists. If so the PR's reviews are marked stale so the
 * pipeline reviews it again, and the caller must not merge.
 */
export async function discussionMovedSince(db: DatabaseSync, q: Querier, repo: string, number: number, head: string): Promise<boolean> {
  const snap = (db.prepare(`SELECT COALESCE(o.seen_at, o.at) AS seen, o.disc_hash AS hash FROM opus_reviews o JOIN reviews r ON r.repo = o.repo AND r.number = o.number AND r.head_oid = o.head_oid AND o.at >= r.at
      WHERE o.repo = ? AND o.number = ? AND o.head_oid = ? AND o.verdict IS NOT NULL`).get(repo, number, head)
    ?? db.prepare("SELECT COALESCE(seen_at, at) AS seen, disc_hash AS hash FROM reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, number, head)) as { seen: string; hash: string | null } | undefined;
  if (!snap) return false;
  const live = await liveDiscussion(q, db, repo, number);
  if (!live.newest || !changedSince({ newest: live.newest, hash: live.snap.hash! }, snap.seen, snap.hash)) return false;
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(staleKey(repo, number), new Date().toISOString());
  return true;
}

/** Operator request: every review of the PR counts as older than now, so Sonnet and then Opus review it again. */
export function markReviewsStale(db: DatabaseSync, by: string, repo: string, number: number): void {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(staleKey(repo, number), at);
  audit(db, by, "review-again", `${repo}#${number}`, { stale: true });
}

/** discussionMovedSince with retries; null when the read still fails, so the caller skips the PR this run instead of merging blind. */
export async function discussionMovedChecked(db: DatabaseSync, q: Querier, repo: string, number: number, head: string, log: (line: string) => void): Promise<boolean | null> {
  try {
    return await withRetry(() => discussionMovedSince(db, q, repo, number, head));
  } catch (e) {
    log(`  ${repo}#${number}: could not read its discussion (${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}); skipped this run`);
    return null;
  }
}
