// PR diffs: fetched with `gh pr diff`, cached by head commit, and cut down to
// the code a reviewer reads (tests and lockfiles are listed, not shown).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { envVar } from "../env.ts";

const ORG = "storytold";
// gh picks its account from the working directory, so it runs in this repo.
const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));

export function diffCacheDir(): string {
  return envVar("DIFF_CACHE") ?? join(homedir(), ".cache/autocraft/diffs");
}

export type DiffResult = { ok: true; text: string } | { ok: false; tooLarge: boolean; error: string };
export type DiffFetcher = (repo: string, number: number) => Promise<DiffResult>;

export const ghDiff: DiffFetcher = (repo, number) => new Promise((resolve) => {
  const p = spawn("gh", ["pr", "diff", String(number), "--repo", `${ORG}/${repo}`], { cwd: REPO_DIR, timeout: 120_000 });
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

/** Area of a PR for batching: the most common two-level directory of its code files. */
export function areaOf(files: string[]): string {
  const count = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const key = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0]! : "(root)";
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "(none)";
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
  const path = `repos/${ORG}/${repo}/compare/${base}...${head}`;
  const status = await gh(["api", path, "--jq", ".status"]);
  if (status.code !== 0) return { ok: false, tooLarge: false, error: status.err.trim().slice(0, 300) };
  if (status.out.trim() !== "ahead") return { ok: false, tooLarge: false, error: `compare status ${status.out.trim()}` };
  const diff = await gh(["api", "-H", "Accept: application/vnd.github.diff", path]);
  if (diff.code !== 0) return { ok: false, tooLarge: /too_large|too large|406/i.test(diff.err), error: diff.err.trim().slice(0, 300) };
  return { ok: true, text: diff.out };
};
