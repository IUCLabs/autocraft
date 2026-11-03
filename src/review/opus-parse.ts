// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { VERDICTS, type DiscussionEntry, type ReviewVerdict } from "./parse.ts";
import { firstSentence, oneSentence, proseField, SUMMARY_MAX_WORDS, WHY_MAX_WORDS, wordCount } from "../prose.ts";
import type { LintProblem } from "../replylint.ts";

export type EarlierOpus = { head: string; verdict: string; sure: boolean; reason: string; fixes: { file: string; change: string }[] };

/** A change an earlier review asked for (a take-fix at `head`) that was never made or posted. */
export type UnappliedFix = { head: string; file: string; change: string };

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
  /** Present only when an earlier take-fix's fixes were never applied; the reply must keep or explain each. */
  unapplied_fixes?: UnappliedFix[];
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

/** `drop`: texts the reply lint still flagged after the fix turn (a reference mention, a quote, a reference to outside documentation); they are left out like a reference mention. */
export function parsePublic(v: unknown, drop: ReadonlySet<string> = new Set()): PublicReview | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== "string" || !o.summary.trim() || !Array.isArray(o.points)) return null;
  if (REFERENCE_LEAK.test(o.summary) || drop.has(o.summary)) { console.log("public review dropped: its summary mentions the reference documentation"); return null; }
  const kept = o.points.filter((x): x is string => typeof x === "string" && !!x.trim());
  const points = kept.slice(0, OPUS_PUBLIC_POINTS).filter((x) => !REFERENCE_LEAK.test(x) && !drop.has(x)).map((x) => x.trim().slice(0, 600));
  if (points.length < kept.length) console.log("public review: dropped a point that mentions the reference documentation");
  return { summary: o.summary.trim().slice(0, 600), points };
}

export const OPUS_REASON_WORDS = 60;
export const OPUS_MAX_FIXES = 20;
const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

/** The reply's JSON object (a one-element array is read too), or null. */
function replyObject(text: string): unknown {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  const c = text.indexOf("{"), d = text.lastIndexOf("}");
  try {
    if (a >= 0 && b > a && (c < 0 || a < c)) return (JSON.parse(text.slice(a, b + 1)) as unknown[])[0];
    return c >= 0 && d > c ? JSON.parse(text.slice(c, d + 1)) : null;
  } catch { return null; }
}

/**
 * The one review for `ref` in a reply, or null. The text from the first "{" to the
 * last "}" is parsed (a one-element array is read too); take-fix needs at least one fix.
 * A summary or why over its word cap fails the reply unless `last`, which keeps its first sentence.
 * `drop`: see parsePublic. `keepLeaky`: keep fixes that mention the reference (the lint checks validity this way, so the fix turn can handle them; the stored review always drops them).
 */
export function parseOpusReply(text: string, ref: string, last = true, drop: ReadonlySet<string> = new Set(), keepLeaky = false): OpusReview | null {
  const o = replyObject(text);
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.ref !== ref) return null;
  const verdict = r.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (typeof r.reason !== "string" || !r.reason.trim() || typeof r.sure !== "boolean") return null;
  const fixes = (Array.isArray(r.fixes) ? r.fixes : [])
    .filter((f): f is { file: string; change: string } => !!f && typeof f.file === "string" && typeof f.change === "string" && !!f.change.trim() && (keepLeaky || (!REFERENCE_LEAK.test(f.file) && !REFERENCE_LEAK.test(f.change))))
    .slice(0, OPUS_MAX_FIXES).map((f) => ({ file: f.file.slice(0, 200), change: f.change.slice(0, 800) }));
  if (verdict === "take-fix" && !fixes.length) return null;
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  const summary = proseField(r.summary, SUMMARY_MAX_WORDS, last), why = proseField(r.why, WHY_MAX_WORDS, last);
  if (!summary.ok || !why.ok) return null;
  return { ref, verdict: verdict as ReviewVerdict, sure: r.sure, reason: words(r.reason, OPUS_REASON_WORDS), fixes: verdict === "take-fix" ? fixes : [], risks, summary: summary.text, why: oneSentence(why.text), public: parsePublic(r.public, drop) };
}

/** How a review treats an earlier fix: kept in its fix list, explained in its reason (which names the file), or neither. */
export function carriedOutcome(r: { verdict: string; reason: string; fixes: { file: string }[] }, fix: { file: string }): "kept" | "explained" | "unaddressed" {
  if (r.verdict === "take-fix" && r.fixes.some((f) => f.file === fix.file)) return "kept";
  const reason = r.reason.toLowerCase(), path = fix.file.toLowerCase();
  return reason.includes(path) || reason.includes(path.slice(path.lastIndexOf("/") + 1)) ? "explained" : "unaddressed";
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The problems of a reply that the model can fix itself: a reference mention in a fix, a summary or why over its cap,
 * a why of more than one sentence, an unapplied fix a take ignores. Null when the reply is not a valid review (the whole call is asked again then).
 */
export function lintOpusReply(text: string, ref: string, unapplied: readonly UnappliedFix[] = []): LintProblem[] | null {
  const parsed = parseOpusReply(text, ref, true, new Set(), true);
  if (!parsed) return null;
  const r = replyObject(text) as Record<string, unknown>;
  const out: LintProblem[] = [];
  // A take-fix keeps the list the model chose; a hold or close makes the old fixes moot. Only a take that ignores them is a problem.
  if (parsed.verdict === "take" && !parsed.fixes.length) {
    unapplied.forEach((u, i) => {
      if (carriedOutcome(parsed, u) === "unaddressed") out.push({ field: `unapplied_fixes[${i}]`, message: `(${u.file}) is neither in fixes nor explained in reason` });
    });
  }
  (Array.isArray(r.fixes) ? r.fixes : []).forEach((f: { file?: unknown; change?: unknown }, i) => {
    for (const k of ["file", "change"] as const) if (typeof f?.[k] === "string" && REFERENCE_LEAK.test(f[k] as string)) out.push({ field: `fixes[${i}].${k}`, message: "mentions the reference folder or one of its pages; state the behaviour in your own words" });
  });
  if (typeof r.summary === "string" && wordCount(r.summary) > SUMMARY_MAX_WORDS) out.push({ field: "summary", message: `has ${wordCount(r.summary)} words; at most ${SUMMARY_MAX_WORDS}, in 2 or 3 sentences` });
  if (typeof r.why === "string" && squash(r.why)) {
    if (wordCount(r.why) > WHY_MAX_WORDS) out.push({ field: "why", message: `has ${wordCount(r.why)} words; at most ${WHY_MAX_WORDS}, in one sentence` });
    else if (firstSentence(r.why) !== squash(r.why)) out.push({ field: "why", message: "has more than one sentence; write one" });
  }
  return out;
}

/** The public texts of a reply for the reference checks, with the field each is in (the index is the position in the reply's `points` array). */
export function publicTexts(text: string): { field: string; text: string }[] {
  const r = replyObject(text) as { public?: { summary?: unknown; points?: unknown } } | null;
  const p = r?.public;
  if (!p || typeof p !== "object") return [];
  return [
    ...(typeof p.summary === "string" && p.summary.trim() ? [{ field: "public.summary", text: p.summary }] : []),
    // Only the points parsePublic keeps (the first OPUS_PUBLIC_POINTS non-empty ones), so a long list makes no extra checks.
    ...(Array.isArray(p.points) ? p.points.flatMap((x, i) => (typeof x === "string" && x.trim() ? [{ field: `public.points[${i}]`, text: x }] : [])).slice(0, OPUS_PUBLIC_POINTS) : []),
  ];
}
