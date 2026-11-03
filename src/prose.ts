// Short model-written texts (summaries, one-sentence reasons). No I/O and no Node
// imports: the prompt registry imports it. Code never cuts such a text mid-sentence:
// an over-long one fails, the call is asked again once, and the last answer is
// stored as its first sentence.

/** Words a summary may have; the prompts ask for about 60. */
export const SUMMARY_MAX_WORDS = 80;
/** Words of the one-sentence reason behind a recommendation. */
export const WHY_MAX_WORDS = 30;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** The text up to and including its first sentence end; the whole text when it has none. */
export function firstSentence(s: string): string {
  const t = squash(s);
  return /^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
}

/**
 * Reads an optional prose field of a reply. Missing or empty: null, valid. Within `max` words: the text.
 * Over `max`: invalid unless `last` (the final attempt), then its first sentence.
 */
export function proseField(v: unknown, max: number, last: boolean): { ok: true; text: string | null } | { ok: false } {
  if (typeof v !== "string" || !squash(v)) return { ok: true, text: null };
  const t = squash(v);
  if (wordCount(t) <= max) return { ok: true, text: t };
  return last ? { ok: true, text: firstSentence(t) } : { ok: false };
}
