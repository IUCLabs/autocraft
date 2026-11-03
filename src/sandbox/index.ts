// Sandboxed tool access for model calls: what a call needs to run claude with
// read-only file tools on a checkout, and the default way to get a checkout of
// a pull request's head commit from the cached bare clone.
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { buildCheckout, checkoutRoot, pruneCheckouts } from "./checkout.ts";

export { REPO_PATH, sandboxCommand, type SandboxSpec } from "./command.ts";

const ORG = "storytold";
const MAX_AGE_MS = 24 * 3600_000;

/** The claude binary behind the PATH entry, with symlinks resolved so one file can be bound. CRAFT_AUTO_CLAUDE_BIN overrides. */
export function resolveClaudeBin(): string | null {
  const given = process.env.CRAFT_AUTO_CLAUDE_BIN;
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude"));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return realpathSync(c);
    } catch { /* next */ }
  }
  return null;
}

/** Whether tool mode can run on this machine: bubblewrap and the claude binary are present. */
export function sandboxAvailable(): boolean {
  return process.env.CRAFT_AUTO_NO_SANDBOX !== "1" && existsSync("/usr/bin/bwrap") && resolveClaudeBin() !== null;
}

/**
 * A checkout of the head commit of `repo#number` for a sandboxed call, or null
 * (with the reason logged) when tool mode is unavailable, the head moved, or
 * the tree is too large; the caller then asks without tools.
 */
export async function checkoutForPr(repo: string, number: number, sha: string, log: (line: string) => void = () => {}): Promise<string | null> {
  if (!sandboxAvailable()) return null;
  try {
    const dest = join(checkoutRoot(), repo, sha);
    pruneCheckouts(checkoutRoot(), MAX_AGE_MS);
    const g = new Git(exec, fixupDir(), repo);
    if (!existsSync(dest)) {
      const head = await g.fetchPr(ORG, repo, number);
      if (head !== sha) {
        log(`  ${repo}#${number}: head moved on; asking without tools`);
        return null;
      }
    }
    const r = await buildCheckout(g.dir, sha, dest);
    if (r.ok) return r.dir;
    log(`  ${repo}#${number}: no checkout (${r.reason}); asking without tools`);
  } catch (e) {
    log(`  ${repo}#${number}: no checkout (${String((e as Error).message).slice(0, 150)}); asking without tools`);
  }
  return null;
}
