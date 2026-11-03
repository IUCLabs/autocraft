// A formal "changes requested" review by a maintainer blocks the merge. GitHub's rule: a reviewer's
// CHANGES_REQUESTED stands, across pushes, until that reviewer approves or the review is dismissed. Comments
// and COMMENTED reviews do not clear it and are not a block themselves. `reviewDecision` alone cannot decide
// this: it is null when the repo does not require reviews.

export type ReviewFact = { author: string | null; association: string | null; state: string | null; at: string | null };

/** Reviewers whose "changes requested" blocks; other people's reviews are advice for the model review. */
export const BLOCKING_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
const FORMAL = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

/** Logins of the maintainers whose latest formal review is CHANGES_REQUESTED. `ignore` is our own pipeline account. */
export function changesRequestedBy(reviews: ReviewFact[], ignore = ""): string[] {
  const latest = new Map<string, ReviewFact>();
  const ordered = reviews.map((r, i) => ({ r, i })).sort((a, b) => (a.r.at ?? "").localeCompare(b.r.at ?? "") || a.i - b.i);
  for (const { r } of ordered) {
    if (!r.author || r.author === ignore || !FORMAL.includes(r.state ?? "")) continue;
    latest.set(r.author, r);
  }
  return [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED" && BLOCKING_ASSOCIATIONS.includes(r.association ?? "")).map((r) => r.author!).sort();
}

/** Why the reviews block the merge, or null. `decision` is GitHub's reviewDecision, an extra signal when the review list is cut short. */
export function refuseReviews(reviews: ReviewFact[], decision?: string | null, ignore = ""): string | null {
  const by = changesRequestedBy(reviews, ignore);
  if (by.length) return `changes requested by a maintainer (${by.join(", ")})`;
  return decision === "CHANGES_REQUESTED" ? "changes requested by a maintainer" : null;
}
