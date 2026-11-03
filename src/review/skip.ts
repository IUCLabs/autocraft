// The skip list of the Opus pass: diffs a rule (never a model's opinion) exempts
// from the second review. Sonnet's take or take-fix then stands.
import { isLockfile, isTestPath, splitDiff, type FileDiff } from "./diff.ts";

/** Docs, translations and comments count only below this many changed lines in total. */
export const DOCS_MAX_LINES = 20;

const DOC_PATH = [/\.(md|mdx|markdown|rst)$/i];
const TRANSLATION_PATH = [/\.(ftl|po|pot|xlf|xliff)$/i];
// A docs or locale directory makes only non-code files docs: a code crate may be named `doc` or `i18n`.
const DOC_DIR = [/(^|\/)docs?\//i, /(^|\/)(locales?|i18n|l10n|translations?)\//i];
const SLASH_COMMENT = new Set(["rs", "ts", "tsx", "js", "jsx", "mjs", "kt", "java", "swift", "c", "h", "cc", "cpp", "hpp", "go", "cs", "scss", "css"]);
const HASH_COMMENT = new Set(["py", "sh", "toml", "yaml", "yml", "rb"]);

const extOf = (p: string): string => /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? "";
const CODE_EXT = new Set(["py", "sh", "rb", "go", "kt", "java", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "wgsl", "glsl", "toml", "json", "yaml", "yml"]);
const isCode = (p: string): boolean => CODE_EXT.has(extOf(p)) || SLASH_COMMENT.has(extOf(p)) || HASH_COMMENT.has(extOf(p));
const matches = (rs: RegExp[], p: string) => rs.some((r) => r.test(p));

/** The changed lines of one file diff, without their +/- mark. */
function changedLines(f: FileDiff): { removed: string[]; added: string[] } {
  const removed: string[] = [], added: string[] = [];
  for (const l of f.text.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added.push(l.slice(1));
    else if (l.startsWith("-")) removed.push(l.slice(1));
  }
  return { removed, added };
}

/** True when every changed line of a code file is a comment or blank. */
export function commentOnly(f: FileDiff): boolean {
  const ext = extOf(f.path);
  const { removed, added } = changedLines(f);
  const lines = [...removed, ...added];
  if (!lines.length) return false;
  if (SLASH_COMMENT.has(ext)) {
    // A leading `*` is a block-comment line only when the diff shows a block comment opening.
    const block = f.text.includes("/*");
    return lines.every((l) => /^\s*$/.test(l) || /^\s*\/\//.test(l) || /^\s*\/\*/.test(l) || /^\s*\*\/\s*$/.test(l) || (block && /^\s*\*(\s|$)/.test(l)));
  }
  if (HASH_COMMENT.has(ext)) return lines.every((l) => /^\s*$/.test(l) || /^\s*#/.test(l));
  return false;
}

const VERSION = /"[\^~=<>]*\d[^"\s]*"/g;
const normal = (lines: string[]) => lines.filter((l) => l.trim()).map((l) => l.replace(VERSION, '"V"').trim()).sort();

/** True when a manifest diff only changes version strings. */
export function versionOnly(f: FileDiff): boolean {
  const { removed, added } = changedLines(f);
  const a = normal(removed), b = normal(added);
  return a.length > 0 && a.length === b.length && a.every((l, i) => l === b[i]);
}

const isManifest = (p: string) => /(^|\/)(Cargo\.toml|package\.json)$/.test(p);

/**
 * Why the diff needs no Opus review, or null when it does:
 * docs, translations and comments only under DOCS_MAX_LINES changed lines;
 * lockfile and version bumps only with green CI; tests only.
 */
export function skipReason(diff: string, ci: string | null): string | null {
  const files = splitDiff(diff);
  if (!files.length) return null;
  const lines = files.reduce((s, f) => s + f.lines, 0);
  const docLike = (f: FileDiff) => matches(DOC_PATH, f.path) || matches(TRANSLATION_PATH, f.path) || (matches(DOC_DIR, f.path) && !isCode(f.path));
  if (files.every((f) => docLike(f) || commentOnly(f)) && lines < DOCS_MAX_LINES) {
    return `docs, translations or comments only (${lines} changed lines)`;
  }
  if (files.every((f) => isLockfile(f.path) || (isManifest(f.path) && versionOnly(f)))) {
    return ci === "success" ? "dependency or lockfile bump only, CI green" : null;
  }
  if (files.every((f) => isTestPath(f.path))) return "test files only";
  return null;
}
