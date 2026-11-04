// Pre-merge review reply validation. No I/O and no Node imports: the prompt registry (also loaded by the web mockup)
// imports this file.
import { safePath } from "../fixup/patch.ts";
import type { LintProblem } from "../replylint.ts";
import { OPUS_MAX_FIXES, REFERENCE_LEAK, parseStatementConflicts, type StatementConflict, type OwnerStatement } from "../review/opus-parse.ts";
import type { PremergeFinding } from "./types.ts";

export const PREMERGE_MAX_FINDINGS = 30;
export const PREMERGE_TITLE_CHARS = 160;
export const PREMERGE_SCENARIO_CHARS = 1500;
export const PREMERGE_FILE_CHARS = 300;
export const PREMERGE_FIX_CHARS = 800;
export const PREMERGE_SEARCHED_CHARS = 400;

export type PremergeReview = { findings: PremergeFinding[]; searched: string | null; conflicts: StatementConflict[] };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function replyObject(text: string): Record<string, unknown> | null {
  const c = text.indexOf("{"), d = text.lastIndexOf("}");
  if (c < 0 || d <= c) return null;
  try {
    const v = JSON.parse(text.slice(c, d + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

type Entry = { index: number; severity: "defect" | "minor"; file: string; line: number; title: string; scenario: string; fix?: { file: string; change: string } };

/** The well-formed entries of a valid reply (null when the reply is not valid), with the fixes over the cap already removed. */
function entries(text: string, ref: string): { entries: Entry[]; searched: string | null; conflicts: unknown } | null {
  const o = replyObject(text);
  if (!o || o.ref !== ref || !Array.isArray(o.findings)) return null;
  const out: Entry[] = [];
  let fixes = 0;
  o.findings.slice(0, PREMERGE_MAX_FINDINGS).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const f = raw as Record<string, unknown>;
    if (f.severity !== "defect" && f.severity !== "minor") return;
    if (typeof f.file !== "string" || typeof f.title !== "string" || typeof f.scenario !== "string") return;
    const file = f.file.trim().slice(0, PREMERGE_FILE_CHARS), title = clean(f.title).slice(0, PREMERGE_TITLE_CHARS), scenario = f.scenario.trim().slice(0, PREMERGE_SCENARIO_CHARS);
    if (!file || !title || !scenario || typeof f.line !== "number" || !Number.isFinite(f.line)) return;
    const e: Entry = { index, severity: f.severity, file, line: Math.max(0, Math.round(f.line)), title, scenario };
    const x = f.fix as { file?: unknown; change?: unknown } | null | undefined;
    if (x && typeof x === "object" && typeof x.file === "string" && typeof x.change === "string" && x.change.trim() && safePath(x.file.trim()) && fixes < OPUS_MAX_FIXES) {
      e.fix = { file: x.file.trim().slice(0, PREMERGE_FILE_CHARS), change: x.change.trim().slice(0, PREMERGE_FIX_CHARS) };
      fixes++;
    }
    out.push(e);
  });
  return { entries: out, searched: typeof o.searched === "string" && o.searched.trim() ? clean(o.searched).slice(0, PREMERGE_SEARCHED_CHARS) : null, conflicts: o.conflicts };
}

const leaks = (...s: string[]) => s.some((x) => REFERENCE_LEAK.test(x));

/**
 * The review in a reply for `ref`, or null when the reply is not valid (wrong ref, no `findings` array). An empty list is
 * valid. An entry without a valid severity, file, line, title or scenario is dropped, and so is one whose title or scenario
 * mentions the reference documentation or is in `drop`; a fix with a leak, an unsafe path or past the fix cap is dropped
 * from its finding. `drop`: texts the reply lint still flagged after the fix turn.
 */
export function parsePremerge(text: string, ref: string, drop: ReadonlySet<string> = new Set(), known: readonly OwnerStatement[] = []): PremergeReview | null {
  const r = entries(text, ref);
  if (!r) return null;
  const findings: PremergeFinding[] = [];
  for (const e of r.entries) {
    if (leaks(e.title, e.scenario) || drop.has(e.title) || drop.has(e.scenario)) { console.log("pre-merge finding dropped: its text mentions the reference documentation"); continue; }
    const { index: _, fix, ...rest } = e;
    const fixOk = fix && !leaks(fix.file, fix.change) && !drop.has(fix.file) && !drop.has(fix.change);
    findings.push(fixOk ? { ...rest, fix } : rest);
  }
  // A dropped fix does not free its place under the cap: the cap counts the fixes the model offered.
  return { findings, searched: r.searched, conflicts: parseStatementConflicts(r.conflicts, known) };
}

/** The reference mentions in a valid reply that the model can fix itself; null when the reply is not valid. */
export function lintPremerge(text: string, ref: string): LintProblem[] | null {
  const r = entries(text, ref);
  if (!r) return null;
  const out: LintProblem[] = [];
  const msg = "mentions the reference folder or one of its pages; state the behaviour in your own words";
  for (const e of r.entries) {
    for (const [k, v] of [["title", e.title], ["scenario", e.scenario]] as const) if (REFERENCE_LEAK.test(v)) out.push({ field: `findings[${e.index}].${k}`, message: msg, text: v });
    if (e.fix) for (const [k, v] of [["file", e.fix.file], ["change", e.fix.change]] as const) if (REFERENCE_LEAK.test(v)) out.push({ field: `findings[${e.index}].fix.${k}`, message: msg, text: v });
  }
  return out;
}

/** The texts of a reply for the reference checks, with the field each is in: title, scenario and fix. They reach Merge? facts, the item page and fix-up commits. */
export function premergeTexts(text: string, ref: string): { field: string; text: string }[] {
  const r = entries(text, ref);
  if (!r) return [];
  return r.entries.flatMap((e) => [
    { field: `findings[${e.index}].title`, text: e.title }, { field: `findings[${e.index}].scenario`, text: e.scenario },
    ...(e.fix ? [{ field: `findings[${e.index}].fix.file`, text: e.fix.file }, { field: `findings[${e.index}].fix.change`, text: e.fix.change }] : []),
  ]);
}
