// Direction proposals: the input and reply of the directions.propose prompt. No I/O and no Node imports: the prompt registry
// (also loaded by the web mockup) imports this file.
import { REFERENCE_LEAK } from "./review/opus-parse.ts";

export const PROPOSAL_MAX_CHARS = 300;

/** A note an operator wrote (on a decision's answer, or in a comment on a closed item) for the model to judge. */
export type ProposalInput = {
  ref: string;
  repo: string;
  /** The item the note is about, when there is one. */
  item: { kind: string; title: string; state: string } | null;
  /** The decision's question and the answer that was chosen, for a decision note; null for a comment. */
  decision: { question: string; answer: string } | null;
  /** What the operator wrote. */
  note: string;
  /** The repo's active directions (their texts), so the draft does not repeat one. */
  directions: string[];
};

export const SAMPLE_PROPOSALS: ProposalInput[] = [{
  ref: "designcraft#1484", repo: "designcraft",
  item: { kind: "issue", title: "Hyphenation for Danish", state: "CLOSED" },
  decision: { question: "Keep this issue in core?", answer: "close" },
  note: "Close. Hyphenation and dictionaries belong in craft-libs, not in the app; same for every language feature like this.",
  directions: ["Keep new dependencies out of the app crates."],
}];

/** The draft direction of a reply for `ref`: text, or null when the note states no standing direction. A reply that is not valid gives undefined. */
export function parseProposalReply(text: string, ref: string): { draft: string | null } | undefined {
  const c = text.indexOf("{"), d = text.lastIndexOf("}");
  if (c < 0 || d <= c) return undefined;
  let o: unknown;
  try { o = JSON.parse(text.slice(c, d + 1)); } catch { return undefined; }
  const r = o as { ref?: unknown; direction?: unknown } | null;
  if (!r || typeof r !== "object" || r.ref !== ref || !("direction" in r)) return undefined;
  if (r.direction === null) return { draft: null };
  if (typeof r.direction !== "string") return undefined;
  const t = r.direction.replace(/\s+/g, " ").trim().slice(0, PROPOSAL_MAX_CHARS);
  return { draft: t && !REFERENCE_LEAK.test(t) ? t : null };
}
