// The real dependencies of the security scan: the pinned checkout from the bare cache and `claude` in the read-only sandbox.
import type { DatabaseSync } from "node:sqlite";
import { askClaude } from "../classify/run.ts";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { checkoutForCommit, ORG, sandboxAvailable } from "../sandbox/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import type { ScanDeps } from "./scan.ts";

export function realDeps(db: DatabaseSync, io: { cancelled: () => boolean; log: (line: string) => void; progress: (line: string) => void }): ScanDeps {
  let dir = "";
  return {
    ...io,
    checkout: async (repo) => {
      if (!sandboxAvailable()) {
        io.log("the sandbox is not available on this machine");
        return null;
      }
      const branch = (db.prepare("SELECT default_branch FROM main.repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch ?? "main";
      const sha = await new Git(exec, fixupDir(), repo).fetchBase(ORG, repo, branch);
      const d = await checkoutForCommit(repo, branch, sha, io.log);
      if (!d) return null;
      dir = d;
      return { dir: d, sha };
    },
    // The checkout is read-only in bubblewrap; the CLI keeps its API access, the model gets Read, Grep and Glob and no web tool.
    ask: (async (id: "security.model" | "security.area" | "security.verify", input: object) => {
      const r = await askClaude(id, "opus", [{ ...input, repo_dir: REPO_PATH }] as never, db, { checkout: dir });
      return r ? { text: r.text, cost: r.usage.cost } : null;
    }) as ScanDeps["ask"],
  };
}
