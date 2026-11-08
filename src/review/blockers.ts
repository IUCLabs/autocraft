// What can keep a PR's review from changing: another open item the review named as the reason for its hold.
import type { DatabaseSync } from "node:sqlite";

const REF = /^([\w.-]+)#(\d+)$/;

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

/** Adds a fact to each blocker's open decisions saying which PR it keeps from being reviewed. */
export function noteBlocks(db: DatabaseSync, blockers: readonly string[], pr: string): void {
  const open = db.prepare("SELECT id, facts FROM main.decisions WHERE repo = ? AND number = ? AND answer IS NULL");
  const fact = `Blocks the review of ${pr}`;
  for (const ref of blockers) {
    const m = REF.exec(ref);
    if (!m) continue;
    for (const d of open.all(m[1]!, Number(m[2])) as { id: string; facts: string | null }[]) {
      let facts: string[] = [];
      try { const v = JSON.parse(d.facts ?? "[]") as unknown; if (Array.isArray(v)) facts = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
      if (facts.includes(fact)) continue;
      db.prepare("UPDATE main.decisions SET facts = ? WHERE id = ?").run(JSON.stringify([...facts, fact]), d.id);
    }
  }
}
