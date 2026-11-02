// Which take-fix PRs the fix-up step works on, from the local tables only.
import { notHeldSql } from "../dupes/held.ts";
import type { DatabaseSync } from "node:sqlite";
import { headOf } from "../review/candidates.ts";
import { pushApprovalOf } from "./approval.ts";
import { safePath } from "./patch.ts";

/** Fix-up tries per PR (pushed, failed or refused) before the step leaves it to a person. */
export const MAX_ATTEMPTS = 2;

export type Fix = { file: string; change: string };
export type FixCandidate = { repo: string; number: number; head: string; reason: string; fixes: Fix[]; attempt: number };
export type FixSelection = {
  /** Take-fix PRs we may push to, in a repo with push approval. */
  fix: FixCandidate[];
  /** Take-fix PRs we can't push to that have no hold row at this head yet. */
  cannotPush: FixCandidate[];
};

type Row = {
  repo: string; number: number; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null;
  mergeable: string | null; can_modify: number | null;
};

export function parseFixes(s: string | null): Fix[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((f): f is Fix => !!f && typeof f.file === "string" && typeof f.change === "string" && safePath(f.file)) : [];
  } catch { return []; }
}

export const FIXUP_STATES = ["pushed", "failed", "refused", "cannot-push", "too-large"] as const;
export type FixupState = (typeof FIXUP_STATES)[number];

/** States that count as a try; the other two are recorded once per head and end the step's work on that head. */
const ATTEMPT_STATES: FixupState[] = ["pushed", "failed", "refused"];

export function attemptsOf(db: DatabaseSync, repo: string, number: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM fixups WHERE repo = ? AND number = ? AND state IN (${ATTEMPT_STATES.map(() => "?").join(",")})`)
    .get(repo, number, ...ATTEMPT_STATES) as { n: number }).n;
}

export function selectFixups(db: DatabaseSync, repo: string): FixSelection {
  const rows = db.prepare(`SELECT i.repo, i.number, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.mergeable, c.maintainer_can_modify AS can_modify
    FROM items i JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY p.score IS NULL, p.score DESC, i.number`).all(repo) as Row[];
  const done = db.prepare("SELECT 1 FROM fixups WHERE repo = ? AND number = ? AND from_head = ? AND state IN ('pushed', 'cannot-push', 'too-large')");
  const approved = pushApprovalOf(db, repo) !== null;
  const out: FixSelection = { fix: [], cannotPush: [] };
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head) continue;
    // The review row must be the one at the current head; reviews of older heads don't count.
    const review = db.prepare("SELECT reason, fixes FROM reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict = 'take-fix'").get(r.repo, r.number, head) as
      { reason: string; fixes: string | null } | undefined;
    if (!review) continue;
    if (r.mergeable === "CONFLICTING") continue;
    if (done.get(r.repo, r.number, head)) continue;
    const fixes = parseFixes(review.fixes);
    if (!fixes.length) continue;
    const c: FixCandidate = { repo: r.repo, number: r.number, head, reason: review.reason, fixes, attempt: attemptsOf(db, r.repo, r.number) + 1 };
    if (!r.can_modify) out.cannotPush.push(c);
    else if (approved && c.attempt <= MAX_ATTEMPTS) out.fix.push(c);
  }
  return out;
}
