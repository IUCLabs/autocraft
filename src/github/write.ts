// The only module that writes to GitHub. Every function performs the write
// and records it in the audit table itself, failed attempts included, so a
// caller cannot write without leaving a record. Writes to a pull request take a
// `Guarded` value that only core/guard.ts makes, so the compiler enforces that the
// guard ran right before. Transports (querier, exec, git, merge command) stay
// injected so tests fake them and assert the rows.
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../db.ts";
import { recordPush } from "../push-outcomes.ts";
import type { Grant, Guarded, GuardedItem, GuardedRepo } from "../core/guard.ts";

/** The PR steps that push to a contributor's branch or ask on the PR where it is closed to us (`lint`: the collect step of a stored patch). */
export type AskKind = "fixup" | "conflict" | "cifix" | "lint";
/** What a comment write takes: a PR step's grant for its own kinds, or an item or repo grant (never a merge or CI grant). */
export type CommentGrant = Guarded<AskKind> | GuardedItem | GuardedRepo;
import type { Exec, ExecResult, Git } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";
import { type Note, withNote } from "./note.ts";
import { slugOf, splitSlug } from "../owners.ts";
import { giveaway } from "../security/rules.ts";

export { GITHUB_ACTIONS } from "./actions.ts";
export type { Note } from "./note.ts";

/** Who writes (the audit login: the stage name, or the operator for manual actions) and where the row goes. */
export type Writer = { db: DatabaseSync; login: string };
type Details = Record<string, unknown>;
type Retry = <T>(f: () => Promise<T>) => Promise<T>;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const direct: Retry = (f) => f();
/** The bare repo name of a `owner/repo` slug, as audit targets and items name it. */
const repoName = (slug: string): string => splitSlug(slug).name;
const refOf = (repo: string, number: number): string => `${repo}#${number}`;

/** A grant covers writes to its own repo (and, for a PR or item grant, its own number); a write elsewhere is a bug. */
function covers(g: Guarded | Grant, repo: string, number?: number): void {
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
const CLOSE_ISSUE_AS = `mutation($id: ID!, $reason: IssueClosedStateReason!) { closeIssue(input: { issueId: $id, stateReason: $reason }) { clientMutationId } }`;
const CLOSE_PR = `mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;
const ASSIGN = `mutation($id: ID!, $user: ID!) {
  addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const UNASSIGN = `mutation($id: ID!, $user: ID!) {
  removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const REOPEN_ISSUE = `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { clientMutationId } }`;
const REOPEN_PR = `mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;
const REMOVE_LABEL = `mutation($id: ID!, $label: ID!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId } }`;
const TRANSFER_ISSUE = `mutation($id: ID!, $repo: ID!) { transferIssue(input: { issueId: $id, repositoryId: $repo }) { issue { url number } } }`;
const REQUEST_REVIEWS = `mutation($id: ID!, $users: [ID!]!) {
  requestReviews(input: { pullRequestId: $id, userIds: $users, union: true }) { clientMutationId }
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

export async function closeItem(w: Writer, g: Grant, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}, reason?: "COMPLETED" | "NOT_PLANNED"): Promise<void> {
  covers(g, item.repo, item.number);
  // GitHub has a state reason for issues only.
  await recorded(w, "act-close", refOf(item.repo, item.number), reason && !item.pr ? { ...details, reason } : details,
    () => (item.pr ? q.query(CLOSE_PR, { id: item.id }) : reason ? q.query(CLOSE_ISSUE_AS, { id: item.id, reason }) : q.query(CLOSE_ISSUE, { id: item.id })));
}

export async function assignTo(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "assign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(ASSIGN, { id: item.id, user: user.id }));
}

export async function unassignFrom(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "unassign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(UNASSIGN, { id: item.id, user: user.id }));
}

export async function reopenItem(w: Writer, g: Grant, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "act-reopen", refOf(item.repo, item.number), details, () => q.query(item.pr ? REOPEN_PR : REOPEN_ISSUE, { id: item.id }));
}

export async function removeLabel(w: Writer, g: Grant, q: Querier, item: ItemRef, label: { id: string; name: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "act-unlabel", refOf(item.repo, item.number), { ...details, label: label.name }, () => q.query(REMOVE_LABEL, { id: item.id, label: label.id }));
}

/** Moves an issue to another repository of the organisation (`to.id` is its node id). The grant `gTo` must cover the target repo; returns the issue's new URL. */
export async function transferIssue(w: Writer, g: Grant, gTo: Grant, q: Querier, item: ItemRef, to: { repo: string; id: string }, details: Details = {}): Promise<string> {
  covers(g, item.repo, item.number);
  covers(gTo, to.repo);
  const r = await recorded(w, "act-transfer", refOf(item.repo, item.number), { ...details, to: to.repo },
    () => q.query(TRANSFER_ISSUE, { id: item.id, repo: to.id }) as Promise<{ transferIssue?: { issue?: { url?: string } } }>,
    (x) => ({ url: x.transferIssue?.issue?.url ?? undefined }));
  return r.transferIssue?.issue?.url ?? "";
}

/** Requests reviews from users (added to the reviewers already requested). */
export async function requestReviewers(w: Writer, g: Grant, q: Querier, item: ItemRef, users: { id: string; login: string }[], details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  await recorded(w, "act-request-reviewers", refOf(item.repo, item.number), { ...details, reviewers: users.map((u) => u.login) },
    () => q.query(REQUEST_REVIEWS, { id: item.id, users: users.map((u) => u.id) }));
}

/** Posts a review as a plain comment review on the commit; returns the review id (null when GitHub returned none). */
export async function postReview(w: Writer, q: Querier, g: Guarded<"post-review">, nodeId: string, note: Note, text: string, details: Details = {}): Promise<string | null> {
  const body = withNote(note, text);
  const r = await recorded(w, "review-post", refOf(g.repo, g.number), { ...details, head: g.head },
    () => q.query(ADD_REVIEW, { pr: nodeId, oid: g.head, body }) as Promise<{ addPullRequestReview?: { pullRequestReview?: { id?: string } | null } | null }>,
    (x) => ({ review: x.addPullRequestReview?.pullRequestReview?.id ?? undefined }),
    (x) => (x.addPullRequestReview?.pullRequestReview?.id ? null : "GitHub returned no review"));
  return r.addPullRequestReview?.pullRequestReview?.id ?? null;
}

export async function editReview(w: Writer, q: Querier, g: Guarded<"post-review">, reviewId: string, note: Note, text: string, details: Details = {}): Promise<void> {
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
export function ghAskComment(w: Writer, exec: Exec, action: string, g: Guarded<AskKind>, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  return ghComment(w, g, exec, action, { repo: g.repo, number: g.number, pr: true }, note, text, details);
}

/** `action` is the audit action of the caller's stage (act, fixup or fixissue comment). Not for asks: those use ghAskComment. */
export function ghComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; pr: boolean }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const body = withNote(note, text);
  return viaGh(w, exec, action, refOf(o.repo, o.number), { ...details, text: body },
    [o.pr ? "pr" : "issue", "comment", String(o.number), "--repo", `${slugOf(o.repo)}`, "--body-file", "-"], body);
}

/** Replaces the body of a comment we posted (`commentId` is the number in its `#issuecomment-` URL). */
export function ghEditComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; commentId: string }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const body = withNote(note, text);
  return viaGh(w, exec, action, refOf(o.repo, o.number), { ...details, text: body, comment: o.commentId },
    ["api", "-X", "PATCH", `repos/${slugOf(o.repo)}/issues/comments/${o.commentId}`, "-F", "body=@-"], body);
}

/**
 * Deletes a comment of ours (`commentId` is the number in its `#issuecomment-` URL). The comment's author must be `login`;
 * a comment that is already gone counts as done (the audit row carries `gone: true`).
 */
export function ghDeleteComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; commentId: string; login: string }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const path = `repos/${slugOf(o.repo)}/issues/comments/${o.commentId}`;
  const gone = (r: ExecResult): boolean => r.code !== 0 && /404|not found/i.test(`${r.stderr} ${r.stdout}`);
  const goneResult: ExecResult = { code: 0, stdout: "gone", stderr: "" };
  return recorded(w, action, refOf(o.repo, o.number), { ...details, comment: o.commentId },
    async () => {
      const author = await exec("gh", ["api", path, "--jq", ".user.login"]);
      if (gone(author)) return goneResult;
      if (author.code !== 0) return author;
      if (author.stdout.trim() !== o.login) return { code: 1, stdout: "", stderr: "the comment is not ours" };
      const del = await exec("gh", ["api", "-X", "DELETE", path]);
      return gone(del) ? goneResult : del;
    },
    (r) => (r.stdout === "gone" ? { gone: true } : {}),
    (r) => (r.code === 0 ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
}

export function ghOpenPr(w: Writer, g: Grant, exec: Exec, action: string, o: { repo: string; target: string; base: string; head: string; title: string; body: string }, note: Note, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  const body = withNote(note, o.body);
  return viaGh(w, exec, action, o.target, { ...details, text: body },
    ["pr", "create", "--repo", `${slugOf(o.repo)}`, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], body);
}

export function ghClosePr(w: Writer, g: Grant, exec: Exec, o: { repo: string; number: number }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  const comment = withNote(note, text);
  return viaGh(w, exec, "batch-pr-close", refOf(o.repo, o.number), { ...details, text: comment },
    ["pr", "close", String(o.number), "--repo", `${slugOf(o.repo)}`, "--comment", comment]);
}

/** Creates the pipeline account's fork of `repo` when it has none. */
export function ghFork(w: Writer, g: GuardedRepo, exec: Exec, repo: string, details: Details = {}): Promise<ExecResult> {
  covers(g, repo);
  return viaGh(w, exec, "fork-create", repo, details, ["repo", "fork", `${slugOf(repo)}`, "--clone=false"]);
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
export async function createIssue(w: Writer, g: Grant, exec: Exec, o: { repo: string; target: string; title: string; body: string; /** The audit action; the post-merge step's by default. */ action?: string }, note: Note, details: Details = {}): Promise<{ number: number; url: string }> {
  covers(g, o.repo);
  const body = withNote(note, o.body);
  let r: ExecResult;
  try {
    r = await viaGh(w, exec, o.action ?? "postmerge-file", o.target, { ...details, title: o.title, text: body },
      ["issue", "create", "--repo", `${slugOf(o.repo)}`, "--title", o.title, "--body-file", "-"], body);
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
export function ghApproveRun(w: Writer, exec: Exec, g: Guarded<"approve-ci">, runId: number, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "ci-run-approve", refOf(g.repo, g.number), { ...details, run: runId },
    ["api", "-X", "POST", `repos/${slugOf(g.repo)}/actions/runs/${runId}/approve`]);
}

/** Reruns the failed jobs of one Actions run of a PR's head commit. */
export function ghRerunFailed(w: Writer, exec: Exec, g: Guarded<"cifix">, runId: number, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "ci-rerun", refOf(g.repo, g.number), { ...details, run: runId },
    ["run", "rerun", String(runId), "--failed", "--repo", `${slugOf(g.repo)}`]);
}

/** Reruns the failed jobs of one Actions run on a default-branch head. It belongs to no item: the audit target names the repo and the commit. */
export function ghRerunMainFailed(w: Writer, g: GuardedRepo, exec: Exec, o: { repo: string; head: string; runId: number }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, exec, "ci-rerun", `${o.repo}:${o.head.slice(0, 8)}`, { ...details, run: o.runId },
    ["run", "rerun", String(o.runId), "--failed", "--repo", `${slugOf(o.repo)}`]);
}

// ---- git pushes ---------------------------------------------------------------

/** Pushes `sha` to a PR's branch `branch` of `remote` (owner/name); refused by git when the branch is no longer at the guarded head. */
export function pushBranch(w: Writer, git: Pick<Git, "git">, action: string, g: Guarded<AskKind>, o: { remote: string; branch: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  const b = g.action.bucket;
  if ((g.action.kind === "fixup" && b === "ask") || (g.action.kind === "cifix" && b === "rerun")) throw new Error(`a ${g.action.kind}:${b} grant does not allow a push`);
  return pushed(w, git, action, refOf(g.repo, g.number), o, `--force-with-lease=refs/heads/${o.branch}:${g.head}`, details, { repo: g.repo, number: g.number });
}

/** Pushes `sha` to `branch` of the pipeline's own fork, replacing the branch. */
export function pushOwnBranch(w: Writer, g: Grant, git: Pick<Git, "git">, action: string, o: { repo: string; number?: number; remote: string; branch: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  // A new branch has no PR yet: its outcome is matched to the PR by commit once the PR's checks arrive.
  return pushed(w, git, action, o.number === undefined ? `${o.repo}:${o.branch}` : refOf(o.repo, o.number), o, "--force", details, { repo: o.repo, number: null });
}

async function pushed(w: Writer, git: Pick<Git, "git">, action: string, target: string, o: { remote: string; branch: string; sha: string }, lease: string, details: Details, pr: { repo: string; number: number | null }): Promise<ExecResult> {
  const r = await recorded(w, action, target, { ...details, branch: o.branch, remote: o.remote, commit: o.sha },
    () => git.git(["push", "--quiet", lease, `https://github.com/${o.remote}.git`, `${o.sha}:refs/heads/${o.branch}`]),
    undefined,
    (r) => (r.code === 0 ? null : oneLine(r.stderr) || `exit code ${r.code}`));
  if (r.code === 0) {
    // The push stands even when its bookkeeping cannot be written; the outcome stays unknown then.
    try { recordPush(w.db, action, { ...pr, from: typeof details.from === "string" ? details.from : null, to: o.sha, base: typeof details.base === "string" ? details.base : null }); } catch (e) { console.error(`push outcome not recorded: ${oneLine(String((e as Error).message ?? e))}`); }
  }
  return r;
}

// ---- security fixes ------------------------------------------------------------
// Rows of these actions are not in GITHUB_ACTIONS: no feed, activity page or live topic shows them to viewers.

/** What a quiet pull request may say: refuses any text that names the problem. Checked here, so no caller can skip it. */
function assertQuiet(...texts: string[]): void {
  for (const t of texts) {
    const w = giveaway(t);
    if (w) throw new Error(`a landing write may not mention "${w}"`);
  }
}

/** The HTTP status in gh's error text, or null. */
export const httpStatus = (r: ExecResult): number | null => {
  const m = /HTTP (\d{3})/.exec(`${r.stderr} ${r.stdout}`);
  return m ? Number(m[1]) : /not found/i.test(`${r.stderr} ${r.stdout}`) ? 404 : null;
};

/** Pushes the fix commit to the pipeline's fork under a neutral branch name: the quiet landing's push. */
export function ghLandPush(w: Writer, g: Grant, git: Pick<Git, "git">, o: { repo: string; fork: string; branch: string; sha: string; base: string; key: string }): Promise<ExecResult> {
  assertQuiet(o.branch);
  return pushOwnBranch(w, g, git, "security-land-push", { repo: o.repo, remote: o.fork, branch: o.branch, sha: o.sha }, { base: o.base, finding: o.key });
}

/** Opens the quiet pull request: plain title and body, neutral branch. */
export function ghLandPr(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; base: string; head: string; title: string; body: string }, note: Note): Promise<ExecResult> {
  assertQuiet(o.head, o.title, o.body);
  return ghOpenPr(w, g, exec, "security-land", { repo: o.repo, target: o.key, base: o.base, head: o.head, title: o.title, body: o.body }, note, {});
}

const json = (v: unknown): string => JSON.stringify(v);

/** Creates the repository's draft advisory (private to admins and security managers). The text is not kept in the audit row. */
export async function ghAdvisoryCreate(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; summary: string; description: string; severity: "critical" | "high" | "medium" | "low" }): Promise<{ ghsa: string | null; result: ExecResult }> {
  covers(g, o.repo);
  const body = json({ summary: o.summary, description: o.description, severity: o.severity, vulnerabilities: [{ package: { ecosystem: "other", name: o.repo }, vulnerable_version_range: null, patched_versions: null }] });
  let ghsa: string | null = null;
  const result = await recorded(w, "security-advisory", o.key, { repo: o.repo },
    () => exec("gh", ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories`, "--input", "-", "--jq", ".ghsa_id"], { input: body }),
    (r) => { ghsa = r.stdout.trim() || null; return { ghsa: ghsa ?? undefined }; },
    (r) => (r.code === 0 && r.stdout.trim() ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
  return { ghsa, result };
}

/** Creates the advisory's temporary private fork; returns its owner/name. */
export async function ghAdvisoryFork(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<{ fork: string | null; result: ExecResult }> {
  covers(g, o.repo);
  let fork: string | null = null;
  const result = await recorded(w, "security-advisory-fork", o.key, { repo: o.repo, ghsa: o.ghsa },
    () => exec("gh", ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}/forks`, "--jq", ".full_name"]),
    (r) => { fork = r.stdout.trim() || null; return { fork: fork ?? undefined }; },
    (r) => (r.code === 0 && r.stdout.trim() ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
  return { fork, result };
}

/** Pushes the fix to the advisory's private fork with the box user's token: the GitHub App cannot reach these forks. */
export function ghAdvisoryPush(w: Writer, g: Grant, git: Pick<Git, "git">, o: { repo: string; fork: string; branch: string; sha: string; key: string }): Promise<ExecResult> {
  return pushOwnBranch(w, g, git, "security-advisory-push", { repo: o.repo, remote: o.fork, branch: o.branch, sha: o.sha }, { finding: o.key });
}

/** Opens the fix pull request inside the private fork. */
export function ghAdvisoryPr(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; fork: string; base: string; head: string; title: string; body: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, exec, "security-advisory-pr", o.key, { repo: o.repo, fork: o.fork },
    ["pr", "create", "--repo", o.fork, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], o.body);
}

/** Publishes the draft advisory; a published advisory deletes its private fork. */
export function ghAdvisoryPublish(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, exec, "security-publish", o.key, { repo: o.repo, ghsa: o.ghsa },
    ["api", "-X", "PATCH", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}`, "--input", "-"], json({ state: "published" }));
}

/** Requests a CVE for the advisory (public repositories only). */
export function ghAdvisoryCve(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, exec, "security-cve", o.key, { repo: o.repo, ghsa: o.ghsa }, ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}/cve`]);
}

// ---- merges ---------------------------------------------------------------------

export type CommandResult = { code: number; stdout: string; stderr: string };

/** Set on the child that `mergeViaCommand` starts, so the child does not record the same merge again. */
export const MERGE_RECORDED_ENV = "AUTOCRAFT_MERGE_RECORDED";

/**
 * Runs the merge command for the guarded PR and records the merge or the refusal. The command gets
 * `OWNER/REPO PR --squash|--merge <extra> --head <guarded head>`, and must refuse when GitHub's head
 * differs from that head. Every merge command, the built-in safe-merge and any `$AUTOCRAFT_MERGE_CMD`, takes `--head` as part of this contract.
 */
export async function mergeViaCommand(w: Writer, run: (cmd: string, args: string[]) => Promise<CommandResult>, cmd: string, g: Guarded<"merge">, o: { method: "squash" | "merge"; extra?: string[] }, details: Details = {}, landed?: () => Promise<boolean>): Promise<CommandResult> {
  const args = [`${slugOf(g.repo)}`, String(g.number), `--${o.method}`, ...(o.extra ?? []), "--head", g.head];
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
