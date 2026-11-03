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

/** Refusal reasons that only a wrong hunk header line count produces; recounting removes them, so rows with them are not tries. */
export const FORMAT_REASONS = ["hunk longer than its header", "truncated hunk"];

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * Rewrites every hunk header's line counts from the hunk body, like `git apply --recount`: models often get them
 * wrong. A body runs to the next hunk or file header; blank lines at its end are separators, not context.
 */
export function recountHunks(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HUNK_HEAD.exec(lines[i]!);
    if (!h) { out.push(lines[i]!); continue; }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@ ") && !lines[end]!.startsWith("diff --git ")) end++;
    let last = end;
    while (last > i + 1 && lines[last - 1] === "") last--;
    let oldN = 0, newN = 0;
    for (let k = i + 1; k < last; k++) {
      const c = lines[k]![0];
      if (c === "+") newN++;
      else if (c === "-") oldN++;
      else if (c === " " || lines[k] === "") { oldN++; newN++; }
    }
    out.push(`@@ -${h[1]},${oldN} +${h[2]},${newN} @@${h[3]}`);
    for (let k = i + 1; k < end; k++) out.push(lines[k]!);
    i = end - 1;
  }
  return out.join("\n");
}

const REJECT_HEADER = /^(old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|GIT binary patch|Binary files )/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Accepts only content edits to existing regular files named in `allowed`:
 * no new, deleted, renamed, mode-changed, symlink or binary files, at most
 * MAX_CHANGED_LINES added plus removed lines.
 */
export function validatePatch(text: string, allowed: string[]): PatchCheck {
  const patch = recountHunks(extractDiff(text));
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
  /** Where the call may read the repository in the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  ref: string;
  title: string;
  /** The review's fix list for this PR. */
  fixes: { file: string; change: string }[];
  /** Current content of each file the fixes name, at the PR's head commit. */
  files: { path: string; content: string }[];
  /** The PR's diff. */
  diff: string;
  /** For a carry-over: the PRs closed as duplicates, their diffs and the parts to port onto this one. */
  carried_from?: { ref: string; points: string[]; diff: string }[];
};

/** What the fixup.conflict prompt shows for one PR. Every string field is untrusted. */
export type ConflictPr = {
  /** Where the call may read the repository in the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  ref: string;
  title: string;
  /** The PR description. */
  body: string;
  /** The review's summary of what the PR does. */
  review_reason: string;
  /** The base branch being merged in. */
  base: string;
  /** Each conflicted file with conflict markers: `<<<<<<<` is the PR's side, `>>>>>>>` the base branch's. */
  files: { path: string; content: string }[];
};

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;
const RESOLVE_MAX_FILE = 80_000;
export const RESOLVE_MAX_TOTAL = 160_000;

export type Resolution = { ok: true; files: { path: string; content: string }[] } | { ok: false; reason: string };

/**
 * The resolver's reply: a JSON object {"files": [{"path", "content"}]} that names exactly the conflicted files, each with
 * full resolved content free of conflict markers, within the size caps. Nothing else may be touched.
 */
export function parseResolution(text: string, conflicted: string[]): Resolution {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let v: unknown;
  try { v = JSON.parse(text.slice(a, b + 1)); } catch { return { ok: false, reason: "the resolution is not valid JSON" }; }
  const list = (v as { files?: unknown } | null)?.files;
  if (!Array.isArray(list)) return { ok: false, reason: "the resolution has no files list" };
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const f of list as { path?: unknown; content?: unknown }[]) {
    if (typeof f?.path !== "string" || typeof f.content !== "string") return { ok: false, reason: "a resolved file lacks a path or content" };
    if (!conflicted.includes(f.path)) return { ok: false, reason: `${f.path} is not one of the conflicted files` };
    if (files.some((x) => x.path === f.path)) return { ok: false, reason: `${f.path} appears twice` };
    if (MARKER.test(f.content)) return { ok: false, reason: `${f.path} still has conflict markers` };
    if (f.content.includes("\0")) return { ok: false, reason: `${f.path} has a NUL byte` };
    if (f.content.length > RESOLVE_MAX_FILE) return { ok: false, reason: `${f.path} is over the size limit` };
    total += f.content.length;
    files.push({ path: f.path, content: f.content });
  }
  if (total > RESOLVE_MAX_TOTAL) return { ok: false, reason: "the resolved files are over the size limit" };
  const missing = conflicted.find((p) => !files.some((f) => f.path === p));
  if (missing) return { ok: false, reason: `${missing} is conflicted but not resolved` };
  return { ok: true, files };
}

/** Conflicted files a resolution may be written for: safe paths outside CI, cargo config and build scripts. */
export function resolvablePath(p: string): boolean {
  return safePath(p) && p !== "build.rs" && !p.endsWith("/build.rs") && !p.split("/").some((s) => s === ".cargo" || s === ".github");
}

/** True when the text holds conflict markers (the merge tree's files do before resolving). */
export const hasMarkers = (text: string): boolean => MARKER.test(text);

type Sections = { pieces: string[]; sections: { ours: string[]; theirs: string[] }[] };

/**
 * A merge-tree file split on its conflict markers: the pieces outside the sections (one more piece than sections) and
 * each section's two sides as lines, or null when the markers are not well formed (`<<<<<<<`, `=======`, `>>>>>>>` in turn).
 */
function parseSections(text: string): Sections | null {
  const pieces: string[] = [];
  const sections: Sections["sections"] = [];
  let cur = "";
  let part: "out" | "ours" | "theirs" = "out";
  for (const line of text.split(/(?<=\n)/)) {
    const t = line.replace(/\r?\n$/, "");
    if (/^<{7}( |$)/.test(t)) { if (part !== "out") return null; pieces.push(cur); cur = ""; part = "ours"; sections.push({ ours: [], theirs: [] }); }
    else if (/^={7}$/.test(t)) { if (part !== "ours") return null; part = "theirs"; }
    else if (/^>{7}( |$)/.test(t)) { if (part !== "theirs") return null; part = "out"; }
    else if (part === "out") cur += line;
    else sections[sections.length - 1]![part].push(t);
  }
  if (part !== "out") return null;
  pieces.push(cur);
  return { pieces, sections };
}

/** The text of a merge-tree file outside its conflict sections, as the pieces between sections, or null when the markers are malformed. */
export const outsideConflicts = (text: string): string[] | null => parseSections(text)?.pieces ?? null;

/** Lines a resolution may not introduce unless a side of the conflict already has them. */
const RISKY_LINE = /^\s*(pub\s+)?(use|extern|mod|fn|impl|macro_rules!|import)\b|\bunsafe\b|include(_str|_bytes)?!|build\.rs|\brequire\(/;
const DEPENDENCY_LINE = /^\s*"?[\w@/.-]+"?\s*(=\s*("|\{)|:\s*("|\{))/;
const MAX_OTHER_LINES = 3;

/** A resolution's text ends with a newline when the conflicted file's does. */
export function endNewline(conflicted: string, resolved: string): string {
  return conflicted.endsWith("\n") && !resolved.endsWith("\n") ? `${resolved}\n` : resolved;
}

/**
 * True when `resolved` keeps every piece outside the conflict sections of `conflicted` unchanged and in order, and each
 * conflict section's resolution is made of lines from its two sides (any order or subset) plus at most three other
 * lines, none of which declares code, imports, dependencies or build hooks.
 */
export function keepsOutside(conflicted: string, resolved: string, path = ""): boolean {
  const parsed = parseSections(conflicted);
  if (!parsed || parsed.pieces.length < 2) return false;
  const { pieces, sections } = parsed;
  const last = pieces.length - 1;
  if (!resolved.startsWith(pieces[0]!)) return false;
  const end = resolved.length - pieces[last]!.length;
  if (end < pieces[0]!.length || !resolved.endsWith(pieces[last]!)) return false;
  const dep = /(^|\/)(Cargo\.toml|package\.json)$/.test(path);
  let cursor = pieces[0]!.length;
  for (let i = 0; i < sections.length; i++) {
    let stop = end;
    if (i < last - 1) {
      const at = resolved.indexOf(pieces[i + 1]!, cursor);
      if (at < 0 || at + pieces[i + 1]!.length > end) return false;
      stop = at;
    }
    const sides = new Set([...sections[i]!.ours, ...sections[i]!.theirs]);
    let other = 0;
    for (const line of resolved.slice(cursor, stop).split("\n").filter((l, k, all) => k < all.length - 1 || l !== "")) {
      if (sides.has(line)) continue;
      if (++other > MAX_OTHER_LINES || RISKY_LINE.test(line) || (dep && DEPENDENCY_LINE.test(line))) return false;
    }
    cursor = i < last - 1 ? stop + pieces[i + 1]!.length : stop;
  }
  return true;
}
