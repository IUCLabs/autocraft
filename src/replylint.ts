// Reply lint: checks a parsed reply for problems the model can fix itself, and the one follow-up message that
// sends them back. No I/O and no Node imports: the prompt registry imports this file.

/** One problem of a reply: the field it is in and what is wrong, in one short line. `text` is the offending text where the fallback needs to find it again. */
export type LintProblem = { field: string; message: string; text?: string };

/** Problems of a reply, or null when the reply cannot be read at all (the caller's own validation decides what happens then). */
/** `stage`: "first" for the model's first reply, "fix" for the reply to a fix turn (the costly checks may wait for the second). */
export type Lint = (text: string, stage: "first" | "fix") => Promise<LintProblem[] | null> | LintProblem[] | null;

/** The offending texts of problems the fix turn did not clear, for the fallback that leaves them out. */
export const dropTexts = (problems: readonly LintProblem[] | undefined): Set<string> => new Set((problems ?? []).flatMap((p) => (p.text === undefined ? [] : [p.text])));

/** The follow-up message: fixed text around the list, so the prompt cache covers everything but the problems. */
export function fixTurnMessage(problems: readonly LintProblem[]): string {
  return `Your reply has these problems:\n${problems.map((p) => `- ${p.field}: ${p.message}`).join("\n")}\nSend the complete reply again in the same format, fixing only these.`;
}

/** The semantic reference check accepts a yes from Jev at this probability or more, and a no below the second one; Haiku decides in between. */
export const REFERENCE_JEV_ACCEPT = 0.9;
export const REFERENCE_JEV_REJECT = 0.3;

/** What lint.reference.haiku is asked about: one text with the ref of the item it is written for. */
export type ReferenceLintInput = { ref: string; text: string };

export const SAMPLE_REFERENCE_LINT: ReferenceLintInput[] = [{ ref: "app#1", text: "The 16-bit PNG export keeps its size after a resize, as the user guide describes." }];

/** A run of this many consecutive words of a public text that also appears in the reference pages counts as a quote. */
export const QUOTE_WORDS = 12;
