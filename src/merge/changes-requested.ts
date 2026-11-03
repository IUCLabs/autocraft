// A formal "changes requested" review by someone with write access blocks the merge. GitHub's rule: a
// reviewer's CHANGES_REQUESTED stands, across pushes, until that reviewer approves or the review is dismissed.
// Comments and COMMENTED reviews neither block nor clear it. `reviewDecision` alone cannot decide this: it is
// null when the repo does not require reviews.
//
// Live reads (GraphQL `latestOpinionatedReviews(writersOnly: true)`) are decided on write access, because
// `authorAssociation` is relative to the viewer: a private org member can show as CONTRIBUTOR or NONE.
// The mirror stores only the association, so there a reviewer blocks unless the association says a stranger.
import type { DatabaseSync } from "node:sqlite";

export type ReviewFact = { id?: string | null; author: string | null; association: string | null; state: string | null; at: string | null };

/** Selection of the latest review per reviewer with write access, shared by every live read. */
export const FORMAL_REVIEWS = "latestOpinionatedReviews(first: 100, writersOnly: true) { nodes { id author { login } authorAssociation createdAt submittedAt state } }";

/** Associations that cannot be a maintainer. Anything else, and an unknown association, may be one. */
const STRANGER = ["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN"];
const FORMAL = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

/** Logins whose latest formal review in the mirror is CHANGES_REQUESTED, unless their association rules them out. */
export function changesRequestedBy(reviews: ReviewFact[]): string[] {
  const latest = new Map<string, ReviewFact>();
  const ordered = reviews.map((r, i) => ({ r, i })).sort((a, b) => (a.r.at ?? "").localeCompare(b.r.at ?? "") || a.i - b.i);
  for (const { r } of ordered) {
    if (!r.author || !FORMAL.includes(r.state ?? "")) continue;
    latest.set(r.author, r);
  }
  return [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED" && !STRANGER.includes(r.association ?? "")).map((r) => r.author!).sort();
}

/** Logins of a live writers-only read whose latest review is CHANGES_REQUESTED. */
export const blockedByWriters = (formal: ReviewFact[]): string[] => formal.filter((r) => r.state === "CHANGES_REQUESTED" && r.author).map((r) => r.author!).sort();

const REASON = "changes requested by a maintainer";
export const reasonFor = (by: string[]): string => `${REASON} (${by.join(", ")})`;

/** Why the mirrored reviews block the merge, or null. `decision` is GitHub's reviewDecision, an extra signal when the review list is cut short. */
export function refuseReviews(reviews: ReviewFact[], decision?: string | null): string | null {
  const by = changesRequestedBy(reviews);
  if (by.length) return reasonFor(by);
  return decision === "CHANGES_REQUESTED" ? REASON : null;
}

/** Why a live writers-only read blocks the merge, or null. */
export function refuseLive(formal: ReviewFact[], decision?: string | null): string | null {
  const by = blockedByWriters(formal);
  if (by.length) return reasonFor(by);
  return decision === "CHANGES_REQUESTED" ? REASON : null;
}

/** Association stored for a review a writers-only read returned: the read's own association is relative to the viewer and may say NONE. */
export const WRITER = "WRITER";

/** Writes what a live read saw back to the mirror, so the queue agrees with it before the next sync. Existing rows keep their text. */
export function recordFormalReviews(db: DatabaseSync, repo: string, number: number, formal: ReviewFact[]): void {
  const up = db.prepare(`INSERT INTO comments (repo, number, id, kind, author, created_at, body, review_state, counted, author_association)
    VALUES (?, ?, ?, 'review', ?, ?, '', ?, 0, ?) ON CONFLICT (id) DO UPDATE SET review_state = excluded.review_state, author_association = excluded.author_association`);
  for (const r of formal) if (r.id && r.author) up.run(repo, number, r.id, r.author, r.at, r.state, WRITER);
}
