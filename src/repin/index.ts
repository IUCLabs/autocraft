// Autorepin: a pull request that depends on an unmerged pull request of another tracked repository (a craft-libs change,
// say) pins that repository's crates to a commit of its branch. Someone who may queue items on the repo comments
//
//   @<app-slug> autorepin storytold/craft-libs#12        (also `craft-libs#12`, the pull request's URL, or `off`)
//
// and once that pull request is merged into its default branch, this one gets a commit that sets the `rev` of every Cargo
// git dependency on that repository to the merge commit, with Cargo.lock updated to match. No model is involved:
//  - the manifests are rewritten here (src/repin/manifest.ts): only `rev` strings change;
//  - Cargo.lock is written by `cargo update --workspace` in a build environment, never on this host, and is accepted only
//    if it adds nothing but crates.io packages and the dependency at the merge commit;
//  - the commit is pushed with a lease on the head it was made on (pushRepin in src/github/write.ts), under the repo's
//    Pushes approval, after the access of the person who asked is read again.
// The outcome (pushed, failed with the reason, or dropped because the dependency's pull request closed unmerged) is a
// comment on the pull request.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAccess } from "../access.ts";
import { absolute } from "../build/artifacts.ts";
import { createTask } from "../build/tasks.ts";
import { guardRepo } from "../core/guard.ts";
import { audit } from "../dash/audit.ts";
import { ensureAuthorWrites, type PermissionReader } from "../fixup/author-permission.ts";
import { exec as defaultExec, fixupDir, Git, type Exec } from "../fixup/git.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { commitIdentity } from "../github/identity.ts";
import { pipelineAccount } from "../github/pipeline-account.ts";
import { ghComment, pushRepin, WritePacedError } from "../github/write.ts";
import type { Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { settleRefusal } from "../settlers.ts";
import { fetchScript } from "../worker/rust.ts";
import { repinsDue, type RepinRow } from "./due.ts";
import { lockRefusal, repinManifest, type PrRef } from "./manifest.ts";

/** Attempts that may end unfinished (GitHub unreadable, the head moved, the lockfile task failed) before the repin is given up. */
export const MAX_TRIES = 5;
/** Cargo.toml files read in one pull request. */
const MAX_MANIFESTS = 500;
const LOCK = "Cargo.lock";
const AUDIT_LOGIN = "autorepin";

/**
 * The lockfile step: the manifests arrive repinned (the task's patch), Cargo brings Cargo.lock in line with them, changing
 * nothing else it does not have to (`--workspace`), and the result is the task's artifact. The environment is the fetch
 * step's (src/worker/rust.ts): no repository cargo config, no toolchain file, and nothing of the repository runs.
 */
export const LOCK_SCRIPT = fetchScript(["/usr/local/cargo/bin/cargo update --workspace", `/bin/cp ${LOCK} /out/${LOCK}`]);

const MERGE_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $n) { state baseRefName mergeCommit { oid } }
  }
}`;
const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      state headRefOid headRefName maintainerCanModify
      headRepository { nameWithOwner }
      headRef { branchProtectionRule { id } }
    }
  }
}`;
type MergeRead = { repository?: { defaultBranchRef?: { name: string } | null; pullRequest?: { state: string; baseRefName: string; mergeCommit?: { oid: string } | null } | null } | null };
type PrRead = { repository?: { pullRequest?: { state: string; headRefOid: string; headRefName: string; maintainerCanModify: boolean; headRepository: { nameWithOwner: string } | null; headRef?: { branchProtectionRule?: { id: string } | null } | null } | null } | null };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const short = (sha: string): string => sha.slice(0, 12);
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;
const depRefOf = (r: { ref_repo: string; ref_number: number }): string => `${slugOf(r.ref_repo)}#${r.ref_number}`;
type Item = { kind: string; state: string };
const itemOf = (db: DatabaseSync, repo: string, number: number): Item | undefined =>
  db.prepare("SELECT kind, state FROM main.items WHERE repo = ? AND number = ?").get(repo, number) as Item | undefined;

// ---- the command ---------------------------------------------------------------

/**
 * Sets (or with `ref` null, drops) the autorepin of a pull request for the commenter of a command. Who may is the rule of
 * every write a person starts (settleRefusal in src/settlers.ts). Returns what the answer says; throws with the reason when refused.
 */
export async function requestRepin(db: DatabaseSync, o: { login: string; role: string; canWrite: boolean; repo: string; number: number; pr: boolean; ref: PrRef | null; now?: Date }): Promise<string> {
  if (!o.pr) throw new Error("autorepin is for pull requests");
  const refusal = await settleRefusal(db, { login: o.login, role: o.role, canWrite: async (r) => r === o.repo && o.canWrite }, [o.repo], `sets autorepin on ${o.repo}`);
  if (refusal) throw new Error(refusal);
  const at = (o.now ?? new Date()).toISOString();
  const me = itemOf(db, o.repo, o.number);
  if (me?.kind !== "pr" || me.state !== "OPEN") throw new Error("this pull request is not open");
  if (!o.ref) {
    const n = db.prepare("UPDATE main.autorepins SET state = 'cancelled', result = NULL, done_at = ?, notice = 'none' WHERE repo = ? AND number = ? AND state IN ('waiting', 'locking')").run(at, o.repo, o.number).changes;
    if (!n) throw new Error("no autorepin is waiting on this pull request");
    audit(db, o.login, "autorepin-off", refOf(o), {});
    return "Autorepin is off for this pull request";
  }
  const dep = (db.prepare("SELECT name FROM main.tracked_repos WHERE name = ? COLLATE NOCASE").get(o.ref.name) as { name: string } | undefined)?.name;
  if (!dep || (o.ref.owner !== null && o.ref.owner.toLowerCase() !== ownerOf(dep).toLowerCase())) throw new Error(`${o.ref.owner ? `${o.ref.owner}/` : ""}${o.ref.name} is not a repository AutoCraft tracks`);
  const depRef = `${slugOf(dep)}#${o.ref.number}`;
  if (dep === o.repo) throw new Error("the pull request to wait for must be in another repository");
  const other = itemOf(db, dep, o.ref.number);
  if (other?.kind !== "pr") throw new Error(`${depRef} is not a pull request AutoCraft has read`);
  if (other.state === "CLOSED") throw new Error(`${depRef} was closed without merging`);
  const g = guardRepo(db, o.repo, "push", { operator: o.login }, undefined, o.login);
  if ("refused" in g) throw new Error(g.refused);
  db.prepare(`INSERT INTO main.autorepins (repo, number, ref_repo, ref_number, login, requested_at, state) VALUES (?, ?, ?, ?, ?, ?, 'waiting')
    ON CONFLICT (repo, number, ref_repo) DO UPDATE SET ref_number = excluded.ref_number, login = excluded.login, requested_at = excluded.requested_at, state = 'waiting',
      sha = NULL, head = NULL, task_id = NULL, tries = 0, tried_at = NULL, to_head = NULL, result = NULL, done_at = NULL, notice = NULL`)
    .run(o.repo, o.number, dep, o.ref.number, o.login, at);
  audit(db, o.login, "autorepin-set", refOf(o), { on: depRef });
  return other.state === "MERGED"
    ? `Autorepin set: ${depRef} is already merged, so ${slugOf(dep)} is repinned to its merge commit here now`
    : `Autorepin set: once ${depRef} is merged, ${slugOf(dep)} is repinned to its merge commit here, in a commit pushed to this branch`;
}

// ---- the work ------------------------------------------------------------------

export type RepinDeps = {
  querier: Querier;
  /** Runs git and gh. */
  exec?: Exec;
  /** Directory holding one bare cache repository per repo (default: the fix-ups'). */
  root?: string;
  /** Reads the asker's live permission (default: the conversation cards' read, src/conversations/act.ts). */
  permission?: (q: Querier, repo: string, login: string) => Promise<"ok" | "no" | "transient">;
  /** Reads a same-repo PR author's permission (default: gh). */
  authorPermission?: PermissionReader;
  now?: () => Date;
  log?: (l: string) => void;
  /** Autorepins that call GitHub in one drain. */
  limit?: number;
};

/** The step ended for good; `notice` "none": nothing is said on GitHub (the pull request itself is closed). */
class Ended extends Error {
  readonly state: "failed" | "cancelled" | "pushed";
  readonly notice: "none" | null;
  readonly toHead: string | null;
  constructor(state: "failed" | "cancelled" | "pushed", result: string | null, o: { notice?: "none"; toHead?: string } = {}) {
    super(result ?? "");
    this.state = state;
    this.notice = o.notice ?? null;
    this.toHead = o.toHead ?? null;
  }
}
const failed = (why: string): Ended => new Ended("failed", oneLine(why));

const KEY = "repo = ? AND number = ? AND ref_repo = ?";
const keyOf = (r: RepinRow): [string, number, string] => [r.repo, r.number, r.ref_repo];

function finish(db: DatabaseSync, r: RepinRow, e: Ended, at: Date): void {
  db.prepare(`UPDATE main.autorepins SET state = ?, result = ?, done_at = ?, to_head = ?, notice = ? WHERE ${KEY}`).run(e.state, e.message || null, at.toISOString(), e.toHead, e.notice, ...keyOf(r));
  audit(db, AUDIT_LOGIN, "autorepin", refOf(r), { on: depRefOf(r), by: r.login, state: e.state, ...(e.message ? { result: e.message } : {}), ...(e.toHead ? { commit: e.toHead } : {}) });
}

/** One step of an autorepin: from `waiting` it queues the lockfile task (or pushes, without a lockfile); from `locking` it takes the task's lockfile and pushes. Throws `Ended` when it is over, anything else to try again. */
async function step(db: DatabaseSync, r: RepinRow, d: RepinDeps): Promise<void> {
  const q = d.querier, run = d.exec ?? defaultExec;
  const dep = slugOf(r.ref_repo), depRef = depRefOf(r);
  const me = itemOf(db, r.repo, r.number);
  if (me?.kind !== "pr" || me.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const other = itemOf(db, r.ref_repo, r.ref_number);
  if (!other) throw failed(`AutoCraft no longer has ${depRef}`);
  if (other.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);

  // The merge commit, from GitHub: it must be on the default branch, where the dependency's revs are to come from.
  const m = await q.query(MERGE_QUERY, { owner: ownerOf(r.ref_repo), name: r.ref_repo, n: r.ref_number }) as MergeRead;
  const merged = m.repository?.pullRequest;
  if (!merged) throw new Error(`GitHub returned no ${depRef}`);
  if (merged.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);
  if (merged.state !== "MERGED") throw new Error(`${depRef} is not merged on GitHub yet`);
  const main = m.repository?.defaultBranchRef?.name;
  if (!main) throw new Error(`GitHub returned no default branch for ${dep}`);
  if (merged.baseRefName !== main) throw failed(`${depRef} was merged into ${merged.baseRefName}, not into ${dep}'s default branch ${main}`);
  const sha = merged.mergeCommit?.oid ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub returned no merge commit for ${depRef}`);

  // Whoever asked must still be allowed to, and the repo must still approve pushes.
  const access = getAccess(db, r.login);
  if (!access) throw failed(`${r.login} no longer has an AutoCraft login`);
  const permission = d.permission ?? (await import("../conversations/act.ts")).liveWrite;
  const p = await permission(q, r.repo, r.login).catch(() => "transient" as const);
  if (p === "transient") throw new Error(`GitHub could not tell ${r.login}'s access to ${slugOf(r.repo)}`);
  const refusal = await settleRefusal(db, { login: r.login, role: access.role, canWrite: async (x) => x === r.repo && p === "ok" }, [r.repo], `repins on ${r.repo}`);
  if (refusal) throw failed(refusal);
  const g = guardRepo(db, r.repo, "push", { operator: r.login }, undefined, r.login);
  if ("refused" in g) throw failed(g.refused);

  const l = await q.query(PR_QUERY, { owner: ownerOf(r.repo), name: r.repo, n: r.number }) as PrRead;
  const pr = l.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub returned no ${refOf(r)}`);
  if (pr.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const head = pr.headRefOid;
  if (r.state === "locking" && r.head !== head) throw new Error("the head moved while the lockfile was written");
  const headRepo = pr.headRepository?.nameWithOwner;
  const writes = headRepo ? await ensureAuthorWrites(db, r.repo, r.number, headRepo, d.authorPermission) : "no";
  if (writes === "unknown") throw new Error("the author's permission could not be read yet");
  if (!headRepo || !pushable(headRepo, r.repo, pr.maintainerCanModify, pr.headRefName, longLivedOf(db, r.repo), !!pr.headRef?.branchProtectionRule, writes === "yes")) {
    throw failed("AutoCraft cannot push to this pull request's branch (a fork that does not allow maintainer edits, or a protected or shared branch)");
  }

  const root = d.root ?? fixupDir();
  mkdirSync(root, { recursive: true });
  const git = new Git(run, root, r.repo);
  const fetched = await git.fetchPr(ownerOf(r.repo), r.repo, r.number);
  if (fetched !== head) throw new Error(`the fetched head ${short(fetched)} is not the head GitHub reports`);
  const paths = (await git.must(["ls-tree", "-r", "--name-only", "-z", head])).split("\0").filter(Boolean);
  const manifests = paths.filter((p) => /(^|\/)Cargo\.toml$/.test(p));
  if (manifests.length > MAX_MANIFESTS) throw failed(`the pull request has more than ${MAX_MANIFESTS} Cargo.toml files`);
  const name = r.ref_repo.toLowerCase();
  const files: { path: string; mode: string; content: string }[] = [];
  let pinned = 0, unpinned = 0;
  for (const path of manifests) {
    const f = await git.file(head, path);
    // A manifest that never names the repository (a test fixture, say) is not read as TOML at all.
    if (!f.ok) { if (f.tooLarge) throw failed(f.reason); continue; }
    if (!f.content.toLowerCase().includes(name)) continue;
    const out = repinManifest(f.content, dep, sha);
    if (!out.ok) throw failed(`${path}: ${out.reason}`);
    pinned += out.pinned;
    unpinned += out.unpinned;
    if (out.from.length) files.push({ path, mode: f.mode, content: out.text });
  }
  if (!pinned) throw failed(`no Cargo.toml of this pull request pins ${dep} by rev${unpinned ? ` (${unpinned} use a branch, a tag or no rev, which autorepin leaves alone)` : ""}`);
  if (!files.length) throw new Ended("pushed", `${dep} is already pinned to ${short(sha)}, the merge of ${depRef}; nothing to change`);

  const scratch = mkdtempSync(join(root, ".index-"));
  try {
    let tree = await git.withFiles(head, files, join(scratch, "index"));
    const changed = files.map((f) => f.path);
    if (paths.includes(LOCK)) {
      const lock = await git.file(head, LOCK);
      if (!lock.ok) throw failed(lock.reason);
      if (r.state !== "locking") {
        const id = createTask(db, {
          step: "autorepin", repo: r.repo, number: r.number, headSha: head, requires: { os: "linux", toolchains: ["rust-stable"] }, patch: await git.diffText(head, tree),
          plan: [{ name: "lock", cmd: ["sh", "-c", LOCK_SCRIPT], network: "fetch", timeoutSec: 900, artifacts: [LOCK] }],
        });
        db.prepare(`UPDATE main.autorepins SET state = 'locking', sha = ?, head = ?, task_id = ? WHERE ${KEY}`).run(sha, head, id, ...keyOf(r));
        d.log?.(`autorepin ${refOf(r)}: lockfile task ${id} queued for ${dep} at ${short(sha)}`);
        return;
      }
      const t = db.prepare("SELECT state FROM main.build_tasks WHERE id = ?").get(r.task_id) as { state: string } | undefined;
      if (t?.state !== "done") throw new Error(`the lockfile task ${t ? t.state : "is gone"}`);
      const art = db.prepare("SELECT file FROM main.build_artifacts WHERE task_id = ? AND name = ?").get(r.task_id, LOCK) as { file: string } | undefined;
      const file = art ? absolute(art.file) : null;
      if (!file) throw new Error("the lockfile task returned no Cargo.lock");
      const after = readFileSync(file, "utf8");
      const no = lockRefusal(lock.content, after, dep, sha);
      if (no) throw failed(no);
      if (after !== lock.content) {
        tree = await git.withFiles(tree, [{ path: LOCK, mode: lock.mode, content: after }], join(scratch, "index"));
        changed.push(LOCK);
      }
    }
    const who = await commitIdentity(db, r.repo, () => pipelineAccount(run));
    const commit = await git.commit(tree, head, `Repin ${r.ref_repo} to ${short(sha)}\n\nThe merge commit of ${depRef}.\n`, { name: who.name, email: who.email });
    // The commit is exactly the rewritten manifests and the lockfile: contents of files that exist, nothing added, removed or re-moded.
    const changes = await git.rawChanges(head, commit);
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1]) || changes.map((x) => x[3]!).sort().join("\n") !== [...changed].sort().join("\n")) throw failed("the commit would change more than the revs and the lockfile");
    // Written before the push, so a head that reaches the mirror before the outcome is recorded is already known as this commit (ownPush in src/preapproval).
    db.prepare(`UPDATE main.autorepins SET head = ?, to_head = ? WHERE ${KEY}`).run(head, commit, ...keyOf(r));
    const push = await pushRepin({ db, login: AUDIT_LOGIN }, g, git, { repo: r.repo, number: r.number, remote: headRepo, branch: pr.headRefName, head, sha: commit }, { on: depRef, rev: sha, files: changed, by: r.login });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/stale info|rejected|fetch first/i.test(err)) throw new Error("the branch moved before the push");
      if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) throw failed("GitHub refused the push to this pull request's branch");
      throw new Error(`the push failed: ${err}`);
    }
    throw new Ended("pushed", `Repinned ${dep} to ${short(sha)}, the merge of ${depRef}, in ${short(commit)} (${changed.join(", ")})`, { toHead: commit });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The comment that tells the outcome on the pull request. */
export function noticeText(r: Pick<RepinRow, "login" | "state" | "result" | "ref_repo">): string {
  if (r.state === "pushed") return `@${r.login} ${r.result}.`;
  return r.state === "cancelled" ? `@${r.login} Autorepin is off: ${r.result}.` : `@${r.login} Autorepin of ${slugOf(r.ref_repo)} failed: ${r.result}.`;
}

/** Posts the outcome. A paced write leaves it for the next drain; any other failure is logged and not retried. */
async function notify(db: DatabaseSync, r: RepinRow, d: RepinDeps): Promise<"posted" | "failed" | "paced"> {
  const g = guardRepo(db, r.repo, null, { operator: r.login }, undefined, r.login);
  let notice: "posted" | "failed" = "failed";
  if ("refused" in g) d.log?.(`autorepin ${refOf(r)}: no comment: ${g.refused}`);
  else {
    try {
      const out = await ghComment({ db, login: AUDIT_LOGIN }, g, d.exec ?? defaultExec, "autorepin-comment", { repo: r.repo, number: r.number, pr: true }, { by: "fixed-operator" }, noticeText(r), { on: depRefOf(r), state: r.state });
      if (out.code === 0) notice = "posted";
      else d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(String((e as Error)?.message ?? e))}`);
    }
  }
  db.prepare(`UPDATE main.autorepins SET notice = ? WHERE ${KEY}`).run(notice, ...keyOf(r));
  return notice;
}

/** Takes the next step of every autorepin that has one (src/repin/due.ts) and posts the outcomes. Returns how many ended. */
export async function drainRepins(db: DatabaseSync, deps: RepinDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  let ended = 0, calls = 0;
  for (const r0 of repinsDue(db, clock())) {
    if (calls++ >= (deps.limit ?? 5)) break;
    let r = r0;
    if (r.state === "waiting" || r.state === "locking") {
      try {
        await step(db, r, deps);
        continue;
      } catch (e) {
        if (e instanceof WritePacedError) break;
        if (e instanceof Ended) finish(db, r, e, clock());
        else {
          // Not finished: from the start again after a minute, and given up with the reason after MAX_TRIES.
          const why = oneLine(String((e as Error)?.message ?? e));
          deps.log?.(`autorepin ${refOf(r)}: try ${r.tries + 1} of ${MAX_TRIES}: ${why}`);
          if (r.tries + 1 >= MAX_TRIES) finish(db, r, failed(why), clock());
          else { db.prepare(`UPDATE main.autorepins SET state = 'waiting', head = NULL, to_head = NULL, task_id = NULL, tries = tries + 1, tried_at = ? WHERE ${KEY}`).run(clock().toISOString(), ...keyOf(r)); continue; }
        }
      }
      ended++;
      r = db.prepare(`SELECT * FROM main.autorepins WHERE ${KEY}`).get(...keyOf(r)) as RepinRow;
      deps.log?.(`autorepin ${refOf(r)}: ${r.state}${r.result ? `: ${r.result}` : ""}`);
    }
    if (r.notice === null && (await notify(db, r, deps)) === "paced") break;
  }
  return ended;
}
