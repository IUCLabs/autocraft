// Validation of the unified diff a model returns for the fix-up step. Pure text
// checks; whether it applies is decided by `git apply --check` in index.ts.

export const MAX_CHANGED_LINES = 300;

export type PatchCheck = { ok: true; patch: string; files: string[]; changed: number } | { ok: false; reason: string };

/** Paths a fix may touch: relative, inside the repo, no `..`, not under .git. */
export function safePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.startsWith("-")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** Source files an automated fix may edit: Rust files other than build scripts, nothing under .cargo or .github. */
export function editable(path: string): boolean {
  return safePath(path) && path.endsWith(".rs") && !path.endsWith("/build.rs") && path !== "build.rs" && !path.split("/").some((s) => s === ".cargo" || s === ".github");
}

/** The diff text without a surrounding Markdown fence or leading prose lines. */
export function extractDiff(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1]!;
  const i = t.search(/^diff --git /m);
  return i > 0 ? t.slice(i) : t;
}

const REJECT_HEADER = /^(old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|GIT binary patch|Binary files )/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Accepts only content edits to existing regular files named in `allowed`:
 * no new, deleted, renamed, mode-changed, symlink or binary files, at most
 * MAX_CHANGED_LINES added plus removed lines.
 */
export function validatePatch(text: string, allowed: string[]): PatchCheck {
  const patch = extractDiff(text);
  if (!patch.startsWith("diff --git ")) return { ok: false, reason: "the reply is not a unified diff" };
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files: string[] = [];
  let changed = 0;
  let cur: string | null = null;
  let sawOld = false, sawNew = false, hunks = 0;
  const closeFile = (): string | null => (cur !== null && (!sawOld || !sawNew || hunks === 0) ? `incomplete diff for ${cur}` : null);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ")) {
      const bad = closeFile();
      if (bad) return { ok: false, reason: bad };
      const m = l.match(/^diff --git a\/(\S+) b\/(\S+)$/);
      if (!m || m[1] !== m[2]) return { ok: false, reason: `unsupported file header: ${l.slice(0, 100)}` };
      cur = m[1]!;
      if (!safePath(cur)) return { ok: false, reason: `unsafe path ${cur}` };
      if (!editable(cur)) return { ok: false, reason: `${cur} is not a file a fix-up may edit` };
      if (!allowed.includes(cur)) return { ok: false, reason: `${cur} is not a file named in the review's fixes` };
      if (files.includes(cur)) return { ok: false, reason: `${cur} appears twice` };
      files.push(cur);
      sawOld = sawNew = false;
      hunks = 0;
      continue;
    }
    if (cur === null) return { ok: false, reason: "text before the first file header" };
    if (REJECT_HEADER.test(l)) return { ok: false, reason: `${l.split(" ").slice(0, 2).join(" ")} is not allowed (${cur})` };
    const idx = l.match(/^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/);
    if (idx && idx[1] !== "100644" && idx[1] !== "100755") return { ok: false, reason: `${cur} has mode ${idx[1]}` };
    if (l.startsWith("--- ")) {
      if (l !== `--- a/${cur}`) return { ok: false, reason: `unexpected old file line for ${cur}` };
      sawOld = true;
      continue;
    }
    if (l.startsWith("+++ ")) {
      if (l !== `+++ b/${cur}`) return { ok: false, reason: `unexpected new file line for ${cur}` };
      sawNew = true;
      continue;
    }
    const h = l.match(HUNK);
    if (h) {
      if (!sawOld || !sawNew) return { ok: false, reason: `hunk before the file lines of ${cur}` };
      hunks++;
      let oldN = h[1] === undefined ? 1 : Number(h[1]), newN = h[2] === undefined ? 1 : Number(h[2]);
      while (oldN > 0 || newN > 0) {
        const b = lines[++i];
        if (b === undefined) return { ok: false, reason: `truncated hunk in ${cur}` };
        if (b.startsWith("\\")) continue;
        const c = b[0];
        if (c === "+") { newN--; changed++; }
        else if (c === "-") { oldN--; changed++; }
        else if (c === " " || b === "") { oldN--; newN--; }
        else return { ok: false, reason: `malformed hunk line in ${cur}` };
        if (oldN < 0 || newN < 0) return { ok: false, reason: `hunk longer than its header in ${cur}` };
      }
      while (lines[i + 1]?.startsWith("\\")) i++;
      continue;
    }
    if (l.startsWith("index ")) continue;
    return { ok: false, reason: `unexpected line in the diff of ${cur}: ${l.slice(0, 80)}` };
  }
  const bad = closeFile();
  if (bad) return { ok: false, reason: bad };
  if (!files.length) return { ok: false, reason: "the diff changes no file" };
  if (changed > MAX_CHANGED_LINES) return { ok: false, reason: `${changed} changed lines, over the limit of ${MAX_CHANGED_LINES}` };
  return { ok: true, patch: patch + "\n", files, changed };
}

/** What the fix-up prompt shows for one PR. Every string field is untrusted. */
export type FixupPr = {
  ref: string;
  title: string;
  /** The review's fix list for this PR. */
  fixes: { file: string; change: string }[];
  /** Current content of each file the fixes name, at the PR's head commit. */
  files: { path: string; content: string }[];
  /** The PR's diff. */
  diff: string;
};
