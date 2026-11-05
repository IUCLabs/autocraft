// PR diffs: fetched with `gh pr diff`, cached by head commit, and cut down to
// the code a reviewer reads (tests and lockfiles are listed, not shown).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { envVar } from "../env.ts";
import { slugOf } from "../owners.ts";

// gh picks its account from the working directory, so it runs in this repo.
const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));

export function diffCacheDir(): string {
  return envVar("DIFF_CACHE") ?? join(homedir(), ".cache/autocraft/diffs");
}

export type DiffResult = { ok: true; text: string } | { ok: false; tooLarge: boolean; error: string };
export type DiffFetcher = (repo: string, number: number) => Promise<DiffResult>;

export const ghDiff: DiffFetcher = (repo, number) => new Promise((resolve) => {
  const p = spawn("gh", ["pr", "diff", String(number), "--repo", `${slugOf(repo)}`], { cwd: REPO_DIR, timeout: 120_000 });
  const out: Buffer[] = [];
  let err = "";
  p.stdout.on("data", (d: Buffer) => out.push(d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => resolve({ ok: false, tooLarge: false, error: String(e) }));
  p.on("close", (code) => {
    if (code === 0) resolve({ ok: true, text: Buffer.concat(out).toString("utf8") });
    // GitHub refuses diffs over 20,000 lines or 300 files with HTTP 406.
    else resolve({ ok: false, tooLarge: /too_large|too large|406|maximum number of (lines|files)/i.test(err), error: err.trim().slice(0, 300) });
  });
});

/** The diff of `repo#number` at `head`, from the cache when present. */
export async function cachedDiff(repo: string, number: number, head: string, fetch: DiffFetcher): Promise<DiffResult> {
  const dir = join(diffCacheDir(), repo);
  const file = join(dir, `${number}-${head}.diff`);
  if (existsSync(file)) return { ok: true, text: readFileSync(file, "utf8") };
  const r = await fetch(repo, number);
  if (r.ok) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, r.text);
    renameSync(`${file}.tmp`, file);
  }
  return r;
}

export type FileDiff = { path: string; text: string; lines: number };

export function splitDiff(text: string): FileDiff[] {
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((p) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
    const path = m ? m[2]! : "?";
    const lines = p.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
    return { path, text: p, lines };
  });
}

const TEST_PATH = [
  /(^|\/)(tests?|testdata|test-data|test_data|fixtures|benches|__tests__|snapshots)\//,
  /(^|\/)test_[^/]*$/, /_tests?\.\w+$/, /\.(test|spec)\.\w+$/, /\.snap$/,
];
const LOCKFILE = /(^|\/)(Cargo\.lock|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|go\.sum)$/;

export const isTestPath = (p: string): boolean => TEST_PATH.some((r) => r.test(p));
export const isLockfile = (p: string): boolean => LOCKFILE.test(p);

export type CodeDiff = {
  /** Code files only, in diff order. */
  files: string[];
  /** The code part of the diff. */
  text: string;
  /** Changed lines in code files. */
  codeLines: number;
  testsOmitted: string[];
  lockfilesOmitted: string[];
};

/** Keeps the code: owner rule, reviews judge code, not tests. `keepTests` treats test files as code. */
export function codeDiff(text: string, keepTests = false): CodeDiff {
  const out: CodeDiff = { files: [], text: "", codeLines: 0, testsOmitted: [], lockfilesOmitted: [] };
  const kept: string[] = [];
  for (const f of splitDiff(text)) {
    if (isLockfile(f.path)) out.lockfilesOmitted.push(f.path);
    else if (!keepTests && isTestPath(f.path)) out.testsOmitted.push(f.path);
    else {
      out.files.push(f.path);
      kept.push(f.text);
      out.codeLines += f.lines;
    }
  }
  out.text = kept.join("");
  return out;
}

/** The diff between two heads of one PR, or a failure. Not cached: it is read once per new head. */
export type DeltaFetcher = (repo: string, base: string, head: string) => Promise<DiffResult>;

function gh(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("gh", args, { cwd: REPO_DIR, timeout: 120_000 });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }));
    p.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8"), err }));
  });
}

/** GitHub's compare of base...head; fails unless head is ahead of base (so base is an ancestor). */
export const ghDelta: DeltaFetcher = async (repo, base, head) => {
  const path = `repos/${slugOf(repo)}/compare/${base}...${head}`;
  const status = await gh(["api", path, "--jq", ".status"]);
  if (status.code !== 0) return { ok: false, tooLarge: false, error: status.err.trim().slice(0, 300) };
  if (status.out.trim() !== "ahead") return { ok: false, tooLarge: false, error: `compare status ${status.out.trim()}` };
  const diff = await gh(["api", "-H", "Accept: application/vnd.github.diff", path]);
  if (diff.code !== 0) return { ok: false, tooLarge: /too_large|too large|406/i.test(diff.err), error: diff.err.trim().slice(0, 300) };
  return { ok: true, text: diff.out };
};

/** What a merged PR landed: the commit read (null when the diff is the PR's own) and its diff restricted to the files of the PR's own diff. */
export type MergedDiff = { ok: true; sha: string | null; text: string } | { ok: false; tooLarge: boolean; error: string };
/** `batch`: the PR landed through an integration batch, whose merge commit carries every member. */
export type MergedFetcher = (repo: string, number: number, opts?: { batch?: boolean }) => Promise<MergedDiff>;

/**
 * The merge commit's diff against its first parent, kept to the files the PR changed. A PR merged through an integration
 * batch, or one without a merge commit, is read as its own diff at the merged head (it includes the pipeline's pushes to
 * the PR branch). When the PR's own diff cannot be read there is no diff: the merge commit alone would carry other PRs.
 */
export const ghMerged: MergedFetcher = async (repo, number, opts = {}) => {
  const own = await ghDiff(repo, number);
  if (!own.ok) return own;
  if (opts.batch) return { ok: true, sha: null, text: own.text };
  const view = await gh(["pr", "view", String(number), "--repo", `${slugOf(repo)}`, "--json", "mergeCommit", "--jq", ".mergeCommit.oid // empty"]);
  const sha = view.code === 0 && /^[0-9a-f]{40}$/.test(view.out.trim()) ? view.out.trim() : null;
  const fallback: MergedDiff = { ok: true, sha, text: own.text };
  if (!sha) return fallback;
  const c = await gh(["api", "-H", "Accept: application/vnd.github.diff", `repos/${slugOf(repo)}/commits/${sha}`]);
  if (c.code !== 0) return fallback;
  const keep = new Set(splitDiff(own.text).map((f) => f.path));
  const text = splitDiff(c.out).filter((f) => keep.has(f.path)).map((f) => f.text).join("");
  return text ? { ok: true, sha, text } : fallback;
};

/** Whether `path` exists on `ref` of the repo; null when GitHub could not say (anything but a plain not-found). */
export type FileChecker = (repo: string, ref: string, path: string) => Promise<boolean | null>;

export const ghFileExists: FileChecker = async (repo, ref, path) => {
  const r = await gh(["api", `repos/${slugOf(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, "--jq", ".type"]);
  if (r.code === 0) return r.out.trim().length > 0;
  return /\b404\b|Not Found/i.test(r.err) ? false : null;
};
