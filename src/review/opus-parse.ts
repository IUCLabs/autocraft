// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { VERDICTS, type ReviewVerdict } from "./parse.ts";

export type SonnetView = { verdict: string; reason: string; fixes: { file: string; change: string }[]; risks: string[] };
export type EarlierOpus = { head: string; verdict: string; sure: boolean; reason: string; fixes: { file: string; change: string }[] };

/** One PR as the Opus prompt shows it. Every string field is untrusted or derived from untrusted text. */
export type OpusPr = {
  ref: string;
  /** Where the call may read the repository inside the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
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
  sonnet: SonnetView;
  /** full: the whole diff of the PR. delta: only the changes since `earlier_opus.head`. */
  mode: "full" | "delta";
  earlier_opus: EarlierOpus | null;
  diff: string;
};

export type OpusReview = {
  ref: string;
  verdict: ReviewVerdict;
  sure: boolean;
  reason: string;
  fixes: { file: string; change: string }[];
  risks: string[];
};

export const OPUS_REASON_WORDS = 60;
export const OPUS_MAX_FIXES = 20;
const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

/**
 * The one review for `ref` in a reply, or null. The text from the first "{" to the
 * last "}" is parsed (a one-element array is read too); take-fix needs at least one fix.
 */
export function parseOpusReply(text: string, ref: string): OpusReview | null {
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
    .filter((f): f is { file: string; change: string } => !!f && typeof f.file === "string" && typeof f.change === "string" && !!f.change.trim())
    .slice(0, OPUS_MAX_FIXES).map((f) => ({ file: f.file.slice(0, 200), change: f.change.slice(0, 800) }));
  if (verdict === "take-fix" && !fixes.length) return null;
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  return { ref, verdict: verdict as ReviewVerdict, sure: r.sure, reason: words(r.reason, OPUS_REASON_WORDS), fixes: verdict === "take-fix" ? fixes : [], risks };
}
