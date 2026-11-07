// Reply lint: checks a parsed reply for problems the model can fix itself, and the one follow-up message that
// sends them back. No I/O and no Node imports: the prompt registry imports this file.

/** One problem of a reply: the field it is in and what is wrong, in one short line. `text` is the offending text where the fallback needs to find it again. */
export type LintProblem = {
  field: string; message: string; text?: string;
  /** Reply fields the fix turn returns for this problem when `field` is not itself a reply field (default: `field`). */
  fix?: string[];
  /** The text is never posted or shown to viewers: the problem is recorded and the model is not asked to fix it. */
  internal?: boolean;
};

/** Problems of a reply, or null when the reply cannot be read at all (the caller's own validation decides what happens then). */
/** `stage`: "first" for the model's first reply, "fix" for the reply to a fix turn (the costly checks may wait for the second). */
export type Lint = (text: string, stage: "first" | "fix") => Promise<LintProblem[] | null> | LintProblem[] | null;

/** The offending texts of problems the fix turn did not clear, for the fallback that leaves them out. */
export const dropTexts = (problems: readonly LintProblem[] | undefined): Set<string> => new Set((problems ?? []).flatMap((p) => (p.text === undefined ? [] : [p.text])));

/** Whether a fix turn is worth its cost: at least one problem is in text that is posted or shown. */
export const needsFixTurn = (problems: readonly LintProblem[]): boolean => problems.some((p) => p.internal !== true);

const fieldsOf = (problems: readonly LintProblem[]): string[] => [...new Set(problems.filter((p) => p.internal !== true).flatMap((p) => p.fix ?? [p.field]))];

/** The follow-up message: fixed text around the list, so the prompt cache covers everything but the problems. The turn runs with no tools and one turn, and returns only the flagged fields. */
export function fixTurnMessage(problems: readonly LintProblem[]): string {
  const list = problems.filter((p) => p.internal !== true);
  return `Your reply has these problems:\n${list.map((p) => `- ${p.field}: ${p.message}`).join("\n")}\nDo not use tools. Send only the corrected fields as one JSON object whose keys are these field names exactly (${fieldsOf(problems).join(", ")}) and whose values are the corrected values, in the same format as in your reply. Send nothing else.`;
}

const jsonRoot = (text: string): { root: unknown; array: boolean } | null => {
  const a = text.indexOf("["), b = text.lastIndexOf("]"), c = text.indexOf("{"), d = text.lastIndexOf("}");
  try {
    if (a >= 0 && b > a && (c < 0 || a < c)) { const arr = JSON.parse(text.slice(a, b + 1)) as unknown[]; return arr.length === 1 ? { root: arr, array: true } : null; }
    return c >= 0 && d > c ? { root: JSON.parse(text.slice(c, d + 1)), array: false } : null;
  } catch { return null; }
};

const isObj = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === "object" && v !== null;

/** Sets `path` (`public.points[1]`, `claims[0].claim`) in `target`; only where the parent exists, or a new top-level key. */
function setPath(target: Record<string, unknown>, path: string): ((v: unknown) => void) | null {
  const keys = path.match(/[^.[\]]+/g);
  if (!keys?.length) return null;
  let node: unknown = target;
  for (const k of keys.slice(0, -1)) { if (!isObj(node)) return null; node = (node as Record<string, unknown>)[k]; }
  const last = keys[keys.length - 1]!;
  if (!isObj(node)) return null;
  if (Array.isArray(node) ? !/^\d+$/.test(last) || Number(last) >= node.length : !(last in node) && keys.length > 1) return null;
  return (v) => { (node as Record<string, unknown>)[last] = v; };
}

/**
 * The first reply with the fix turn's corrected fields put in. Only the fields the problems asked for are taken, and only where they exist in the first reply
 * (or are new top-level fields); the rest stays as the first turn wrote it. Null when the fix reply is not a JSON object or nothing could be put in.
 */
export function mergeFixFields(original: string, fix: string, problems: readonly LintProblem[]): string | null {
  const o = jsonRoot(original), f = jsonRoot(fix);
  if (!o || !f || f.array || !isObj(f.root) || Array.isArray(f.root)) return null;
  const target = o.array ? (o.root as unknown[])[0] : o.root;
  if (!isObj(target) || Array.isArray(target)) return null;
  const patch = f.root as Record<string, unknown>;
  let put = 0;
  for (const field of fieldsOf(problems)) {
    if (!(field in patch)) continue;
    const set = setPath(target as Record<string, unknown>, field);
    if (!set) continue;
    set(patch[field]);
    put++;
  }
  return put ? JSON.stringify(o.root) : null;
}

/** The semantic reference check accepts a yes from Jev at this probability or more, and a no below the second one; Haiku decides in between. */
export const REFERENCE_JEV_ACCEPT = 0.9;
export const REFERENCE_JEV_REJECT = 0.3;

/** What lint.reference.haiku is asked about: one text with the ref of the item it is written for. */
export type ReferenceLintInput = { ref: string; text: string };

export const SAMPLE_REFERENCE_LINT: ReferenceLintInput[] = [{ ref: "app#1", text: "The 16-bit PNG export keeps its size after a resize, as the user guide describes." }];

/** A run of this many consecutive words of a public text that also appears in the reference pages counts as a quote. */
export const QUOTE_WORDS = 12;
