// Applies a task's patch to the unpacked source on the host. The patch comes
// from a model or a PR, so it is checked before git sees it: no paths outside
// the tree, no symlinks, no binary content.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PATCH_MAX_BYTES = 1024 * 1024;

// The ceiling keeps git from finding a repository above the source dir, where it would skip every path outside the working directory's prefix.
function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C", GIT_CEILING_DIRECTORIES: dirname(cwd) } }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) }),
    ),
  );
}

function badPath(p: string): boolean {
  return p.startsWith("/") || p.includes("\0") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || s === ".git");
}

/** Reason the patch text must be refused, or null. */
export function patchProblem(patch: string): string | null {
  for (const line of patch.split("\n")) {
    const mode = /^(?:new file mode|deleted file mode|old mode|new mode) (\S+)\s*$/.exec(line) ?? /^index [0-9a-f.]+\.\.[0-9a-f.]+ (\S+)\s*$/.exec(line);
    if (mode && !/^100(644|755)$/.test(mode[1]!)) return "patch touches a symlink or special file";
    if (/^(GIT binary patch|Binary files .* differ)$/.test(line)) return "patch has binary content";
    if (/^(rename|copy) (from|to) /.test(line) || /^(---|\+\+\+) /.test(line) || /^diff --git /.test(line)) {
      const rest = line.replace(/^(diff --git|---|\+\+\+|(rename|copy) (from|to)) /, "");
      for (const tok of line.startsWith("diff --git ") ? rest.split(/ (?=[ab]\/)/) : [rest]) {
        const p = tok.replace(/\t.*$/, "").replace(/^"|"$/g, "").replace(/^[ab]\//, "");
        if (tok.startsWith("\"") && /\\/.test(tok)) return "patch has an escaped path";
        if (p !== "/dev/null" && badPath(p)) return "patch path outside the tree";
      }
    }
  }
  return null;
}

/** First line of git's error, with directories and control characters removed. */
export function scrubGitError(text: string, dirs: string[]): string {
  let line = text.split("\n").find((l) => l.trim()) ?? "";
  for (const d of dirs) line = line.replaceAll(d, "<dir>");
  return line.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
}

/** Applies `patch` in `srcDir`. `scratch` is a directory outside the tree for the patch file. Returns an error summary or null. */
export async function applyPatch(patch: string, srcDir: string, scratch: string): Promise<string | null> {
  const problem = patchProblem(patch);
  if (problem) return `patch refused: ${problem}`;
  const file = `${scratch}/change.patch`;
  writeFileSync(file, patch);
  const dirs = [srcDir, scratch];
  const names = await git(["apply", "--numstat", "-z", file], srcDir);
  if (!names.ok) return `patch does not apply: ${scrubGitError(names.stderr, dirs)}`;
  if (!names.stdout) return "patch does not apply: patch changes no files";
  const parts = names.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    if (m[1] === "-" || m[2] === "-") return "patch refused: patch has binary content";
    const paths = m[3] === "" ? [parts[++i] ?? "", parts[++i] ?? ""] : [m[3]];
    if (paths.some(badPath)) return "patch refused: patch path outside the tree";
  }
  const check = await git(["apply", "--check", file], srcDir);
  if (!check.ok) return `patch does not apply: ${scrubGitError(check.stderr, dirs)}`;
  const done = await git(["apply", file], srcDir);
  if (!done.ok) return `patch does not apply: ${scrubGitError(done.stderr, dirs)}`;
  return null;
}
