// Priority score of an open item: pure functions, no I/O.
//
// The impact class sets a band of the 0-100 scale and the item's reach moves
// the score inside it:
//
//   critical  75-100   crash, data loss, security hole, build or install broken, app unusable
//   high      50-75    a core feature broken, a regression
//   normal    25-50
//   low        0-25    cosmetic, wording, docs, nice-to-have
//
// Reach is a number from 0 to 1, the weighted sum of these signals, each
// scaled to 0..1 and capped (the mirror holds no reactions, so they are not a signal):
//
//   commenters  0.25  distinct comment authors, capped at 8
//   comments    0.20  comment count, capped at 20
//   linked      0.15  PRs that close the issue, or issues the PR closes, capped at 3
//   duplicates  0.15  confirmed duplicates pointing at the item as the canonical one, capped at 5
//                     (each is another person who hit the same thing, like several reactions)
//   security    0.15  a classifier raised the security flag
//   age         0.10  days open, capped at 365 (older means people have waited longer)
//
// score = round(band low + (band high - band low) * reach)

export const IMPACTS = ["critical", "high", "normal", "low"] as const;
export type Impact = (typeof IMPACTS)[number];

export const IMPACT_MEANING: Record<Impact, string> = {
  critical: "A crash, data loss, a security hole, a broken build or install, or an app that cannot be used.",
  high: "A core feature is broken, or something that used to work no longer does (a regression).",
  normal: "An ordinary bug, feature or change that is neither urgent nor trivial.",
  low: "Cosmetic, wording, documentation, or a nice-to-have.",
};

export const BANDS: Record<Impact, readonly [number, number]> = {
  critical: [75, 100], high: [50, 75], normal: [25, 50], low: [0, 25],
};

/** Jev's probability for its impact choice from which the choice stands without Haiku. */
export const SURE = 0.9;

export type Reach = {
  comments: number;
  commenters: number;
  linked: number;
  duplicates: number;
  security: boolean;
  ageDays: number;
};

const frac = (n: number, cap: number): number => Math.min(Math.max(n, 0), cap) / cap;

export function reachOf(r: Reach): number {
  return 0.25 * frac(r.commenters, 8) + 0.20 * frac(r.comments, 20) + 0.15 * frac(r.linked, 3) + 0.15 * frac(r.duplicates, 5)
    + 0.15 * (r.security ? 1 : 0) + 0.10 * frac(r.ageDays, 365);
}

export function scoreOf(impact: Impact, r: Reach): number {
  const [lo, hi] = BANDS[impact];
  return Math.round(lo + (hi - lo) * reachOf(r));
}

export const isImpact = (v: unknown): v is Impact => typeof v === "string" && (IMPACTS as readonly string[]).includes(v);

/** The impact that counts: Jev's when it is sure, else Haiku's, else Jev's anyway. */
export function settleImpact(jev: { impact: Impact; p: number } | null, haiku: Impact | null): { impact: Impact; model: "jev" | "haiku" | "jev-unsure" } | null {
  if (jev && jev.p >= SURE) return { impact: jev.impact, model: "jev" };
  if (haiku) return { impact: haiku, model: "haiku" };
  return jev ? { impact: jev.impact, model: "jev-unsure" } : null;
}

export type JevImpactAnswers = { impact?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };

export function jevImpact(a: JevImpactAnswers | undefined): { impact: Impact; p: number } | null {
  const t = a?.impact;
  if (!t || !isImpact(t.choice)) return null;
  const p = t.probabilities?.[t.choice] ?? t.confidence;
  return typeof p === "number" ? { impact: t.choice, p } : null;
}

export type HaikuImpact = { ref: string; impact: Impact; reason: string };

/** Keeps one answer per asked ref with a known impact class. */
export function parseHaikuImpacts(text: string, refs: string[]): { answers: HaikuImpact[]; missing: string[] } {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  let arr: unknown;
  try { arr = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { arr = null; }
  const answers: HaikuImpact[] = [];
  if (Array.isArray(arr)) {
    for (const o of arr as Record<string, unknown>[]) {
      if (o && typeof o === "object" && refs.includes(String(o.ref)) && isImpact(o.impact) && !answers.some((x) => x.ref === o.ref))
        answers.push({ ref: String(o.ref), impact: o.impact, reason: String(o.reason ?? "").slice(0, 300) });
    }
  }
  return { answers, missing: refs.filter((r) => !answers.some((x) => x.ref === r)) };
}
