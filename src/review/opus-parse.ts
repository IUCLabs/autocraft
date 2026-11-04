// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { VERDICTS, type DiscussionEntry, type ReviewVerdict } from "./parse.ts";
import { firstSentence, oneSentence, proseField, SUMMARY_MAX_WORDS, WHY_MAX_WORDS, wordCount } from "../prose.ts";
import type { PostmergeReviewRow, RelatedItem } from "../postmerge/parse.ts";
import type { LintProblem } from "../replylint.ts";

export type EarlierOpus = { head: string; verdict: string; sure: boolean; reason: string; fixes: { file: string; change: string }[] };

/** A change an earlier review asked for (a take-fix at `head`) that was never made or posted. */
export type UnappliedFix = { head: string; file: string; change: string };

/** Something an owner said earlier about related work (table owner_statements), as the review prompt shows it. */
export type OwnerStatement = { id: number; where: string; kind: string; title: string; at: string; text: string };
/** A statement a review says the PR goes against, with a one-line reason. */
export type StatementConflict = { id: number; reason: string };

export const CONFLICT_REASON_CHARS = 300;
export const STATEMENT_PROMPT_CHARS = 800;

/** The `conflicts` of a reply: entries naming one of `known` (others are dropped), one per id, with a reason of text. Anything else gives an empty list. */
export function parseStatementConflicts(v: unknown, known: readonly { id: number }[] = []): StatementConflict[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set(known.map((d) => d.id)), seen = new Set<number>(), out: StatementConflict[] = [];
  for (const x of v) {
    const o = x as { id?: unknown; reason?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.id !== "number" || !ids.has(o.id) || seen.has(o.id)) continue;
    const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, CONFLICT_REASON_CHARS) : "";
    if (!reason || REFERENCE_LEAK.test(reason)) continue;
    seen.add(o.id);
    out.push({ id: o.id, reason });
  }
  return out;
}

/** The numbered list the prompt shows; the number is the statement's id. */
export const statementsList = (d: readonly OwnerStatement[] | undefined): string => (d?.length
  ? d.map((x) => `${x.id}. ${x.where} (${x.kind}: ${x.title}), ${x.at.slice(0, 10)}\n${x.text.replace(/\s+/g, " ").trim().slice(0, STATEMENT_PROMPT_CHARS)}`).join("\n\n")
  : "(none)");

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
  /** Present only when our pipeline pushed commits to the PR since `earlier_opus`'s head: kind, sha, note and the fixes each was meant to make. */
  pipeline_commits?: { kind: string; sha: string; note: string; fixes_meant: string[] }[];
  diff: string;
  /** Issues and PRs that mention this PR or its files, open or closed in the last 30 days (number, kind, state, title); the reviewer checks which of them the PR fixes. */
  related_open?: RelatedItem[];
  /** Pre-merge review only: what the first review concluded, for the second reviewer to check. */
  review_history?: PostmergeReviewRow[];
  /** What others wrote on the PR; shown in its own block after the diff, not inside the PR's JSON. */
  discussion?: DiscussionEntry[];
  /** Earlier owner statements about related work; shown in their own block after the PR, not inside the PR's JSON. */
  statements?: OwnerStatement[];
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
  /** The statements of `OpusPr.statements` that the PR goes against. */
  conflicts: StatementConflict[];
  /** The behavioural claims of the title and body, each checked against the code. */
  claims: Claim[];
};

export type ClaimStatus = "verified" | "contradicted" | "unverified";
/** What a contradicted or unverified claim means for the merge: the code is wrong, only the description is stale, or the model cannot tell. */
export type ClaimImpact = "code-wrong" | "description-only" | "unknown";
export type Claim = { claim: string; status: ClaimStatus; evidence: string; impact?: ClaimImpact; fix?: { file: string; change: string } };

export const MAX_CLAIMS = 12;
export const CLAIM_CHARS = 300;
export const CLAIM_EVIDENCE_CHARS = 600;
const FILE_LINE = /[\w./-]+\.\w+:\d+/;
const squashText = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The `claims` of a reply, or null when it is not an array. An entry needs a claim and a status; one that mentions the
 * reference documentation or is in `drop` is left out. Every claim needs file:line evidence: without it a "verified" counts as
 * unverified and any impact is "unknown", so a claim is only settled when the model points at code. A contradicted or unverified claim carries the model's `impact`
 * judgment; a missing or invalid one is "unknown".
 */
export function parseClaims(v: unknown, drop: ReadonlySet<string> = new Set()): Claim[] | null {
  if (!Array.isArray(v)) return null;
  const out: Claim[] = [];
  for (const x of v.slice(0, MAX_CLAIMS)) {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.claim !== "string") continue;
    const claim = squashText(o.claim).slice(0, CLAIM_CHARS), evidence = typeof o.evidence === "string" ? squashText(o.evidence).slice(0, CLAIM_EVIDENCE_CHARS) : "";
    if (!claim || (o.status !== "verified" && o.status !== "contradicted" && o.status !== "unverified")) continue;
    if (REFERENCE_LEAK.test(claim) || REFERENCE_LEAK.test(evidence) || drop.has(claim) || drop.has(evidence)) continue;
    const status: ClaimStatus = o.status === "verified" && !FILE_LINE.test(evidence) ? "unverified" : o.status;
    const f = o.fix as { file?: unknown; change?: unknown } | null | undefined;
    const fix = f && typeof f === "object" && typeof f.file === "string" && typeof f.change === "string" && f.file.trim() && f.change.trim() && !REFERENCE_LEAK.test(f.file + f.change)
      ? { file: f.file.trim().slice(0, 200), change: f.change.trim().slice(0, 800) } : undefined;
    if (status === "verified") { out.push({ claim, status, evidence }); continue; }
    const impact: ClaimImpact = FILE_LINE.test(evidence) && (o.impact === "code-wrong" || o.impact === "description-only") ? o.impact : "unknown";
    out.push(fix && impact === "code-wrong" ? { claim, status, evidence, impact, fix } : { claim, status, evidence, impact });
  }
  return out;
}

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
 * Claims rule: the code is what merges, not the description. A claim with impact "code-wrong" means the PR is not a take:
 * take-fix when every such claim names a fix, hold otherwise. "description-only" changes nothing. An "unknown" impact, or no
 * `claims` list for a PR with a body (`body`), makes a take or take-fix unsure.
 * `drop`: see parsePublic. `keepLeaky`: keep fixes that mention the reference (the lint checks validity this way, so the fix turn can handle them; the stored review always drops them).
 */
export function parseOpusReply(text: string, ref: string, last = true, drop: ReadonlySet<string> = new Set(), keepLeaky = false, known: readonly OwnerStatement[] = [], body = ""): OpusReview | null {
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
  const claims = parseClaims(r.claims, drop), listed = claims ?? [];
  const bad = listed.filter((c) => c.impact === "code-wrong"), unproven = claims === null ? !!body.trim() : listed.some((c) => c.impact === "unknown");
  let outVerdict = verdict as ReviewVerdict, outFixes = verdict === "take-fix" ? fixes : [], outReason = r.reason, sure = r.sure;
  const notes: string[] = [];
  if (bad.length && (outVerdict === "take" || outVerdict === "take-fix")) {
    const withFix = bad.filter((c) => c.fix);
    if (withFix.length === bad.length) { outVerdict = "take-fix"; outFixes = [...outFixes, ...withFix.map((c) => c.fix!)].slice(0, OPUS_MAX_FIXES); }
    else { outVerdict = "hold"; outFixes = []; }
    outReason = `Claim shows wrong code: ${bad[0]!.claim} ${r.reason}`;
    notes.push(...bad.map((c) => `claim ${c.status}, code wrong: ${c.claim}: ${c.evidence}`.slice(0, 300)));
  }
  if (unproven && (outVerdict === "take" || outVerdict === "take-fix")) {
    sure = false;
    notes.push(claims === null ? "the PR description's claims were not checked" : `claim ${listed.find((c) => c.impact === "unknown")!.status}, impact unknown: ${listed.find((c) => c.impact === "unknown")!.claim}`.slice(0, 300));
  }
  return { ref, verdict: outVerdict, sure, reason: words(outReason, OPUS_REASON_WORDS), fixes: outFixes, risks: [...risks, ...notes], summary: summary.text, why: oneSentence(why.text), public: parsePublic(r.public, drop), conflicts: parseStatementConflicts(r.conflicts, known), claims: listed };
}

/** The reply's reason before the word cut that the stored review applies. */
export function rawReason(text: string): string | null {
  const o = replyObject(text) as { reason?: unknown } | null;
  return typeof o?.reason === "string" ? o.reason : null;
}

/** How a review treats an earlier fix: kept in its fix list, explained in its reason (which names the file), or neither. Pass the uncut reason. */
export function carriedOutcome(r: { verdict: string; reason: string; fixes: { file: string }[] }, fix: { file: string }): "kept" | "explained" | "unaddressed" {
  if (!fix.file.trim()) return "unaddressed";
  if (r.verdict === "take-fix" && r.fixes.some((f) => f.file === fix.file)) return "kept";
  const reason = r.reason.toLowerCase(), path = fix.file.toLowerCase(), base = path.slice(path.lastIndexOf("/") + 1);
  const word = base ? new RegExp(`(?<![\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`) : null;
  return reason.includes(path) || (word?.test(reason) ?? false) ? "explained" : "unaddressed";
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The problems of a reply that the model can fix itself: a reference mention in a fix, a summary or why over its cap,
 * a why of more than one sentence, an unapplied fix a take ignores. Null when the reply is not a valid review (the whole call is asked again then).
 */
export function lintOpusReply(text: string, ref: string, unapplied: readonly UnappliedFix[] = [], body = ""): LintProblem[] | null {
  const parsed = parseOpusReply(text, ref, true, new Set(), true);
  if (!parsed) return null;
  const r = replyObject(text) as Record<string, unknown>;
  const out: LintProblem[] = [];
  if (body.trim() && !Array.isArray(r.claims)) out.push({ field: "claims", message: "is missing; list every behavioural claim of the title and body with its status and file:line evidence" });
  // A take-fix keeps the list the model chose; a hold or close makes the old fixes moot. Only a take that ignores them is a problem.
  if (parsed.verdict === "take" && !parsed.fixes.length) {
    unapplied.forEach((u, i) => {
      if (carriedOutcome({ ...parsed, reason: String(r.reason) }, u) === "unaddressed") {
        out.push({ field: `unapplied_fixes[${i}]`, message: `(${u.file}) is neither in fixes nor explained in reason; if the change is still needed, answer take-fix and list it; otherwise say in reason why it is no longer needed` });
      }
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
  const r = replyObject(text) as { public?: { summary?: unknown; points?: unknown }; claims?: unknown } | null;
  // Claims are posted with the review, so they get the same reference checks.
  const claimTexts = (parseClaims(r?.claims) ?? []).flatMap((c, i) => [{ field: `claims[${i}].claim`, text: c.claim }, ...(c.evidence ? [{ field: `claims[${i}].evidence`, text: c.evidence }] : [])]);
  const p = r?.public;
  if (!p || typeof p !== "object") return claimTexts;
  return [
    ...(typeof p.summary === "string" && p.summary.trim() ? [{ field: "public.summary", text: p.summary }] : []),
    // Only the points parsePublic keeps (the first OPUS_PUBLIC_POINTS non-empty ones), so a long list makes no extra checks.
    ...claimTexts,
    ...(Array.isArray(p.points) ? p.points.flatMap((x, i) => (typeof x === "string" && x.trim() ? [{ field: `public.points[${i}]`, text: x }] : [])).slice(0, OPUS_PUBLIC_POINTS) : []),
  ];
}
