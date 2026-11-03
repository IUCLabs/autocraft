// The only module that writes to GitHub. Every function performs the write
// and records it in the audit table itself, failed attempts included, so a
// caller cannot write without leaving a record. test/github-writes.test.ts
// fails when any other file in src/ sends a mutation, pushes, merges or
// otherwise writes. Transports (querier, exec, git, merge command) stay
// injected so tests fake them and assert the rows.
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import type { Exec, ExecResult, Git } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";

export { GITHUB_ACTIONS } from "./actions.ts";

/** Who writes (the audit login: the stage name, or the operator for manual actions) and where the row goes. */
export type Writer = { db: DatabaseSync; login: string };
type Details = Record<string, unknown>;
type Retry = <T>(f: () => Promise<T>) => Promise<T>;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const direct: Retry = (f) => f();
const refOf = (repo: string, number: number): string => `${repo}#${number}`;

function row(w: Writer, action: string, target: string, details: Details, error?: string): void {
  audit(w.db, w.login, action, target, error === undefined ? details : { ...details, error });
}

/** Runs the write, records one row with `view`'s extra details on success or the error on failure, and returns the result. */
async function recorded<T>(w: Writer, action: string, target: string, details: Details, f: () => Promise<T>, view?: (r: T) => Details, failure?: (r: T) => string | null): Promise<T> {
  let r: T;
  try {
    r = await f();
  } catch (e) {
    row(w, action, target, details, oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  const bad = failure?.(r) ?? null;
  if (bad !== null) row(w, action, target, details, bad);
  else row(w, action, target, { ...details, ...view?.(r) });
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
export async function commentOn(w: Writer, q: Querier, action: string, item: ItemRef, body: string, details: Details = {}): Promise<string> {
  const r = await recorded(w, action, refOf(item.repo, item.number), { ...details, text: body },
    () => q.query(ADD_COMMENT, { id: item.id, body }) as Promise<{ addComment?: { commentEdge?: { node?: { url?: string } } } }>,
    (x) => ({ url: x.addComment?.commentEdge?.node?.url ?? undefined }));
  return r.addComment?.commentEdge?.node?.url ?? "";
}

export async function closeItem(w: Writer, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}): Promise<void> {
  await recorded(w, "act-close", refOf(item.repo, item.number), details, () => q.query(item.pr ? CLOSE_PR : CLOSE_ISSUE, { id: item.id }));
}

export async function assignTo(w: Writer, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  await recorded(w, "assign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(ASSIGN, { id: item.id, user: user.id }));
}

export async function unassignFrom(w: Writer, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  await recorded(w, "unassign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(UNASSIGN, { id: item.id, user: user.id }));
}

/** Posts a review as a plain comment review on the commit; returns the review id (null when GitHub returned none). */
export async function postReview(w: Writer, q: Querier, item: ItemRef, head: string, body: string, details: Details = {}): Promise<string | null> {
  const r = await recorded(w, "review-post", refOf(item.repo, item.number), { ...details, head },
    () => q.query(ADD_REVIEW, { pr: item.id, oid: head, body }) as Promise<{ addPullRequestReview?: { pullRequestReview?: { id?: string } | null } | null }>,
    (x) => ({ review: x.addPullRequestReview?.pullRequestReview?.id ?? undefined }),
    (x) => (x.addPullRequestReview?.pullRequestReview?.id ? null : "GitHub returned no review"));
  return r.addPullRequestReview?.pullRequestReview?.id ?? null;
}

export async function editReview(w: Writer, q: Querier, repo: string, number: number, reviewId: string, head: string, body: string, details: Details = {}): Promise<void> {
  await recorded(w, "review-edit", refOf(repo, number), { ...details, head, review: reviewId }, () => q.query(EDIT_REVIEW, { id: reviewId, body }));
}

export async function createLabel(w: Writer, q: Querier, repo: string, repoId: string, label: { name: string; color: string; description: string }, retry: Retry = direct, details: Details = {}): Promise<void> {
  await recorded(w, "label-create", repo, { ...details, name: label.name }, () => retry(() => q.query(CREATE_LABEL, { input: { repositoryId: repoId, ...label } })));
}

export type LabelWrite = { number: number; id: string; labelIds: string[]; names: string[] };

/** Adds labels to several items in one request. One row per item: labelled with the names, or the failure. Returns the numbers that succeeded. */
export async function addLabels(w: Writer, q: Querier, repo: string, items: LabelWrite[], retry: Retry = direct, details: Details = {}): Promise<number[]> {
  const vars: Record<string, unknown> = {};
  items.forEach((it, k) => { vars[`i${k}`] = it.id; vars[`l${k}`] = it.labelIds; });
  let d: Record<string, unknown> | null;
  try {
    d = await retry(() => q.query(addLabelsMutation(items.length), vars));
  } catch (e) {
    const msg = oneLine(String((e as Error).message ?? e));
    for (const it of items) row(w, "labels-apply", refOf(repo, it.number), { ...details, labels: it.names }, msg);
    throw e;
  }
  const done: number[] = [];
  items.forEach((it, k) => {
    if (d && d[`m${k}`] !== null && d[`m${k}`] !== undefined) {
      done.push(it.number);
      row(w, "labels-apply", refOf(repo, it.number), { ...details, labels: it.names });
    } else row(w, "labels-apply", refOf(repo, it.number), { ...details, labels: it.names }, "GitHub did not apply the labels");
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

/** `action` is the audit action of the caller's stage (act, fixup or fixissue comment). */
export function ghComment(w: Writer, exec: Exec, action: string, o: { repo: string; number: number; pr: boolean }, body: string, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, action, refOf(o.repo, o.number), { ...details, text: body },
    [o.pr ? "pr" : "issue", "comment", String(o.number), "--repo", `${ORG}/${o.repo}`, "--body-file", "-"], body);
}

export function ghOpenPr(w: Writer, exec: Exec, action: string, o: { repo: string; target: string; base: string; head: string; title: string; body: string }, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, action, o.target, details,
    ["pr", "create", "--repo", `${ORG}/${o.repo}`, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], o.body);
}

export function ghClosePr(w: Writer, exec: Exec, o: { repo: string; number: number }, comment: string, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "batch-pr-close", refOf(o.repo, o.number), { ...details, text: comment },
    ["pr", "close", String(o.number), "--repo", `${ORG}/${o.repo}`, "--comment", comment]);
}

/** Creates the pipeline account's fork of `repo` when it has none. */
export function ghFork(w: Writer, exec: Exec, repo: string, details: Details = {}): Promise<ExecResult> {
  return viaGh(w, exec, "fork-create", repo, details, ["repo", "fork", `${ORG}/${repo}`, "--clone=false"]);
}

// ---- git pushes ---------------------------------------------------------------

/**
 * Pushes `sha` to `branch` of `remote` (owner/name). With `expected` the push is refused when the branch moved
 * (a contributor's branch); without it the branch is replaced (the pipeline's own fork).
 */
export function pushBranch(w: Writer, git: Pick<Git, "git">, action: string, o: { repo: string; number?: number; remote: string; branch: string; sha: string; expected?: string }, details: Details = {}): Promise<ExecResult> {
  const lease = o.expected === undefined ? "--force" : `--force-with-lease=refs/heads/${o.branch}:${o.expected}`;
  const target = o.number === undefined ? `${o.repo}:${o.branch}` : refOf(o.repo, o.number);
  return recorded(w, action, target, { ...details, branch: o.branch, remote: o.remote, commit: o.sha },
    () => git.git(["push", "--quiet", lease, `https://github.com/${o.remote}.git`, `${o.sha}:refs/heads/${o.branch}`]),
    undefined,
    (r) => (r.code === 0 ? null : oneLine(r.stderr) || `exit code ${r.code}`));
}

// ---- merges ---------------------------------------------------------------------

export type CommandResult = { code: number; stdout: string; stderr: string };

/** Set on the child that `mergeViaCommand` starts, so the child does not record the same merge again. */
export const MERGE_RECORDED_ENV = "CRAFT_AUTO_MERGE_RECORDED";

/** Runs the merge command (`args` = OWNER/REPO PR --squash|--merge ...) and records the merge or the refusal. */
export async function mergeViaCommand(w: Writer, run: (cmd: string, args: string[]) => Promise<CommandResult>, cmd: string, args: string[], details: Details = {}): Promise<CommandResult> {
  const [slug = "", pr = ""] = args;
  const repo = slug.split("/").pop() ?? slug;
  const method = args.find((a) => a === "--squash" || a === "--merge")?.slice(2);
  return recorded(w, "merge", refOf(repo, Number(pr)), { ...details, method },
    () => run(cmd, args),
    (r) => ({ commit: r.stdout.match(/\bMERGED ([0-9a-f]{7,40})\b/)?.[1] }),
    (r) => (r.code === 0 ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
}

/**
 * The merge itself: `gh pr merge` pinned to `head`. `record` receives the outcome for the built-in command
 * line; it is absent when a parent process already records the merge.
 */
export async function ghMergePr(gh: (args: string[]) => Promise<string>, repo: string, pr: string, method: "--squash" | "--merge", head: string, record?: (error?: string) => void): Promise<void> {
  try {
    await gh(["pr", "merge", pr, "-R", repo, method, "--match-head-commit", head]);
  } catch (e) {
    record?.(oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  record?.();
}

/** Records a merge made from the command line, in the database `connect()` opens, under the login `cli`. */
export function cliMergeRecorder(repoSlug: string, pr: string, method: string, head: string): (error?: string) => void {
  return (error) => {
    const db = connect();
    try {
      row({ db, login: "cli" }, "merge", refOf(repoSlug.split("/").pop() ?? repoSlug, Number(pr)), { method: method.slice(2), head }, error);
    } finally {
      db.close();
    }
  };
}
