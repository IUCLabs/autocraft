// Which conflicted take / take-fix PRs the fix-up step merges the default branch into, from the local tables only.
import type { DatabaseSync } from "node:sqlite";
import { fastScoreSql } from "../fasttrack.ts";
import { notHeldSql } from "../dupes/held.ts";
import { headOf } from "../review/candidates.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { pushApprovalOf } from "./approval.ts";
import { staleReviews } from "../review/discussion.ts";
import { mergeHeld } from "../merge/holds.ts";
import { activeBatches, membersOf } from "../merge/batch-store.ts";
import { longLivedOf, pushable } from "./pushable.ts";

/** Base branch names the merge accepts as a fetch ref. */
export const BASE_NAME = /^[A-Za-z0-9._/-]+$/;

/** Merge tries per head (pushed, failed, refused or rejected) before the PR is left to a person. */
export const MAX_CONFLICT_TRIES = 2;

export const CONFLICT_STATES = ["merged", "failed", "refused", "rejected", "asked", "skipped", "cannot-push", "push-denied"] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];
const TRY_STATES: ConflictState[] = ["merged", "failed", "refused", "rejected"];

export type ConflictCandidate = {
  repo: string; number: number; head: string; /** The PR's base branch name. */ base: string; title: string;
  /** The final review's reason. */ reason: string; attempt: number; pushable: boolean;
};
/** merge: we will merge the base in; ask: comment once asking the contributor; asked: that comment is posted; held: nothing to do without a person (two tries used, a deterministic skip recorded at this head, or no comment approval for a branch we can't push to); unapproved: pushable but the repo has no push approval; done: merged at this head already. */
export type ConflictBucket = "merge" | "ask" | "asked" | "held" | "unapproved" | "done";
export type ConflictClassified = { c: ConflictCandidate; bucket: ConflictBucket };

export function conflictTries(db: DatabaseSync, repo: string, number: number, head: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM conflict_merges WHERE repo = ? AND number = ? AND from_head = ? AND state IN (${TRY_STATES.map(() => "?").join(",")})`)
    .get(repo, number, head, ...TRY_STATES) as { n: number }).n;
}

export function conflictBucket(db: DatabaseSync, p: { repo: string; number: number; head: string; pushable: boolean }, approvals: { push: boolean; comment: boolean }): ConflictBucket {
  const has = (state: string) => !!db.prepare("SELECT 1 FROM conflict_merges WHERE repo = ? AND number = ? AND from_head = ? AND state = ?").get(p.repo, p.number, p.head, state);
  if (has("merged")) return "done";
  if (has("skipped") || has("push-denied")) return "held";
  if (!p.pushable || has("cannot-push")) return has("asked") ? "asked" : approvals.comment ? "ask" : "held";
  if (conflictTries(db, p.repo, p.number, p.head) >= MAX_CONFLICT_TRIES) return "held";
  return approvals.push ? "merge" : "unapproved";
}

/** The queue's note for a conflicted PR, or null when nothing here acts on it. */
export function conflictNote(bucket: ConflictBucket, base: string): string | null {
  switch (bucket) {
    case "merge": return `conflict: merging ${base}`;
    case "ask": case "asked": return "conflict: asked the contributor";
    case "held": return "conflict: held";
    default: return null;
  }
}

type Row = {
  repo: string; number: number; title: string | null; head_oid: string | null; head_repo: string | null; head_ref: string | null; base_ref: string | null; updated_at: string | null; is_draft: number | null; i_mergeable: string | null; i_can: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null; c_mergeable: string | null; c_can: number | null;
};

/** Open, non-draft PRs with a take or take-fix final review at their current head that GitHub reports as conflicting. */
export function classifyConflicts(db: DatabaseSync, repo: string): ConflictClassified[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.head_oid, i.head_repo, i.head_ref, i.base_ref, i.updated_at, i.is_draft, i.mergeable AS i_mergeable, i.maintainer_can_modify AS i_can,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.mergeable AS c_mergeable, c.maintainer_can_modify AS c_can
    FROM items i LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY ${fastScoreSql("i.repo", "i.number", "p.score")} IS NULL, ${fastScoreSql("i.repo", "i.number", "p.score")} DESC, i.number`).all(repo) as Row[];
  const approvals = { push: pushApprovalOf(db, repo) !== null, comment: commentApprovalOf(db, repo) !== null };
  const longLived = longLivedOf(db, repo);
  const stale = staleReviews(db, repo);
  const batched = new Set(activeBatches(db, repo).flatMap((b) => membersOf(db, b.id).map((m) => m.number)));
  const out: ConflictClassified[] = [];
  for (const r of rows) {
    const fresh = !!r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    if ((fresh ? r.c_mergeable : r.i_mergeable) !== "CONFLICTING") continue;
    const head = headOf({ head_oid: r.head_oid, updated_at: r.updated_at, c_head: r.c_head, c_at: r.c_at });
    if (!head || !r.base_ref || !BASE_NAME.test(r.base_ref)) continue;
    if (mergeHeld(db, r.repo, r.number) || batched.has(r.number) || stale.has(`${r.repo}#${r.number}@${head}`)) continue;
    const review = db.prepare("SELECT reason FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IN ('take', 'take-fix')").get(r.repo, r.number, head) as { reason: string } | undefined;
    if (!review) continue;
    const can = pushable(r.head_repo, r.repo, fresh ? r.c_can : r.i_can, r.head_ref, longLived);
    const c: ConflictCandidate = { repo: r.repo, number: r.number, head, base: r.base_ref, title: (r.title ?? "").slice(0, 300), reason: review.reason, attempt: conflictTries(db, r.repo, r.number, head) + 1, pushable: can };
    out.push({ c, bucket: conflictBucket(db, { repo: r.repo, number: r.number, head, pushable: can }, approvals) });
  }
  return out;
}
