// Git and gh access for the fix-up step, through one injectable runner. The
// checkout is untrusted: a bare repository only (no working tree, so no
// filters, textconv drivers or hooks run), reached over HTTPS with the gh
// credential helper, with every command given the same locked-down config.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOpts = { cwd?: string; env?: Record<string, string>; input?: string };
/** Runs a command; resolves with its exit code, rejects only when it can't be started. */
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

export const exec: Exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  p.on("error", reject);
  p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  p.stdin.on("error", () => {});
  p.stdin.end(opts.input ?? "");
});

export function fixupDir(): string {
  return process.env.CRAFT_AUTO_FIXUP_DIR ?? join(homedir(), ".cache/craft-automation/fixups");
}

const HARDENING = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
  "-c", "core.fsmonitor=false",
  "-c", "core.symlinks=false",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "credential.helper=!gh auth git-credential",
];
const ENV = { GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" };

export class Git {
  readonly dir: string;
  private run: Exec;
  constructor(run: Exec, root: string, repo: string) {
    this.run = run;
    this.dir = join(root, repo);
  }

  /** git in the bare repository; `env` adds to the locked-down environment. */
  async git(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    return this.run("git", [...HARDENING, ...args], { cwd: this.dir, input: opts.input, env: { ...ENV, ...opts.env } });
  }

  /** Like git(), failing on a non-zero exit. */
  async must(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
    const r = await this.git(args, opts);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n").pop() ?? r.code}`);
    return r.stdout;
  }

  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const r = await this.git(["rev-parse", "--git-dir"]);
    if (r.code !== 0 || r.stdout.trim() !== ".") await this.must(["init", "--bare", "--quiet", "."]);
  }

  /** Fetches the PR's head (`refs/pull/N/head` of the base repo) and returns the commit it points at. */
  async fetchPr(org: string, repo: string, number: number): Promise<string> {
    await this.init();
    await this.must(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", `https://github.com/${org}/${repo}.git`, `+refs/pull/${number}/head:refs/fixup/pr-${number}`]);
    return (await this.must(["rev-parse", `refs/fixup/pr-${number}`])).trim();
  }

  /** The blob at `sha:path` as text with its mode, or why it can't be used. */
  async file(sha: string, path: string): Promise<{ ok: true; mode: string; content: string } | { ok: false; reason: string }> {
    const t = await this.git(["ls-tree", sha, "--", path]);
    const m = t.stdout.match(/^(\d+) (\w+) [0-9a-f]+\t/);
    if (t.code !== 0 || !m) return { ok: false, reason: `${path} does not exist at the head commit` };
    if (m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) return { ok: false, reason: `${path} is not a regular file` };
    const r = await this.git(["cat-file", "blob", `${sha}:${path}`]);
    if (r.code !== 0) return { ok: false, reason: `could not read ${path}` };
    if (r.stdout.includes("\0")) return { ok: false, reason: `${path} is binary` };
    return { ok: true, mode: m[1]!, content: r.stdout };
  }

  /**
   * Applies `patch` to the tree of `head` in a private index file (no working
   * tree) and returns the new tree id, or why it doesn't apply.
   */
  async applyToTree(head: string, patch: string, indexFile: string): Promise<{ ok: true; tree: string } | { ok: false; reason: string }> {
    const env = { GIT_INDEX_FILE: indexFile };
    await this.must(["read-tree", head], { env });
    const chk = await this.git(["apply", "--cached", "--check", "--whitespace=nowarn", "-"], { input: patch, env });
    if (chk.code !== 0) return { ok: false, reason: `git apply --check: ${chk.stderr.trim().split("\n")[0] ?? "failed"}`.slice(0, 200) };
    await this.must(["apply", "--cached", "--whitespace=nowarn", "-"], { input: patch, env });
    return { ok: true, tree: (await this.must(["write-tree"], { env })).trim() };
  }

  /** Changes between two commits as `git diff-tree --raw` rows: [old mode, new mode, status, path]. */
  async rawChanges(from: string, to: string): Promise<string[][]> {
    const out = await this.must(["diff-tree", "-r", "--raw", "--no-renames", "-z", from, to]);
    const parts = out.split("\0").filter(Boolean);
    const rows: string[][] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [a, b, , , status] = parts[i]!.slice(1).split(" ");
      rows.push([a!, b!, status!, parts[i + 1]!]);
    }
    return rows;
  }

  async commit(tree: string, parent: string, message: string, who: { name: string; email: string }): Promise<string> {
    const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    return (await this.must(["commit-tree", tree, "-p", parent, "-F", "-"], { input: message, env })).trim();
  }

  /** Pushes `sha` to the contributor's branch; refuses when the branch is no longer at `expected`. */
  async push(headRepo: string, branch: string, sha: string, expected: string): Promise<ExecResult> {
    return this.git(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${expected}`, `https://github.com/${headRepo}.git`, `${sha}:refs/heads/${branch}`]);
  }
}
