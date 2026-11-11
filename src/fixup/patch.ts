// Validation of the unified diff a model returns for the fix-up step. Pure text
// checks; whether it applies is decided by `git apply --check` in index.ts.

import { cleanReason } from "../act/templates.ts";
import { isInstructionPath } from "../sandbox/instruction-paths.ts";
import { QUOTE_WORDS } from "../replylint.ts";
import type { ShownFile } from "./excerpt.ts";

export const MAX_CHANGED_LINES = 300;

export type PatchCheck = { ok: true; patch: string; files: string[]; changed: number } | { ok: false; reason: string };

/** Paths a fix may touch: relative, inside the repo, no `..`, not under .git. */
export function safePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.startsWith("-")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** Files a fix-up may edit: Rust files and Markdown files, with the same exclusions as `editable`. */
export function fixupEditable(path: string, scripts: BuildScripts = null): boolean {
  if (editable(path, scripts)) return true;
  const parts = path.split("/");
  return safePath(path) && path.toLowerCase().endsWith(".md") && !parts.some((s) => s.startsWith(".")) && !AGENT_DOCS.test(parts[parts.length - 1]!);
}

/**
 * Files an operator's fix-up may edit: any file of the repository except what every fix-up refuses (CI workflows, cargo
 * configuration, build scripts, files that instruct coding agents) and hidden-directory paths of the git metadata.
 */
export function operatorEditable(path: string, scripts: BuildScripts = null): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!.toLowerCase();
  return safePath(path) && !isBuildScript(path, scripts) && !parts.some((s) => s === ".cargo" || s === ".github")
    && !AGENT_DOCS.test(parts[parts.length - 1]!) && !isInstructionPath(path)
    && name !== "cargo.toml" && name !== "cargo.lock" && !name.startsWith("rust-toolchain")
    && name !== ".gitmodules" && name !== ".gitattributes" && name !== "codeowners";
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** True when `text` shares a run of QUOTE_WORDS consecutive words with `source`. */
export function quotesText(text: string, source: string): boolean {
  const w = words(text), v = words(source);
  if (w.length < QUOTE_WORDS || v.length < QUOTE_WORDS) return false;
  const runs = new Set<string>();
  for (let i = 0; i + QUOTE_WORDS <= v.length; i++) runs.add(v.slice(i, i + QUOTE_WORDS).join(" "));
  for (let i = 0; i + QUOTE_WORDS <= w.length; i++) if (runs.has(w.slice(i, i + QUOTE_WORDS).join(" "))) return true;
  return false;
}

/** The reply of an operator's fix-up splits at its last `CHANGES:` line into the diff and the model's numbered list of what it changed (items cleaned like any public reason, one line each, at most 8; an item that quotes the operator's `instructions` is dropped). */
export function splitChanges(text: string, instructions = ""): { diff: string; changes: string[] } {
  const t = text.replace(/\r\n/g, "\n");
  const i = t.search(/^CHANGES:[ \t]*$(?![\s\S]*^CHANGES:)/m);
  if (i < 0) return { diff: text, changes: [] };
  const changes = t.slice(i).split("\n").slice(1).map((l) => cleanReason(l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, ""), 200) ?? "").filter((x) => x && !quotesText(x, instructions)).slice(0, 8);
  return { diff: t.slice(0, i).trimEnd(), changes };
}

/**
 * The build scripts of a checkout (paths Cargo runs at build time), or null when the checkout is unknown. With null every
 * file named `build.rs` counts as a build script.
 */
export type BuildScripts = ReadonlySet<string> | null;

export function isBuildScript(path: string, scripts: BuildScripts): boolean {
  if (scripts === null) return path === "build.rs" || path.endsWith("/build.rs");
  return scripts.has(path);
}

/** The `[package]` table's `build` setting of a Cargo.toml: a path, false (none), or undefined (Cargo's default `build.rs`). null: no `[package]` table. */
function packageBuild(toml: string): string | false | undefined | null {
  let table = "", has = false, build: string | false | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    const h = /^\[\s*([^\]]*?)\s*\]/.exec(line);
    if (h && !line.startsWith("[[")) { table = h[1]!.replace(/\s+/g, ""); if (table === "package") has = true; continue; }
    if (line.startsWith("[[")) { table = "[[]]"; continue; }
    const k = table === "package" ? /^build\s*=\s*(.*)$/.exec(line) : table === "" ? /^package\.build\s*=\s*(.*)$/.exec(line) : null;
    if (!k) continue;
    if (table === "") has = true;
    const v = k[1]!.trim();
    const str = /^(?:"([^"]*)"|'([^']*)')/.exec(v);
    if (str) build = str[1] ?? str[2]!;
    else if (/^false\b/.test(v)) build = false;
  }
  return has ? build : null;
}

/** The normalized `dir/rel`, or null when it leaves the repository. */
function joinPath(dir: string, rel: string): string | null {
  const out = dir ? dir.split("/") : [];
  for (const s of rel.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!out.pop()) return null; } else out.push(s);
  }
  return out.join("/");
}

/**
 * The build scripts Cargo runs in a checkout, from its file list and a reader of file contents: for every Cargo.toml with a
 * `[package]` table, the path its `build` key names, `build.rs` beside it when the key is absent, nothing for `build = false`.
 */
export function buildScripts(files: string[], read: (path: string) => string | null): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f !== "Cargo.toml" && !f.endsWith("/Cargo.toml")) continue;
    const toml = read(f);
    if (toml === null) continue;
    const b = packageBuild(toml);
    if (b === null || b === false) continue;
    const dir = f.slice(0, -"Cargo.toml".length).replace(/\/$/, "");
    const p = joinPath(dir, b ?? "build.rs");
    if (p !== null) out.add(p);
  }
  return out;
}

/** The build scripts at commit `sha` of a bare repository; null when it can't be read (callers then refuse every build.rs). */
// A structural type, not Git itself: this file is part of the web build, which must not pull in the git module graph.
type TreeReader = {
  git(args: string[]): Promise<{ code: number | null; stdout: string }>;
  file(sha: string, path: string): Promise<{ ok: true; content: string } | { ok: false }>;
};

export async function buildScriptsAt(git: TreeReader, sha: string): Promise<BuildScripts> {
  const ls = await git.git(["ls-tree", "-r", "--name-only", sha]);
  if (ls.code !== 0) return null;
  const files = ls.stdout.split("\n").filter(Boolean);
  const tomls = files.filter((f) => f === "Cargo.toml" || f.endsWith("/Cargo.toml"));
  const text = new Map<string, string>();
  for (const f of tomls) {
    const r = await git.file(sha, f);
    if (r.ok) text.set(f, r.content);
    else return null;
  }
  return buildScripts(files, (p) => text.get(p) ?? null);
}

/** Markdown files that instruct coding agents; a fix-up never edits them. */
const AGENT_DOCS = /^(claude(\.local)?|agents|gemini|copilot-instructions)\.md$/i;

/** Source files an automated fix (a CI fix or an issue fix) may edit: Rust files other than build scripts, nothing under .cargo or .github. */
export function editable(path: string, scripts: BuildScripts = null): boolean {
  return safePath(path) && path.endsWith(".rs") && !isBuildScript(path, scripts) && !path.split("/").some((s) => s === ".cargo" || s === ".github");
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
 * Accepts only content edits to existing regular files named in `allowed` (any file `canEdit` accepts when null):
 * no new, deleted, renamed, mode-changed, symlink or binary files, at most
 * MAX_CHANGED_LINES added plus removed lines.
 */
export function validatePatch(text: string, allowed: string[] | null, canEdit: (path: string) => boolean = editable): PatchCheck {
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
      if (!canEdit(cur)) return { ok: false, reason: `${cur} is not a file a fix-up may edit` };
      if (allowed && !allowed.includes(cur)) return { ok: false, reason: `${cur} is not a file named in the review's fixes` };
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
  /** Set for a quiet pull request: the prompt adds the quiet rule; not part of the quoted JSON. */
  quiet?: boolean;
  /** Each file the fixes name, at the PR's head commit: whole, or in part when it is large. */
  files: ShownFile[];
  /** The PR's diff. */
  diff: string;
  /** An operator's instructions (a maintainer of the project, not the PR's author): trusted text that replaces the fix list. */
  operator?: string;
  /** For a carry-over: the PRs closed as duplicates, their diffs and the parts to port onto this one. */
  carried_from?: { ref: string; points: string[]; diff: string }[];
  /** Present when an earlier patch for these fixes failed the lint check: that patch and the lint findings on the lines it changed. */
  previous?: LintPrevious;
};

/** An earlier model patch and the formatter and clippy findings on its own lines, as the patch prompts show them. */
export type LintPrevious = { patch: string; findings: string[] };

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
  /** Set for a quiet pull request: the prompt adds the quiet rule; not part of the quoted JSON. */
  quiet?: boolean;
  /** Each conflicted file as its conflict sections. */
  files: ConflictFile[];
  /** Present when an earlier resolution failed the lint check: its diff against the merge's conflicted tree and the findings on the lines it changed. */
  previous?: LintPrevious;
};

/** One conflict section with the lines around it. `ours` is the PR's side, `theirs` the base branch's. */
export type ConflictSection = { id: number; /** First line of `ours` in the PR head's version of the file (where `before` ends), or null when not found. */ line: number | null; before: string; ours: string; theirs: string; after: string };
export type ConflictFile = { path: string; lines: number; sections: ConflictSection[] };

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;
const RESOLVE_MAX_SECTION = 40_000;
export const RESOLVE_MAX_TOTAL = 120_000;
/** Lines of the file shown before and after each conflict section. */
export const CONTEXT_LINES = 30;

export type Resolution = { ok: true; sections: Map<number, string> } | { ok: false; reason: string };

/**
 * The resolver's reply: a JSON object {"sections": [{"id", "content"}]} that answers each shown section id exactly once
 * with the resolved lines for it, free of conflict markers and within the size caps.
 */
export function parseResolution(text: string, ids: number[]): Resolution {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let v: unknown;
  try { v = JSON.parse(text.slice(a, b + 1)); } catch { return { ok: false, reason: "the resolution is not valid JSON" }; }
  const list = (v as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(list)) return { ok: false, reason: "the resolution has no sections list" };
  const out = new Map<number, string>();
  let total = 0;
  for (const f of list as { id?: unknown; content?: unknown }[]) {
    if (typeof f?.id !== "number" || typeof f.content !== "string") return { ok: false, reason: "a resolved section lacks an id or content" };
    if (!ids.includes(f.id)) return { ok: false, reason: `section ${f.id} is not one of the conflict sections` };
    if (out.has(f.id)) return { ok: false, reason: `section ${f.id} is answered twice` };
    if (MARKER.test(f.content)) return { ok: false, reason: `section ${f.id} still has conflict markers` };
    if (f.content.includes("\0")) return { ok: false, reason: `section ${f.id} has a NUL byte` };
    if (f.content.length > RESOLVE_MAX_SECTION) return { ok: false, reason: `section ${f.id} is over the size limit` };
    total += f.content.length;
    out.set(f.id, f.content);
  }
  if (total > RESOLVE_MAX_TOTAL) return { ok: false, reason: "the resolved sections are over the size limit" };
  const missing = ids.find((i) => !out.has(i));
  if (missing !== undefined) return { ok: false, reason: `section ${missing} is not resolved` };
  return { ok: true, sections: out };
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

/** Lines a resolution may not introduce unless a side of the conflict already has them. */
const RISKY_LINE = /^\s*(pub\s+)?(use|extern|mod|fn|impl|macro_rules!|import)\b|\bunsafe\b|include(_str|_bytes)?!|build\.rs|\brequire\(/;
/** A Rust attribute, or a line that starts an item (after visibility, async, const, unsafe, default or extern "ABI"). */
const RUST_ITEM_LINE = /^\s*(#!?\[|(pub(\s*\([^)]*\))?\s+)?((async|const|unsafe|default|extern(\s+"[^"]*")?)\s+)*(use|mod|fn|struct|enum|trait|impl|type|const|static|union|macro_rules!|macro|extern)\b)/;
const MAX_OTHER_LINES = 3;

/** True when a section's resolved text is made of lines from its two sides plus at most three others, none risky (for Rust, none that adds an item or an attribute). */
function sectionOk(section: { ours: string[]; theirs: string[] }, text: string, rust: boolean): boolean {
  const sides = new Set([...section.ours, ...section.theirs]);
  let other = 0;
  for (const line of text.split("\n").filter((l, k, all) => k < all.length - 1 || l !== "")) {
    if (sides.has(line)) continue;
    if (++other > MAX_OTHER_LINES || RISKY_LINE.test(line) || (rust && RUST_ITEM_LINE.test(line))) return false;
  }
  return true;
}

const LOCKFILE = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MANIFEST = /(^|\/)(Cargo\.toml|package\.json)$/;

/** True when a lockfile or manifest section's resolved text is, line for line and in order, exactly one side of the conflict. */
function oneSide(section: { ours: string[]; theirs: string[] }, text: string): boolean {
  const lines = text.split("\n").filter((l, k, all) => k < all.length - 1 || l !== "");
  const same = (side: string[]) => side.length === lines.length && side.every((l, k) => l === lines[k]);
  return same(section.ours) || same(section.theirs);
}

/** A resolution's text ends with a newline when the conflicted file's does. */
export function endNewline(conflicted: string, resolved: string): string {
  return resolved !== "" && conflicted.endsWith("\n") && !resolved.endsWith("\n") ? `${resolved}\n` : resolved;
}

const lineList = (text: string): string[] => text.split(/(?<=\n)/).filter((l) => l !== "");

/**
 * A merge-tree file as its conflict sections, numbered from `firstId`, each with up to `context` lines before and after.
 * Where two sections are close, the lines between them are shared out so no line is shown twice. Null when the markers
 * are not well formed.
 */
export function conflictView(path: string, text: string, firstId: number, context = CONTEXT_LINES): ConflictFile | null {
  const parsed = parseSections(text);
  if (!parsed) return null;
  const { pieces, sections } = parsed;
  const lines = pieces.map(lineList);
  const after: number[] = [], before: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const gap = lines[i + 1]!.length;
    after[i] = Math.min(context, gap);
    before[i + 1] = i + 1 < sections.length ? Math.min(context, gap - after[i]!) : 0;
  }
  before[0] = Math.min(context, lines[0]!.length);
  const out: ConflictSection[] = sections.map((sec, i) => {
    const section: ConflictSection = {
      id: firstId + i, line: null,
      before: lines[i]!.slice(lines[i]!.length - (i === 0 ? before[0]! : before[i]!)).join(""),
      ours: sec.ours.map((l) => `${l}\n`).join(""), theirs: sec.theirs.map((l) => `${l}\n`).join(""),
      after: lines[i + 1]!.slice(0, after[i]).join(""),
    };
    return section;
  });
  return { path, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), sections: out };
}

/** Fills each section's `line` from the PR head's version of the file, searching for its context and PR side in order. */
export function locateInHead(view: ConflictFile, head: string): void {
  let from = 0;
  for (const sec of view.sections) {
    const at = head.indexOf(sec.before + sec.ours + sec.after, from);
    if (at < 0) continue;
    sec.line = head.slice(0, at + sec.before.length).split("\n").length;
    from = at + sec.before.length + sec.ours.length;
  }
}

/** A section's answer as spliced: empty for no lines, otherwise ending with a newline. */
export const answerText = (a: string): string => (a === "" || a.endsWith("\n") ? a : `${a}\n`);

/** The merge-tree file with each section replaced by its resolved text (`answers` in section order), or null when the markers are malformed or a resolution breaks the section rules. */
export function spliceSections(text: string, answers: string[], path = ""): string | null {
  const parsed = parseSections(text);
  if (!parsed || parsed.sections.length !== answers.length) return null;
  // Lockfiles and manifests (dependencies, build configuration) take exactly one side.
  const lock = LOCKFILE.test(path) || MANIFEST.test(path);
  const rust = path.endsWith(".rs");
  let out = parsed.pieces[0]!;
  for (let i = 0; i < answers.length; i++) {
    const resolved = answerText(answers[i]!);
    if (lock ? !oneSide(parsed.sections[i]!, resolved) : !sectionOk(parsed.sections[i]!, resolved, rust)) return null;
    out += resolved + parsed.pieces[i + 1]!;
  }
  return out;
}
