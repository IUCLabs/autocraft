// The only module that writes to GitHub. Every function performs the write
// and records it in the audit table itself, failed attempts included, so a
// caller cannot write without leaving a record. Writes to a pull request take a
// `Guarded` value that only core/guard.ts makes, so the compiler enforces that the
// guard ran right before. Transports (querier, exec, git, merge command) stay
// injected so tests fake them and assert the rows.
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { connect } from "../db.ts";
import type { Grant, Guarded, GuardedItem, GuardedRepo } from "../core/guard.ts";
import type { Exec, ExecResult, Git } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";
import { type Note, withNote } from "./note.ts";

export { GITHUB_ACTIONS } from "./actions.ts";
export type { Note } from "./note.ts";

/** Who writes (the audit login: the stage name, or the operator for manual actions) and where the row goes. */
export type Writer = { db: DatabaseSync; login: string };
type Details = Record<string, unknown>;
type Retry = <T>(f: () => Promise<T>) => Promise<T>;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const direct: Retry = (f) => f();
/** The repo as audit targets name it: bare for the organisation's repos, OWNER/REPO for any other owner. */
const repoName = (slug: string): string => (slug.startsWith(`${ORG}/`) ? slug.slice(ORG.length + 1) : slug);
const refOf = (repo: string, number: number): string => `${repo}#${number}`;

/** A grant covers writes to its own repo (and, for a PR or item grant, its own number); a write elsewhere is a bug. */
function covers(g: Grant, repo: string, number?: number): void {
  if (g.repo !== repo || (number !== undefined && "number" in g && g.number !== number)) throw new Error(`the guard covers ${g.repo}${"number" in g ? `#${g.number}` : ""}, not ${repo}${number === undefined ? "" : `#${number}`}`);
}

/** Adds the row before the write, so a crash during the call leaves a "started" row: an unknown outcome. */
function begin(w: Writer, action: string, target: string, details: Details): number {
  const r = w.db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), w.login, action, target, JSON.stringify({ ...details, state: "started" }));
  return Number(r.lastInsertRowid);
}

function finish(w: Writer, id: number, details: Details, error?: string): void {
  const d = error === undefined ? { ...details, state: "done" } : { ...details, state: "failed", error };
  w.db.prepare("UPDATE audit SET details = ? WHERE rowid = ?").run(JSON.stringify(d), id);
}

/** Records the row first, runs the write, then marks the row done with `view`'s extra details or failed with the error. */
async function recorded<T>(w: Writer, action: string, target: string, details: Details, f: () => Promise<T>, view?: (r: T) => Details, failure?: (r: T) => string | null): Promise<T> {
  const id = begin(w, action, target, details);
  let r: T;
  try {
    r = await f();
  } catch (e) {
    finish(w, id, details, oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  const bad = failure?.(r) ?? null;
  if (bad !== null) finish(w, id, details, bad);
  else finish(w, id, { ...details, ...view?.(r) });
  return r;
}

// ---- GraphQL mutations ------------------------------------------------------

const ADD_COMMENT = `mutation($id: ID!, $body: String!) {
  addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } }
}`;
const CLOSE_ISSUE = `mutation($id: ID!) { closeIssue(input: { issueId: $id }) { clientMutationId } }`;
const CLOSE_PR = `mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;
const ASSIGN = `mutation($id: ID!, $user: ID!) {
  addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const UNASSIGN = `mutation($id: ID!, $user: ID!) {
  removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const ADD_REVIEW = `mutation($pr: ID!, $oid: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $oid, body: $body, event: COMMENT }) { pullRequestReview { id } }
}`;
const EDIT_REVIEW = `mutation($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } }
}`;
const CREATE_LABEL = `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`;

/** One aliased `addLabelsToLabelable` per item, with variables `i<k>` (node id) and `l<k>` (label ids). */
export function addLabelsMutation(count: number): string {
  const ks = Array.from({ length: count }, (_, k) => k);
  const decl = ks.flatMap((k) => [`$i${k}: ID!`, `$l${k}: [ID!]!`]);
  const body = ks.map((k) => `m${k}: addLabelsToLabelable(input: {labelableId: $i${k}, labelIds: $l${k}}) { clientMutationId }`);
  return `mutation(${decl.join(", ")}) { ${body.join("\n")} }`;
}

export type ItemRef = { repo: string; number: number; id: string };

/** Posts a comment on an issue or PR; returns the comment's URL. `details` is the source (run or decision) and any context. */
export async function commentOn(w: Writer, g: Grant, q: Querier, action: string, item: ItemRef, note: Note, text: string, details: Details = {}): Promise<string> {
  covers(g, item.repo, item.number);
  const body = withNote(note, text);
  const r = await recorded(w, action, refOf(item.repo, item.number), { ...details, text: body },
    () => q.query(ADD_COMMENT, { id: item.id, body }) as Promise<{ addComment?: { commentEdge?: { node?: { url?: string } } } }>,
    (x) => ({ url: x.addComment?.commentEdge?.node?.url ?? undefined }));
  return r.addComment?.commentEdge?.node?.url ?? "";
}

export async function closeItem(w: Writer, g: Grant, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "act-close", refOf(item.repo, item.number), details, () => q.query(item.pr ? CLOSE_PR : CLOSE_ISSUE, { id: item.id }));
}

export async function assignTo(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "assign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(ASSIGN, { id: item.id, user: user.id }));
}

export async function unassignFrom(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "unassign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(UNASSIGN, { id: item.id, user: user.id }));
}

/** Posts a review as a plain comment review on the commit; returns the review id (null when GitHub returned none). */
export async function postReview(w: Writer, q: Querier, g: Guarded, nodeId: string, note: Note, text: string, details: Details = {}): Promise<string | null> {
  const body = withNote(note, text);
  const r = await recorded(w, "review-post", refOf(g.repo, g.number), { ...details, head: g.head },
    () => q.query(ADD_REVIEW, { pr: nodeId, oid: g.head, body }) as Promise<{ addPullRequestReview?: { pullRequestReview?: { id?: string } | null } | null }>,
    (x) => ({ review: x.addPullRequestReview?.pullRequestReview?.id ?? undefined }),
    (x) => (x.addPullRequestReview?.pullRequestReview?.id ? null : "GitHub returned no review"));
  return r.addPullRequestReview?.pullRequestReview?.id ?? null;
}

export async function editReview(w: Writer, q: Querier, g: Guarded, reviewId: string, note: Note, text: string, details: Details = {}): Promise<void> {
  const body = withNote(note, text);
  await recorded(w, "review-edit", refOf(g.repo, g.number), { ...details, head: g.head, review: reviewId }, () => q.query(EDIT_REVIEW, { id: reviewId, body }));
}

export async function createLabel(w: Writer, g: GuardedRepo, q: Querier, repo: string, repoId: string, label: { name: string; color: string; description: string }, retry: Retry = direct, details: Details = {}): Promise<void> {
  covers(g, repo);
  await recorded(w, "label-create", repo, { ...details, name: label.name }, () => retry(() => q.query(CREATE_LABEL, { input: { repositoryId: repoId, ...label } })));
}

export type LabelWrite = { number: number; id: string; labelIds: string[]; names: string[]; /** The guard that let this item's labels through (an item grant, or the repo grant of a conversation card). */ g: GuardedItem | GuardedRepo };

/** Adds labels to several items in one request. One row per item: labelled with the names, or the failure. Returns the numbers that succeeded. */
export async function addLabels(w: Writer, q: Querier, repo: string, items: LabelWrite[], retry: Retry = direct, details: Details = {}): Promise<number[]> {
  const vars: Record<string, unknown> = {};
  for (const it of items) covers(it.g, repo, it.number);
  items.forEach((it, k) => { vars[`i${k}`] = it.id; vars[`l${k}`] = it.labelIds; });
  const det = (it: LabelWrite): Details => ({ ...details, labels: it.names });
  const ids = items.map((it) => begin(w, "labels-apply", refOf(repo, it.number), det(it)));
  let d: Record<string, unknown> | null;
  try {
    d = await retry(() => q.query(addLabelsMutation(items.length), vars));
  } catch (e) {
    const msg = oneLine(String((e as Error).message ?? e));
    items.forEach((it, k) => finish(w, ids[k]!, det(it), msg));
    throw e;
  }
  const done: number[] = [];
  items.forEach((it, k) => {
    if (d && d[`m${k}`] !== null && d[`m${k}`] !== undefined) {
      done.push(it.number);
      finish(w, ids[k]!, det(it));
    } else finish(w, ids[k]!, det(it), "GitHub did not apply the labels");
  });
  return done;
}

// ---- gh commands -------------------------------------------------------------

const GH_URL = /https:\/\/github\.com\/\S+/;

async function viaGh(w: Writer, exec: Exec, action: string, target: string, details: Details, args: string[], input?: string): Promise<ExecResult> {
  return recorded(w, action, target, details, () => exec("gh", args, input === undefined ? undefined : { input }),
    (r) => ({ url: r.stdout.match(GH_URL)?.[0] }),
    (r) => (r.code === 0 ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
}

/** Asks a contributor on their PR (fix-up, conflict or CI fix where the branch is closed to us); `action` is the audit action of the caller's stage. */
export function ghAskComment(w: Writer, exec: Exec, action: string, g: Guarded, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  return ghComment(w, g, exec, action, { repo: g.repo, number: g.number, pr: true }, note, text, details);
}

/** `action` is the audit action of the caller's stage (act, fixup or fixissue comment). Not for asks: those use ghAskComment. */
export function ghComment(w: Writer, g: Grant, exec: Exec, action: string, o: { repo: string; number: number; pr: boolean }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const body = withNote(note, text);
  return viaGh(w, exec, action, refOf(o.repo, o.number), { ...details, text: body },
    [o.pr ? "pr" : "issue", "comment", String(o.number), "--repo", `${ORG}/${o.repo}`, "--body-file", "-"], body);
}

/** Replaces the body of a comment we posted (`commentId` is the number in its `#issuecomment-` URL). */
export function ghEditComment(w: Writer, g: Grant, exec: Exec, action: string, o: { repo: string; number: number; commentId: string }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const body = withNote(note, text);
  return viaGh(w, exec, action, refOf(o.repo, o.number), { ...details, text: body, comment: o.commentId },
    ["api", "-X", "PATCH", `repos/${ORG}/${o.repo}/issues/comments/${o.commentId}`, "-F", "body=@-"], body);
}

export function ghOpenPr(w: Writer, g: Grant, exec: Exec, action: string, o: { repo: string; target: string; base: string; head: string; title: string; body: string }, note: Note, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  const body = withNote(note, o.body);
  return viaGh(w, exec, action, o.target, { ...details, text: body },
    ["pr", "create", "--repo", `${ORG}/${o.repo}`, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], body);
}

export function ghClosePr(w: Writer, g: Grant, exec: Exec, o: { repo: string; number: number }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const comment = withNote(note, text);
  return viaGh(w, exec, "batch-pr-close", refOf(o.repo, o.number), { ...details, text: comment },
    ["pr", "close", String(o.number), "--repo", `${ORG}/${o.repo}`, "--comment", comment]);
}

/** Creates the pipeline account's fork of `repo` when it has none. */
export function ghFork(w: Writer, g: GuardedRepo, exec: Exec, repo: string, details: Details = {}): Promise<ExecResult> {
  covers(g, repo);
  return viaGh(w, exec, "fork-create", repo, details, ["repo", "fork", `${ORG}/${repo}`, "--clone=false"]);
}

/** `clear`: GitHub refused the request, so no issue can exist. Otherwise the outcome is unknown (a timeout, a lost response, a success without a URL). */
export class IssueError extends Error {
  clear: boolean;
  constructor(message: string, clear: boolean) { super(message); this.clear = clear; }
}

// gh's own wording when GitHub rejects the request before creating anything.
const REFUSED = /issues are disabled|has disabled issues|could not resolve to a repository|not found|forbidden|must have (?:admin|write|push)|permission|requires authentication|bad credentials|gh auth login|HTTP (?:401|403|404|410|422)|validation failed/i;

/**
 * Opens an issue; returns its number and URL. Throws an IssueError when `gh` fails or prints no issue URL; `clear` tells
 * whether the failure certainly left no issue behind. `target` is the item the issue follows up.
 */
export async function createIssue(w: Writer, g: Grant, exec: Exec, o: { repo: string; target: string; title: string; body: string }, note: Note, details: Details = {}): Promise<{ number: number; url: string }> {
  covers(g, o.repo);
  const body = withNote(note, o.body);
  let r: ExecResult;
  try {
    r = await viaGh(w, exec, "postmerge-file", o.target, { ...details, title: o.title, text: body },
      ["issue", "create", "--repo", `${ORG}/${o.repo}`, "--title", o.title, "--body-file", "-"], body);
  } catch (e) {
    // exec rejects only when the command could not be started.
    throw new IssueError(oneLine(String((e as Error).message ?? e)), true);
  }
  const url = r.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/);
  if (r.code !== 0) { const m = oneLine(r.stderr || r.stdout) || `exit code ${r.code}`; throw new IssueError(m, REFUSED.test(m)); }
  if (!url) throw new IssueError(oneLine(r.stderr || r.stdout) || "gh printed no issue URL", false);
  return { number: Number(url[1]), url: url[0] };
}

/** Approves one Actions run that waits for a maintainer's approval (a run from an outside contributor's PR). */
export function ghApproveRun(w: Writer, exec: Exec, g: Guarded, runId: number, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "ci-run-approve", refOf(g.repo, g.number), { ...details, run: runId },
    ["api", "-X", "POST", `repos/${ORG}/${g.repo}/actions/runs/${runId}/approve`]);
}

/** Reruns the failed jobs of one Actions run of a PR's head commit. */
export function ghRerunFailed(w: Writer, exec: Exec, g: Guarded, runId: number, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "ci-rerun", refOf(g.repo, g.number), { ...details, run: runId },
    ["run", "rerun", String(runId), "--failed", "--repo", `${ORG}/${g.repo}`]);
}

/** Reruns the failed jobs of one Actions run on a default-branch head. It belongs to no item: the audit target names the repo and the commit. */
export function ghRerunMainFailed(w: Writer, g: GuardedRepo, exec: Exec, o: { repo: string; head: string; runId: number }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, exec, "ci-rerun", `${o.repo}:${o.head.slice(0, 8)}`, { ...details, run: o.runId },
    ["run", "rerun", String(o.runId), "--failed", "--repo", `${ORG}/${o.repo}`]);
}

// ---- git pushes ---------------------------------------------------------------

/** Pushes `sha` to a PR's branch `branch` of `remote` (owner/name); refused by git when the branch is no longer at the guarded head. */
export function pushBranch(w: Writer, git: Pick<Git, "git">, action: string, g: Guarded, o: { remote: string; branch: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  return pushed(w, git, action, refOf(g.repo, g.number), o, `--force-with-lease=refs/heads/${o.branch}:${g.head}`, details);
}

/** Pushes `sha` to `branch` of the pipeline's own fork, replacing the branch. */
export function pushOwnBranch(w: Writer, g: Grant, git: Pick<Git, "git">, action: string, o: { repo: string; number?: number; remote: string; branch: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  return pushed(w, git, action, o.number === undefined ? `${o.repo}:${o.branch}` : refOf(o.repo, o.number), o, "--force", details);
}

function pushed(w: Writer, git: Pick<Git, "git">, action: string, target: string, o: { remote: string; branch: string; sha: string }, lease: string, details: Details): Promise<ExecResult> {
  return recorded(w, action, target, { ...details, branch: o.branch, remote: o.remote, commit: o.sha },
    () => git.git(["push", "--quiet", lease, `https://github.com/${o.remote}.git`, `${o.sha}:refs/heads/${o.branch}`]),
    undefined,
    (r) => (r.code === 0 ? null : oneLine(r.stderr) || `exit code ${r.code}`));
}

// ---- merges ---------------------------------------------------------------------

export type CommandResult = { code: number; stdout: string; stderr: string };

/** Set on the child that `mergeViaCommand` starts, so the child does not record the same merge again. */
export const MERGE_RECORDED_ENV = "AUTOCRAFT_MERGE_RECORDED";

/**
 * Runs the merge command for the guarded PR and records the merge or the refusal. The command gets
 * `OWNER/REPO PR --squash|--merge <extra> [--head <guarded head>]`; with `pin` (the built-in safe-merge) it refuses when GitHub's head
 * differs from the head the guard checked. An external command does not understand `--head` and pins its own read.
 */
export async function mergeViaCommand(w: Writer, run: (cmd: string, args: string[]) => Promise<CommandResult>, cmd: string, g: Guarded, o: { method: "squash" | "merge"; extra?: string[]; pin: boolean }, details: Details = {}, landed?: () => Promise<boolean>): Promise<CommandResult> {
  const args = [`${ORG}/${g.repo}`, String(g.number), `--${o.method}`, ...(o.extra ?? []), ...(o.pin ? ["--head", g.head] : [])];
  const repo = g.repo;
  const method: string = o.method;
  const base = { ...details, method };
  const target = refOf(repo, g.number);
  const id = begin(w, "merge", target, base);
  let r: CommandResult;
  try {
    r = await run(cmd, args);
  } catch (e) {
    finish(w, id, base, oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  if (r.code === 0) {
    finish(w, id, { ...base, commit: r.stdout.match(/\bMERGED ([0-9a-f]{7,40})\b/)?.[1] });
    return r;
  }
  // The command can fail after GitHub merged (the check afterwards), so the caller may confirm the merge landed.
  if (await landed?.().catch(() => false)) finish(w, id, { ...base, note: "landed after the command reported an error" });
  else finish(w, id, base, oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
  return r;
}

/**
 * The merge itself: `gh pr merge` pinned to `head`. `record` starts the activity row and returns the function that
 * finishes it; it is absent when a parent process already records the merge.
 */
export async function ghMergePr(gh: (args: string[]) => Promise<string>, repo: string, pr: string, method: "--squash" | "--merge", head: string, record?: () => (error?: string) => void): Promise<void> {
  const end = record?.();
  try {
    await gh(["pr", "merge", pr, "-R", repo, method, "--match-head-commit", head]);
  } catch (e) {
    end?.(oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  end?.();
}

/** Records a merge made from the command line, in the database `connect()` opens, under the login `cli`. */
export function cliMergeRecorder(repoSlug: string, pr: string, method: string, head: string): () => (error?: string) => void {
  return () => {
    const w: Writer = { db: connect(), login: "cli" };
    const details = { method: method.slice(2), head };
    const id = begin(w, "merge", `${repoName(repoSlug)}#${Number(pr)}`, details);
    return (error) => {
      try {
        finish(w, id, details, error);
      } finally {
        w.db.close();
      }
    };
  };
}
