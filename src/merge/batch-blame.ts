// Which PR of a red integration batch broke it, read from the failure itself: no model. A compiler error
// (`error...` followed by `--> file:line`) or a panic (`panicked at file:line`) names a line; `git blame` at the
// batch tip says which commit wrote it, and the member whose commits include it is the suspect. A named file that
// only one member changed points at that member. Nothing clear: no suspect, and the batch is rerun or split.
//
// The log is the PR's own CI output, so it is untrusted: only paths that look like plain repo paths are used,
// always after `--`, and nothing of the text goes anywhere but these git calls and a short reason line.
import type { BatchGit } from "./batch-git.ts";
import type { BatchMember } from "./batch-store.ts";

export type Location = { file: string; line: number; what: "error" | "panic" };

/** Locations read from a failure; more than this many are not followed. */
export const MAX_LOCATIONS = 10;
/** More suspects than this is no trace: the batch is split as before. */
export const MAX_SUSPECTS = 3;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ARROW = /^\s*-->\s+(\S+?):(\d+)(?::\d+)?\s*$/;
// `thread 'x' panicked at src/a.rs:3:5:` (Rust 1.73 on) and `panicked at 'msg', src/a.rs:3:5` (before).
const PANIC = /panicked at (?:'.*?', |".*?", )?([^\s:'"]+\.rs):(\d+)(?::\d+)?/;
const ERROR = /^\s*error(\[E\d+\])?:/;
/** A runner's checkout prefix (`/home/runner/work/<repo>/<repo>/`, `D:\a\<repo>\<repo>\`), cut so the path is the repo's. */
const CHECKOUT = /^(?:.*?[/\\](?:work|a)[/\\][^/\\]+[/\\][^/\\]+[/\\])/;

/** A path inside the repo, or null: relative, no `..`, no option-like or odd characters, not a dependency's source. */
export function repoPath(raw: string): string | null {
  const p = raw.replace(CHECKOUT, "").replace(/\\/g, "/");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,250}$/.test(p)) return null;
  if (p.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  if (/(^|\/)(\.cargo|\.rustup|target)\//.test(p)) return null;
  return p;
}

/** The error and panic locations of a failure's log text, first seen first, without repeats. */
export function failureLocations(text: string): Location[] {
  const out: Location[] = [];
  const seen = new Set<string>();
  const add = (raw: string, line: string, what: Location["what"]) => {
    const file = repoPath(raw);
    const n = Number(line);
    if (!file || !Number.isInteger(n) || n < 1 || out.length >= MAX_LOCATIONS) return;
    const key = `${file}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line: n, what });
  };
  let sinceError = Infinity;
  for (const line of text.replace(ANSI, "").split(/\r?\n/)) {
    sinceError = ERROR.test(line) ? 0 : sinceError + 1;
    const p = PANIC.exec(line);
    if (p) add(p[1]!, p[2]!, "panic");
    // A `-->` belongs to the diagnostic above it; only an error's counts (a warning names lines that compiled).
    const a = ARROW.exec(line);
    if (a && sinceError <= 3) add(a[1]!, a[2]!, "error");
  }
  return out;
}

/**
 * The members of the batch the failure points at, each with the reason in one line. A location blamed to a commit
 * of exactly one member counts for it; failing that, a located file changed by exactly one member does. A git
 * error for one location (a file not in the tree, a line past its end) just skips that location.
 */
export async function suspects(git: BatchGit, b: { base_sha: string; commit_sha: string }, members: BatchMember[], locations: Location[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (members.length < 2 || !locations.length) return out;
  const commits = new Map<number, Set<string>>();
  const files = new Map<number, Set<string>>();
  for (const m of members) {
    const revs = await git.git(["rev-list", `${b.base_sha}..${m.head_oid}`]);
    commits.set(m.number, new Set(revs.code === 0 ? revs.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []));
    const diff = await git.git(["diff", "--name-only", "--no-renames", `${b.base_sha}...${m.head_oid}`]);
    files.set(m.number, new Set(diff.code === 0 ? diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []));
  }
  for (const l of locations) {
    const where = `${l.file}:${l.line}`;
    const blame = await git.git(["blame", "--porcelain", "-L", `${l.line},${l.line}`, b.commit_sha, "--", l.file]);
    const sha = blame.code === 0 ? /^([0-9a-f]{40})\s/.exec(blame.stdout)?.[1] : undefined;
    const byCommit = sha ? members.filter((m) => commits.get(m.number)!.has(sha)) : [];
    if (byCommit.length === 1) {
      const n = byCommit[0]!.number;
      if (!out.has(n)) out.set(n, `the ${l.what} at ${where} is in its commit ${sha!.slice(0, 7)}`);
      continue;
    }
    const byFile = members.filter((m) => files.get(m.number)!.has(l.file));
    if (byFile.length === 1) {
      const n = byFile[0]!.number;
      if (!out.has(n)) out.set(n, `the ${l.what} is in ${where}, a file only it changed`);
    }
  }
  return out;
}
