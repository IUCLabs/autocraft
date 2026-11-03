// Deterministic limits on what a CI fix may change, applied before the Opus check: a patch that makes a failing check
// pass by changing the check (tests, lints, CI config) is never pushed.
export const TEST_PATH = /(^|\/)(tests?|benches)\/|(^|\/)tests?\.rs$|_tests?\.rs$|(^|\/)test_[^/]*\.rs$/;
const DISABLES = /^\+.*#!?\[\s*(allow|ignore|warn|expect|cfg_attr)\b/;
const DROPS_CHECK = /^-.*(#\[\s*test\b|\bassert(_eq|_ne)?!|\bdebug_assert)/;

/** Why the patch may not be pushed, or null. `patch` is a validated git-format diff. */
export function guardPatch(patch: string, files: string[]): string | null {
  const test = files.find((f) => TEST_PATH.test(f));
  if (test) return `the patch edits a test file (${test})`;
  for (const l of patch.split("\n")) {
    if (DISABLES.test(l)) return "the patch adds an attribute that disables a lint or a test";
    if (DROPS_CHECK.test(l)) return "the patch removes a test or an assertion";
  }
  return null;
}
