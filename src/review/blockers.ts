// What can keep a PR's review from changing: another open item the review named as the reason for its hold.
import type { DatabaseSync } from "node:sqlite";
import { isHiddenRepo, type HiddenRepos } from "../hidden-sql.ts";

const REF = /^([\w.-]+)#(\d+)$/;

/** The end of a review wait on blocking items: "<ref>, <ref>, which blocks its review". */
export const BLOCKS_REVIEW = ", which blocks its review";

/** The items a review wait names as its blockers; empty for any other wait. */
export function blockersOfWait(wait: string | null): string[] {
  if (!wait?.endsWith(BLOCKS_REVIEW)) return [];
  return wait.slice(0, -BLOCKS_REVIEW.length).split(", ").filter((r) => REF.test(r));
}

/** The stored `blocked_by` value (JSON array of refs) as a list. */
export function storedBlockedBy(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * The refs that still block: a tracked item that is open and, for an issue, has an unanswered decision. An untracked, closed or
 * merged item, or an issue with nothing left to decide, blocks nothing.
 */
export function openBlockers(db: DatabaseSync, refs: readonly string[]): string[] {
  const item = db.prepare("SELECT kind, state FROM main.items WHERE repo = ? AND number = ?");
  const pending = db.prepare("SELECT 1 FROM main.decisions WHERE repo = ? AND number = ? AND answer IS NULL LIMIT 1");
  return refs.filter((ref) => {
    const m = REF.exec(ref);
    if (!m) return false;
    const i = item.get(m[1]!, Number(m[2])) as { kind: string; state: string } | undefined;
    if (!i || i.state !== "OPEN") return false;
    return i.kind === "pr" || !!pending.get(m[1]!, Number(m[2]));
  });
}

/** A hold's blocker list is ignored after this long: the PR then gets one fresh review. */
export const BLOCKED_EXPIRES_MS = 14 * 24 * 3600_000;

/**
 * The blockers of the review of `self` made at `at` that still hold: open (openBlockers), not past BLOCKED_EXPIRES_MS, and not
 * themselves waiting on `self` (two PRs blocking each other would never be reviewed).
 */
export function activeBlockers(db: DatabaseSync, self: string, stored: string | null | undefined, at: string, nowMs: number = Date.now()): string[] {
  const refs = storedBlockedBy(stored);
  if (!refs.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
  const latest = db.prepare("SELECT verdict, blocked_by FROM main.opus_reviews WHERE repo = ? AND number = ? AND verdict IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1");
  return openBlockers(db, refs).filter((ref) => {
    const [repo, n] = ref.split("#");
    const l = latest.get(repo!, Number(n)) as { verdict: string; blocked_by: string | null } | undefined;
    return !(l?.verdict === "hold" && storedBlockedBy(l.blocked_by).includes(self));
  });
}

/** Whether any of the refs has an open decision: the wait is then on a person. */
export function hasOpenQuestion(db: DatabaseSync, refs: readonly string[]): boolean {
  const pending = db.prepare("SELECT 1 FROM main.decisions WHERE repo = ? AND number = ? AND answer IS NULL LIMIT 1");
  return refs.some((ref) => { const m = REF.exec(ref); return !!m && !!pending.get(m[1]!, Number(m[2])); });
}

/** Facts for an open decision naming the PRs whose review it holds (derived from their stored holds; the decision row is not written). PRs of repos in `hidden` are not named. */
export function blocksFacts(db: DatabaseSync, repo: string | null, number: number | null, hidden: HiddenRepos): string[] {
  if (repo === null || number === null) return [];
  const me = `${repo}#${number}`;
  const rows = db.prepare(`SELECT o.repo, o.number, o.at, o.blocked_by FROM main.opus_reviews o JOIN main.items i ON i.repo = o.repo AND i.number = o.number AND i.state = 'OPEN'
    WHERE o.verdict IS NOT NULL AND o.blocked_by LIKE ?
      AND o.rowid = (SELECT l.rowid FROM main.opus_reviews l WHERE l.repo = o.repo AND l.number = o.number AND l.verdict IS NOT NULL ORDER BY l.at DESC, l.rowid DESC LIMIT 1)
      AND o.verdict = 'hold' ORDER BY o.repo, o.number LIMIT 5`).all(`%"${me}"%`) as { repo: string; number: number; at: string; blocked_by: string }[];
  return rows.filter((r) => !isHiddenRepo(hidden, r.repo) && activeBlockers(db, `${r.repo}#${r.number}`, r.blocked_by, r.at).includes(me)).map((r) => `Blocks the review of ${r.repo}#${r.number}`);
}

/** `blocksFacts` for every PR at once: the facts by blocked ref ("repo#number"), from one scan of the latest holds. For a page of decisions. */
export function blocksIndex(db: DatabaseSync, hidden: HiddenRepos): Map<string, string[]> {
  const rows = db.prepare(`SELECT o.repo, o.number, o.at, o.blocked_by FROM main.opus_reviews o JOIN main.items i ON i.repo = o.repo AND i.number = o.number AND i.state = 'OPEN'
    WHERE o.verdict = 'hold' AND o.blocked_by LIKE '%"%'
      AND o.rowid = (SELECT l.rowid FROM main.opus_reviews l WHERE l.repo = o.repo AND l.number = o.number AND l.verdict IS NOT NULL ORDER BY l.at DESC, l.rowid DESC LIMIT 1)
    ORDER BY o.repo, o.number`).all() as { repo: string; number: number; at: string; blocked_by: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (isHiddenRepo(hidden, r.repo)) continue;
    const self = `${r.repo}#${r.number}`;
    for (const ref of activeBlockers(db, self, r.blocked_by, r.at)) {
      const facts = out.get(ref) ?? [];
      if (facts.length < 5) facts.push(`Blocks the review of ${self}`);
      out.set(ref, facts);
    }
  }
  return out;
}

/**
 * activeBlockers() and hasOpenQuestion() for many PRs, for one planner pass: the items, open decisions and latest reviews of the
 * refs are read in one batch per new set of refs, starting with every ref a stored hold names.
 */
export function blockersLoader(db: DatabaseSync): { active: (self: string, stored: string | null | undefined, at: string, nowMs?: number) => string[]; openQuestion: (refs: readonly string[]) => boolean } {
  const items = new Map<string, { kind: string; state: string } | null>();
  const pending = new Set<string>();
  const latest = new Map<string, { verdict: string; blocked_by: string | null }>();
  // Keyed as the per-ref reads look them up: repo and numeric number.
  const key = (ref: string): string | null => { const m = REF.exec(ref); return m ? `${m[1]}#${Number(m[2])}` : null; };
  const ensure = (refs: readonly string[]): void => {
    const pairs = [...new Set(refs.map(key))].filter((k): k is string => k !== null && !items.has(k)).map((k) => [k.slice(0, k.lastIndexOf("#")), Number(k.slice(k.lastIndexOf("#") + 1))] as const);
    if (!pairs.length) return;
    const p = JSON.stringify(pairs);
    for (const [repo, n] of pairs) items.set(`${repo}#${n}`, null);
    for (const r of db.prepare("SELECT i.repo || '#' || i.number AS k, i.kind, i.state FROM json_each(?) j JOIN main.items i ON i.repo = j.value ->> 0 AND i.number = j.value ->> 1").all(p) as { k: string; kind: string; state: string }[])
      items.set(r.k, { kind: r.kind, state: r.state });
    for (const r of db.prepare("SELECT DISTINCT d.repo || '#' || d.number AS k FROM json_each(?) j JOIN main.decisions d ON d.repo = j.value ->> 0 AND d.number = j.value ->> 1 WHERE d.answer IS NULL").all(p) as { k: string }[])
      pending.add(r.k);
    for (const r of db.prepare(`SELECT o.repo || '#' || o.number AS k, o.verdict, o.blocked_by FROM json_each(?) j JOIN main.opus_reviews o ON o.repo = j.value ->> 0 AND o.number = j.value ->> 1
      WHERE o.verdict IS NOT NULL ORDER BY o.at DESC, o.rowid DESC`).all(p) as { k: string; verdict: string; blocked_by: string | null }[]) if (!latest.has(r.k)) latest.set(r.k, r);
  };
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    ensure((db.prepare("SELECT DISTINCT blocked_by FROM main.opus_reviews WHERE verdict = 'hold' AND blocked_by IS NOT NULL").all() as { blocked_by: string }[]).flatMap((r) => storedBlockedBy(r.blocked_by)));
  };
  const openQuestion = (refs: readonly string[]): boolean => { start(); ensure(refs); return refs.some((r) => { const k = key(r); return k !== null && pending.has(k); }); };
  const active = (self: string, stored: string | null | undefined, at: string, nowMs: number = Date.now()): string[] => {
    const refs = storedBlockedBy(stored);
    if (!refs.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
    start();
    ensure(refs);
    return refs.filter((ref) => {
      const k = key(ref), i = k !== null ? items.get(k) : null;
      if (!i || i.state !== "OPEN") return false;
      if (i.kind !== "pr" && !pending.has(k!)) return false;
      const l = latest.get(k!);
      return !(l?.verdict === "hold" && storedBlockedBy(l.blocked_by).includes(self));
    });
  };
  return { active, openQuestion };
}
