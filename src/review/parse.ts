// Review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.

/** Characters kept of one discussion entry and of a PR's whole discussion. */
export const ENTRY_LIMIT = 1200;
export const TOTAL_LIMIT = 9000;

export type DiscussionEntry = {
  kind: "thread" | "review" | "comment" | "note";
  author?: string | null;
  at?: string | null;
  /** Reviews: APPROVED, CHANGES_REQUESTED or COMMENTED. */
  state?: string | null;
  /** Threads: where the comment sits. */
  path?: string;
  line?: number | null;
  /** Threads: the code the comment is about has since changed. */
  outdated?: boolean;
  body: string;
};

/** One PR as the review prompt shows it. Every string field is untrusted. */
export type ReviewPr = {
  ref: string;
  title: string;
  body: string;
  author_association: string | null;
  size: string;
  lines_changed: number;
  ci: string;
  mergeable: string | null;
  files: string[];
  tests_omitted: string[];
  lockfiles_omitted: string[];
  /** Other candidate PRs that change at least one of the same files. */
  same_files_as: { ref: string; title: string }[];
  diff: string;
  /** What others wrote on the PR; shown in its own block after the diff, not inside the PR's JSON. */
  discussion?: DiscussionEntry[];
};

export const REVIEW_BODY_LIMIT = 2000;
export const VERDICTS = ["take", "take-fix", "hold", "close"] as const;
export type ReviewVerdict = (typeof VERDICTS)[number];

export type Review = {
  ref: string;
  verdict: ReviewVerdict;
  reason: string;
  fixes: { file: string; change: string }[];
  duplicate_of: string | null;
  overlaps: string[];
  risks: string[];
};

const REF = /^[A-Za-z0-9._-]+#\d+$/;
const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

/**
 * Keeps one object per asked ref with a known verdict; take-fix needs at least
 * one fix. Reason is cut to 25 words, refs that are not `repo#n` are dropped.
 */
export function parseReviewReply(text: string, refs: string[]): { reviews: Review[]; missing: string[] } {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  let arr: unknown;
  try { arr = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { arr = null; }
  const reviews: Review[] = [];
  const seen = new Set<string>();
  if (Array.isArray(arr)) {
    for (const o of arr as Record<string, unknown>[]) {
      if (!o || typeof o !== "object") continue;
      const ref = String(o.ref ?? "");
      if (!refs.includes(ref) || seen.has(ref)) continue;
      const verdict = o.verdict;
      if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) continue;
      if (typeof o.reason !== "string" || !o.reason.trim()) continue;
      const fixes = (Array.isArray(o.fixes) ? o.fixes : [])
        .filter((f): f is { file: string; change: string } => !!f && typeof f.file === "string" && typeof f.change === "string" && !!f.change.trim())
        .slice(0, 10).map((f) => ({ file: f.file.slice(0, 200), change: f.change.slice(0, 500) }));
      if (verdict === "take-fix" && !fixes.length) continue;
      const strs = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, len)) : []);
      const dup = typeof o.duplicate_of === "string" && REF.test(o.duplicate_of) && o.duplicate_of !== ref ? o.duplicate_of : null;
      seen.add(ref);
      reviews.push({
        ref, verdict: verdict as ReviewVerdict, reason: words(o.reason, 25),
        fixes: verdict === "take-fix" ? fixes : [],
        duplicate_of: dup,
        overlaps: strs(o.overlaps, 20, 60).filter((r) => REF.test(r) && r !== ref),
        risks: strs(o.risks, 5, 300),
      });
    }
  }
  return { reviews, missing: refs.filter((r) => !seen.has(r)) };
}

/**
 * Owner rule: the weaker of two duplicates is closed only after the better one
 * has merged. A close that names an unmerged duplicate becomes a hold.
 */
export function applyDuplicateRule(r: Review, merged: (ref: string) => boolean): Review {
  if (r.verdict !== "close" || !r.duplicate_of || merged(r.duplicate_of)) return r;
  return { ...r, verdict: "hold", reason: words(`duplicate of ${r.duplicate_of}; close after it merges. ${r.reason}`, 25) };
}
