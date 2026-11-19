// The task bundle of a remote call: what the helper needs to run one prompt as the server would, with the checkouts as
// mounts it fetches itself (public repos from GitHub, private ones as tarballs from the server) and small files inline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "../../web/src/api/types.ts";
import { CLAUDE_PROMPTS, type ClaudePromptId } from "../prompts/index.ts";
import { repoOfCheckout } from "../sandbox/repo-docs.ts";
import { REPO_DOCS_PATH, REPO_PATH, reposPath } from "../sandbox/command.ts";
import { tierOfModel } from "./mode.ts";
import type { Mount, Tier } from "./protocol.ts";

/** The MCP server of a call's reference documentation in the user-local mode, served per lease; there is no /reference mount. */
export const REFERENCE_SERVER = "reference";

/** The tier of a prompt: that of its default model. */
export const promptTier = (id: ClaudePromptId): Tier => tierOfModel(CLAUDE_PROMPTS[id].models[0]!);

/** The repo and commit of a checkout under the checkout root (`<root>/<repo>/<sha>`), or null for any other directory. */
export function checkoutCommit(dir: string): { repo: string; sha: string } | null {
  const repo = repoOfCheckout(dir), sha = basename(dir);
  return repo && /^[0-9a-f]{40,64}$/.test(sha) ? { repo, sha } : null;
}

const repoRow = (db: DatabaseSync, repo: string): { owner: string; visibility: string | null } =>
  (db.prepare("SELECT owner, visibility FROM main.repos WHERE name = ?").get(repo) as { owner: string; visibility: string | null } | undefined) ?? { owner: "", visibility: null };

/** A repo at a commit: a git mount for a public repo (with the pull request's head ref when the commit is a head of one of `items`), else a tarball the server serves. */
function repoMount(db: DatabaseSync, path: string, repo: string, sha: string, items: ItemRef[]): Mount {
  const r = repoRow(db, repo);
  if (r.visibility !== "public" || !r.owner) return { kind: "tarball", path, repo, sha };
  const pr = items.find((i) => i.repo === repo && db.prepare("SELECT 1 FROM main.items WHERE repo = ? AND number = ? AND kind = 'pr' AND head_oid = ?").get(repo, i.number, sha) !== undefined);
  return { kind: "git", path, owner: r.owner, repo, sha, ...(pr && { ref: `refs/pull/${pr.number}/head` }) };
}

/** The files of a small host directory (no subdirectories), inline. */
function filesMount(path: string, dir: string): Mount {
  const files = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort().map((name) => ({ name, base64: readFileSync(join(dir, name)).toString("base64") }));
  return { kind: "files", path, files };
}

/** The read-only mounts of a sandboxed call: the item's checkout at /repo, the workspace at /repos/<name> (public repos only), the repo docs at /repo-docs. */
export function bundleMounts(db: DatabaseSync, at: { repo: string; sha: string }, items: ItemRef[], shared: { name: string; dir: string }[] = [], docsDir?: string): Mount[] {
  const out: Mount[] = [repoMount(db, REPO_PATH, at.repo, at.sha, items)];
  for (const s of shared) {
    const c = checkoutCommit(s.dir);
    if (c) out.push(repoMount(db, reposPath(s.name), c.repo, c.sha, items));
  }
  if (docsDir) out.push(filesMount(REPO_DOCS_PATH, docsDir));
  return out;
}
