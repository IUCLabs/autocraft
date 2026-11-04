// Deterministic limits on what a CI fix may change, applied before the Opus check: a patch that makes a failing check
// pass by changing the check (tests, lints, CI config) is never pushed.
export const TEST_PATH = /(^|\/)(tests?|benches)\/|(^|\/)tests?\.rs$|_tests?\.rs$|(^|\/)test_[^/]*\.rs$/;
const DISABLES = /^\+.*#!?\[\s*(?:(?:allow|ignore|warn|expect|cfg_attr|should_panic)\b|cfg\s*\()/;
const DROPS_CHECK = /^-.*(#\[\s*test\b|\bassert(_eq|_ne)?!|\bdebug_assert)/;
const EARLY_RETURN = /^\+\s*return\s*;/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

type Range = { from: number; to: number };

/**
 * 1-based line ranges of the items an attribute guards: from the attribute line to the item's closing brace (or
 * the `;` of a body-less item). Strings, chars and comments are skipped so their braces do not count. null when the
 * braces do not balance: the file is then not understood.
 */
export function attributeRanges(src: string, attr: RegExp): Range[] | null {
  const line = (i: number) => src.slice(0, i).split("\n").length;
  const out: Range[] = [];
  const re = new RegExp(attr.source, "g");
  for (const m of src.matchAll(re)) {
    let depth = 0, started = false, end = -1;
    for (let i = m.index! + m[0].length; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
      if (ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return null; i = e + 1; continue; }
      if (ch === "r" && /^r#*"/.test(src.slice(i, i + 12)) && !/\w/.test(src[i - 1] ?? " ")) {
        const hashes = /^r(#*)"/.exec(src.slice(i, i + 12))![1]!;
        const e = src.indexOf(`"${hashes}`, i + 2 + hashes.length);
        if (e < 0) return null;
        i = e + hashes.length;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        if (j >= src.length) return null;
        i = j;
        continue;
      }
      if (ch === "'") {
        const c = /^'(?:\\.[^']*|[^\\'])'/.exec(src.slice(i, i + 12));
        if (c) i += c[0].length - 1;
        continue;
      }
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; if (started && depth === 0) { end = i; break; } if (depth < 0) return null; }
      else if (ch === ";" && !started) { end = i; break; }
    }
    if (end < 0) return null;
    out.push({ from: line(m.index!), to: line(end) });
  }
  return out;
}

const CFG_TEST = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const TEST_FN = /#\s*\[\s*test\s*\]/;

/**
 * Why the patch may not be pushed, or null. `patch` is a validated git-format diff. `heads` maps each patched file to
 * its content at the PR head; with it, hunks inside `#[cfg(test)]` items are refused and so is an early `return;`
 * added to a `#[test]` function. A file whose content is missing or not understood is refused.
 */
export function guardPatch(patch: string, files: string[], heads?: Map<string, string>): string | null {
  const test = files.find((f) => TEST_PATH.test(f));
  if (test) return `the patch edits a test file (${test})`;
  for (const l of patch.split("\n")) {
    if (DISABLES.test(l)) return "the patch adds an attribute that disables a lint or a test";
    if (DROPS_CHECK.test(l)) return "the patch removes a test or an assertion";
  }
  if (!heads) return null;
  let file: string | null = null, cfg: Range[] = [], tests: Range[] = [], old = 0;
  for (const l of patch.split("\n")) {
    const d = /^diff --git a\/(\S+) b\//.exec(l);
    if (d) {
      file = d[1]!;
      old = 0;
      const src = heads.get(file);
      if (src === undefined) return `the content of ${file} at the head could not be read to check it`;
      if (/^\s*#!\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/m.test(src)) return `${file} is test-only code`;
      const c = attributeRanges(src, CFG_TEST), t = attributeRanges(src, TEST_FN);
      if (!c || !t) return `${file} could not be checked for test code`;
      cfg = c;
      tests = t;
      continue;
    }
    const h = HUNK.exec(l);
    if (h) {
      const from = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
      const to = Math.max(from, from + len - 1);
      if (cfg.some((r) => from <= r.to && to >= r.from)) return `the patch changes test code in ${file}`;
      old = from;
      continue;
    }
    if (file === null || old === 0) continue;
    if (l.startsWith("+") && !l.startsWith("+++")) {
      if (EARLY_RETURN.test(l) && tests.some((r) => old >= r.from && old <= r.to)) return `the patch adds an early return to a test in ${file}`;
    } else if (l.startsWith(" ") || (l.startsWith("-") && !l.startsWith("---"))) old++;
  }
  return null;
}

const strip = (s: string) => s.replace(/\s+/g, "");

/**
 * Why a formatter diff is not formatting alone, or null. Within each hunk the removed and the added lines must be equal
 * once all whitespace is removed (the context is the same on both sides), so a changed token, a reordered line or a
 * moved line is refused. The diff is never trusted to be formatting because a formatter produced it: a PR controls
 * the files the formatter reads.
 */
export function formattingOnly(patch: string): string | null {
  let file = "", rem = "", add = "", inHunk = false;
  const bad = () => strip(rem) !== strip(add);
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ") || l.startsWith("@@")) {
      if (inHunk && bad()) return `the formatter changed more than whitespace in ${file}`;
      rem = add = "";
      inHunk = l.startsWith("@@");
      const d = /^diff --git a\/(\S+) /.exec(l);
      if (d) file = d[1]!;
      continue;
    }
    if (!inHunk) continue;
    if (l.startsWith("-")) rem += l.slice(1);
    else if (l.startsWith("+")) add += l.slice(1);
  }
  return inHunk && bad() ? `the formatter changed more than whitespace in ${file}` : null;
}
