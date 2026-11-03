// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { VERDICTS, type DiscussionEntry, type ReviewVerdict } from "./parse.ts";
import { proseField, SUMMARY_MAX_WORDS, WHY_MAX_WORDS } from "../prose.ts";

export type EarlierOpus = { head: string; verdict: string; sure: boolean; reason: string; fixes: { file: string; change: string }[] };

/** One PR as the Opus prompt shows it. Every string field is untrusted or derived from untrusted text. */
export type OpusPr = {
  ref: string;
  /** Where the call may read the repository inside the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  /** Set when the repo's reference folder is mounted at /reference; not part of the quoted JSON. */
  reference?: boolean;
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
  /** full: the whole diff of the PR. delta: only the changes since `earlier_opus.head`. */
  mode: "full" | "delta";
  earlier_opus: EarlierOpus | null;
  diff: string;
  /** What others wrote on the PR; shown in its own block after the diff, not inside the PR's JSON. */
  discussion?: DiscussionEntry[];
};

export type OpusReview = {
  ref: string;
  verdict: ReviewVerdict;
  sure: boolean;
  reason: string;
  fixes: { file: string; change: string }[];
  risks: string[];
  /** Two or three plain sentences for the person who decides; null when the reply had none. */
  summary: string | null;
  /** One short sentence: why the verdict, for a recommendation; null when the reply had none. */
  why: string | null;
  /** The text written for the PR author; null when the reply had none or it was malformed. */
  public: PublicReview | null;
};

export type PublicReview = { summary: string; points: string[] };

export const OPUS_PUBLIC_POINTS = 8;

/** Text that points at the private reference folder; such public text is dropped. */
export const REFERENCE_LEAK = /\/reference\b|\bp\d{4}\.txt\b/i;

export function parsePublic(v: unknown): PublicReview | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== "string" || !o.summary.trim() || !Array.isArray(o.points)) return null;
  if (REFERENCE_LEAK.test(o.summary)) { console.log("public review dropped: it mentions the reference folder"); return null; }
  const kept = o.points.filter((x): x is string => typeof x === "string" && !!x.trim());
  const points = kept.filter((x) => !REFERENCE_LEAK.test(x)).slice(0, OPUS_PUBLIC_POINTS).map((x) => x.trim().slice(0, 600));
  if (points.length < kept.length) console.log("public review: dropped a point that mentions the reference folder");
  return { summary: o.summary.trim().slice(0, 600), points };
}

export const OPUS_REASON_WORDS = 60;
export const OPUS_MAX_FIXES = 20;
const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

/**
 * The one review for `ref` in a reply, or null. The text from the first "{" to the
 * last "}" is parsed (a one-element array is read too); take-fix needs at least one fix.
 * A summary or why over its word cap fails the reply unless `last` (the final attempt), which keeps its first sentence.
 */
export function parseOpusReply(text: string, ref: string, last = true): OpusReview | null {
  let o: unknown;
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  const c = text.indexOf("{"), d = text.lastIndexOf("}");
  try {
    if (a >= 0 && b > a && (c < 0 || a < c)) o = (JSON.parse(text.slice(a, b + 1)) as unknown[])[0];
    else o = c >= 0 && d > c ? JSON.parse(text.slice(c, d + 1)) : null;
  } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.ref !== ref) return null;
  const verdict = r.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (typeof r.reason !== "string" || !r.reason.trim() || typeof r.sure !== "boolean") return null;
  const fixes = (Array.isArray(r.fixes) ? r.fixes : [])
    .filter((f): f is { file: string; change: string } => !!f && typeof f.file === "string" && typeof f.change === "string" && !!f.change.trim() && !REFERENCE_LEAK.test(f.file))
    .slice(0, OPUS_MAX_FIXES).map((f) => ({ file: f.file.slice(0, 200), change: f.change.slice(0, 800) }));
  if (verdict === "take-fix" && !fixes.length) return null;
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  const summary = proseField(r.summary, SUMMARY_MAX_WORDS, last), why = proseField(r.why, WHY_MAX_WORDS, last);
  if (!summary.ok || !why.ok) return null;
  return { ref, verdict: verdict as ReviewVerdict, sure: r.sure, reason: words(r.reason, OPUS_REASON_WORDS), fixes: verdict === "take-fix" ? fixes : [], risks, summary: summary.text, why: why.text, public: parsePublic(r.public) };
}
