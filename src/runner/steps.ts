// The pipeline steps the runner can run. Each step is a declaration: who may
// request it, a params schema, a concurrency group and the function that runs
// it. Adding a step means adding one entry to STEPS (and the module its `run`
// imports); the dashboard, the API, the autopilot and the runner pick it up from here.
//
// Params are only enums, tracked repo names, bounded integers and run ids:
// nothing a person types can reach a model's prompt or a shell.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { DECIDE_MODELS } from "../decide/index.ts";

type Base = { name: string; label: string; help?: string; required?: boolean };
export type ParamDef =
  | (Base & { kind: "enum"; options: string[]; default?: string })
  | (Base & { kind: "repo" })                                        // a tracked repo
  | (Base & { kind: "int"; min: number; max: number; default?: number })
  | (Base & { kind: "run-id"; default?: string });                   // RUN_ID below

export type Params = Record<string, string | number>;

export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type StepContext = {
  db: DatabaseSync;
  job: { id: number; requestedBy: string; startedAt: string };
  params: Params;
  /** One line shown on the dashboard while the job runs. */
  progress(text: string): void;
  /** A line in the job's log. Logs are shown to everyone signed in: no secrets. */
  log(line: string): void;
  /** Model calls recorded in token_usage under this run id (from the job's start) count as the job's usage. */
  usageRun(runId: string): void;
  /** Items this job has handled so far (units attempted, such as items sent to a model), counted against the stage's daily limit. Pass the running total as work goes: it is saved at once, so a failed or stopped job keeps its count. */
  handled(n: number): void;
  /** Set when a cancel was requested; long loops should stop between units of work. */
  cancelled(): boolean;
};

export type StepDef = {
  name: string;
  title: string;
  /** One or two plain sentences for the Pipeline page. */
  description: string;
  /** Stage number in docs/pipeline.md. */
  stage: number;
  /** Who may start or cancel it. Anything that writes to GitHub or spends model quota is operator-only. */
  requires: "operator";
  /** At most one job of a group runs at a time; jobs of different groups run together. */
  group: "classify" | "decide" | "review" | "github-write" | "github-read" | "local" | (string & {});
  params: ParamDef[];
  /** Models the step calls, known before any call is made: a list, or derived from the params. Empty or absent for steps that call none. */
  models?: string[] | ((params: Params) => string[]);
  /** null when the step can run; otherwise why not, shown on the page. */
  available?: () => string | null;
  /** Checks a request beyond the schema (null = fine), at request time and again before the run. */
  check?: (db: DatabaseSync, params: Params) => Promise<string | null> | string | null;
  /** Runs the step in the job's child process and returns a one-line summary. */
  run: (ctx: StepContext) => Promise<string>;
};

/** Labelling writes to GitHub only for repos an operator approved on the Repos page. */
async function checkApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { approvalOf } = await import("../labels/approval.ts");
  return approvalOf(db, String(p.repo)) ? null : `labelling ${p.repo} is not approved`;
}

export function modelsOf(step: StepDef | undefined, params: Params): string[] {
  const m = step?.models;
  return typeof m === "function" ? m(params) : (m ?? []);
}

/** Models served through a Claude account (everything but Jev, which has none). */
export const usesClaude = (models: string[]): boolean => models.some((m) => m !== "jev");

/** Merging is opt-in per repo: tracked repos include ones we do not maintain. */
async function checkMergeApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { mergeApprovalOf } = await import("../merge/approval.ts");
  return mergeApprovalOf(db, String(p.repo)) ? null : `merging in ${p.repo} is not approved`;
}

/** Comments and closes are opt-in per repo: tracked repos include ones we do not maintain. */
async function checkCommentApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { commentApprovalOf } = await import("../act/approval.ts");
  return commentApprovalOf(db, String(p.repo)) ? null : `commenting in ${p.repo} is not approved`;
}

/** Pushing to contributors' branches and commenting the fixes are each opt-in per repo; the fix-up step needs either. */
async function checkPushApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { pushApprovalOf } = await import("../fixup/approval.ts");
  const { commentApprovalOf } = await import("../act/approval.ts");
  return pushApprovalOf(db, String(p.repo)) || commentApprovalOf(db, String(p.repo)) ? null : `pushing fix-ups or commenting in ${p.repo} is not approved`;
}

/** Opening fix PRs from issues is opt-in per repo. */
async function checkFixIssueApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { fixIssueApprovalOf } = await import("../fixissue/approval.ts");
  return fixIssueApprovalOf(db, String(p.repo)) ? null : `fixing issues in ${p.repo} is not approved`;
}

export const STEPS: StepDef[] = [
  {
    name: "classify-new",
    title: "Classify new and changed items",
    description: "Jev labels open items that have no verdict in the current classification run, or whose text changed since; Haiku gives a second opinion where Jev is under 90 % sure.",
    stage: 2,
    requires: "operator",
    group: "classify",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, help: "items per model in this job" }],
    run: async (ctx) => (await import("./classify.ts")).classifyNew(ctx),
  },
  {
    name: "classify-all",
    title: "Classification pass",
    description: "Jev labels every open item of the tracked repos into the given run, then Haiku the ones Jev is unsure of. A stopped pass continues where it left off when started again with the same run id; once complete, the run becomes the current one.",
    stage: 2,
    requires: "operator",
    group: "classify",
    models: ["jev", "haiku"],
    params: [
      { name: "run", label: "Run id", kind: "run-id", required: true, help: "lowercase letters, digits and dashes" },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 30000, help: "items per model in this job" },
    ],
    run: async (ctx) => (await import("./classify.ts")).classifyAll(ctx),
  },
  {
    name: "embed",
    title: "Embed items",
    description: "Computes local sentence embeddings of new and changed items for similar items and semantic search. Runs on this machine; no model quota.",
    stage: 1,
    requires: "operator",
    group: "local",
    params: [
      { name: "all", label: "Every item", kind: "enum", options: ["no", "yes"], default: "no", help: "yes embeds all items again, not only new and changed ones" },
      { name: "threads", label: "Threads", kind: "int", min: 1, max: 8, default: 4 },
    ],
    run: async (ctx) => {
      const { embedCommand } = await import("../embed/index.ts");
      ctx.handled(await embedCommand([...(ctx.params.all === "yes" ? ["--all"] : []), "--threads", String(ctx.params.threads)], ctx.handled));
      return ctx.params.all === "yes" ? "embedded every item" : "embedded new and changed items";
    },
  },
  {
    name: "labels-ensure",
    title: "Create the pipeline labels on GitHub",
    description: "Creates the labels of the set that the repo is missing. Refused unless the operator has approved labelling for that repo.",
    stage: 4,
    requires: "operator",
    group: "github-write",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    check: checkApproved,
    run: async (ctx) => {
      const repo = String(ctx.params.repo);
      const refused = await checkApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const { ensureLabels } = await import("../labels/github.ts");
      const { Client } = await import("../mirror.ts");
      const missing = await ensureLabels(new Client(500), repo, true);
      for (const l of missing) ctx.log(`${repo}: created "${l.name}"`);
      return missing.length ? `created ${missing.length} labels on ${repo}` : `${repo}: all labels exist`;
    },
  },
  {
    name: "labels-apply",
    title: "Apply labels on GitHub",
    description: "Puts the settled type label and flags of the current classification run onto the open items of one repo on GitHub. Refused unless the operator has approved labelling for that repo.",
    stage: 4,
    requires: "operator",
    group: "github-write",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, help: "items to label in this job" },
    ],
    check: checkApproved,
    run: async (ctx) => {
      const repo = String(ctx.params.repo);
      const refused = await checkApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const { currentRun } = await import("./classify.ts");
      const runId = currentRun(ctx.db);
      if (!runId) throw new Error("there is no classification run yet");
      const { applyLabels } = await import("../labels/github.ts");
      const { Client } = await import("../mirror.ts");
      const r = await applyLabels(ctx.db, new Client(500), repo, { runId, limit: Number(ctx.params.limit), apply: true, login: ctx.job.requestedBy, log: ctx.log, onLabeled: ctx.handled });
      return `${repo}: labelled ${r.labeled} of ${r.planned} items in ${r.batches} batches, ${r.failed.length} failed`;
    },
  },
  {
    name: "decide",
    title: "Ask decisions",
    description: "Turns items that need a decision, and items where Jev and Haiku disagree between scope labels, into decisions on the dashboard, each with a summary written by the chosen model.",
    stage: 3,
    requires: "operator",
    group: "decide",
    models: (p) => [String(p.model ?? "sonnet")],
    params: [
      { name: "repo", label: "Repo", kind: "repo", help: "every tracked repo when empty" },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 500, default: 50, help: "decisions to ask in this job" },
      { name: "model", label: "Model", kind: "enum", options: [...DECIDE_MODELS], default: "sonnet" },
    ],
    run: async (ctx) => {
      const { runDecide } = await import("../decide/index.ts");
      const r = await runDecide(ctx.db, {
        repos: ctx.params.repo ? [String(ctx.params.repo)] : undefined,
        limit: Number(ctx.params.limit),
        model: String(ctx.params.model),
        onSent: ctx.handled,
      }, ctx.log);
      if (r.usageRun) ctx.usageRun(r.usageRun);
      return `asked ${r.asked} decisions; ${r.noSummary} items without a summary`;
    },
  },
  {
    name: "review-batch",
    title: "Review pull requests",
    description: "Sonnet reviews the pull requests we want from one repo in batches of related PRs: take, take with fixes, hold or close.",
    stage: 5,
    requires: "operator",
    group: "review",
    models: ["sonnet"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "PRs to review in this job" },
    ],
    run: async (ctx) => {
      const { runReview } = await import("../review/index.ts");
      const r = await runReview(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
      ctx.usageRun(r.runId);
      const v = Object.entries(r.verdicts).map(([k, n]) => `${n} ${k}`).join(", ");
      return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates} candidates${v ? ` (${v})` : ""}; ${r.skipped.length} skipped, ${r.missing.length} without an answer`;
    },
  },
  {
    name: "checks",
    title: "Refresh CI and merge state",
    description: "Reads the CI and merge state of every open pull request of one repo from GitHub. Writes nothing to GitHub.",
    stage: 5,
    requires: "operator",
    group: "github-read",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { runChecks } = await import("../review/index.ts");
      const r = await runChecks(ctx.db, { repo: String(ctx.params.repo) }, ctx.log);
      ctx.handled(r.prs);
      return `${ctx.params.repo}: refreshed ${r.prs} open pull requests`;
    },
  },
  {
    name: "merge",
    title: "Merge queued pull requests",
    description: "Lands the pull requests of one repo that may merge in integration batches: up to 10 at a time are merged into one integration branch, checked in the sandbox, opened as one pull request on the storytold repo and merged with merge commits through the safe-merge command once upstream CI is green. A failed batch is split in half; a single failing PR is held. Pull requests in a repo the sandbox cannot build are merged one at a time.",
    stage: 6,
    requires: "operator",
    group: "github-write",
    models: ["haiku"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "pull requests to start or merge in this job" },
    ],
    check: checkMergeApproved,
    run: async (ctx) => {
      const { runMerge } = await import("../merge/index.ts");
      const { runBatches } = await import("../merge/batch.ts");
      const { singleMergeOnly } = await import("../merge/queue.ts");
      const refused = await checkMergeApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const repo = String(ctx.params.repo), limit = Number(ctx.params.limit);
      const b = await runBatches(ctx.db, { repo, limit, onMerged: ctx.handled }, ctx.log);
      ctx.usageRun(b.runId);
      let single = { merged: [] as string[], attempted: [] as string[], refused: [] as unknown[], asked: [] as string[] };
      if (limit > b.merged.length) {
        single = await runMerge(ctx.db, { repo, limit: limit - b.merged.length, dryRun: false, only: (e) => singleMergeOnly(e) || b.skipped.includes(e.number), onMerged: (n) => ctx.handled(b.merged.length + n) }, ctx.log);
      }
      return `${repo}: ${b.merged.length} merged in batches (${b.started.length} started, ${b.published.length} opened, ${b.split.length} split), ${single.merged.length} merged singly, ${single.asked.length} decisions asked`;
    },
  },
  {
    name: "merge-ask",
    title: "Ask Merge? decisions",
    description: "Asks a \"Merge this PR?\" decision for every taken pull request the merge rule does not cover once its verification is in, in all tracked repos, whether or not merging is approved there. Calls no model and writes nothing to GitHub.",
    stage: 6,
    requires: "operator",
    group: "local",
    models: [],
    params: [],
    run: async (ctx) => {
      const { askMergeDecisions } = await import("../merge/index.ts");
      const { trackedNames } = await import("../repos.ts");
      const ids = askMergeDecisions(ctx.db, { repos: trackedNames(ctx.db) });
      ctx.handled(ids.length);
      return `${ids.length} Merge? decisions asked`;
    },
  },
  {
    name: "act",
    title: "Comment and close",
    description: "Posts one short comment and closes the items an operator answered Out of scope or Close, and asks a \"Close this PR?\" decision for each PR whose review says close. Skips an item that already closed or whose PR head moved. Calls no model.",
    stage: 6,
    requires: "operator",
    group: "github-write",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, help: "items to act on in this job" },
    ],
    check: checkCommentApproved,
    run: async (ctx) => {
      const { runAct } = await import("../act/index.ts");
      const refused = await checkCommentApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runAct(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), dryRun: false, onHandled: ctx.handled }, ctx.log);
      return `${r.repo}: ${r.done.length} closed, ${r.skipped.length} skipped, ${r.failed.length} failed, ${r.asked.length} decisions asked`;
    },
  },
  {
    name: "fixup",
    title: "Fix up take-fix pull requests",
    description: "For take-fix pull requests we may push to, Sonnet turns the review's fix list into a diff that is checked and applied on top of the reviewed head, checked by Opus, pushed to the contributor's branch and noted with one short comment. For a pull request it cannot push to, in a repo approved for comments, it posts the fixes as one comment instead. The new head is reviewed again.",
    stage: 6,
    requires: "operator",
    group: "github-write",
    models: ["sonnet", "opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5, help: "pull requests to fix up in this job" },
    ],
    check: checkPushApproved,
    run: async (ctx) => {
      const { runFixup } = await import("../fixup/index.ts");
      const refused = await checkPushApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runFixup(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), dryRun: false, onHandled: ctx.handled }, ctx.log);
      return `${r.repo}: pushed ${r.pushed.length}, ${r.asked.length} asked, ${r.failed.length} failed or refused, ${r.held.length} held`;
    },
  },
  {
    name: "verify",
    title: "Plan verification of taken pull requests",
    description: "Sonnet decides per taken pull request of one repo whether CI is enough, or which crates and tests a build machine should run, or (bug fixes) a regression test that fails before the change. Queues the build tasks; reads GitHub, writes nothing to it.",
    stage: 6,
    requires: "operator",
    group: "verify",
    models: ["sonnet"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "PRs to plan in this job" },
    ],
    run: async (ctx) => {
      const { runVerify } = await import("../verify/index.ts");
      const r = await runVerify(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
      ctx.usageRun(r.runId);
      const k = Object.entries(r.kinds).map(([x, n]) => `${n} ${x}`).join(", ");
      return `${r.repo}: planned ${r.handled} of ${r.candidates} candidates${k ? ` (${k})` : ""}; ${r.errors} errors, ${r.tasks.length} tasks queued`;
    },
  },
  {
    name: "verify-collect",
    title: "Collect verification results",
    description: "Reads the finished build tasks of each pending verification and sets passed, failed or error from their exit codes. For a failure, Haiku summarises the log; the failure becomes a hold. Cancels the tasks of a PR whose head moved on, and queued warm builds of a branch that moved on.",
    stage: 6,
    requires: "operator",
    group: "verify",
    models: ["haiku"],
    params: [],
    run: async (ctx) => {
      const { runCollect } = await import("../verify/results.ts");
      const r = await runCollect(ctx.db, {}, ctx.log);
      ctx.usageRun(r.runId);
      ctx.handled(r.changed);
      return `${r.looked} pending: ${r.passed} passed, ${r.failed} failed, ${r.errors} errors, ${r.retried} retried, ${r.stale} stale, ${r.running} running; ${r.warmCancelled} warm builds cancelled`;
    },
  },
  {
    name: "prioritize",
    title: "Prioritize open items",
    description: "Jev rates the priority level (P0 to P4, P4 = backlog) of open items whose text has no priority yet; Haiku decides where Jev is under 90 % sure. Then every item's reach (the tie-breaker inside a level) is recomputed from comments, linked PRs, duplicates, age and the security flag.",
    stage: 2,
    requires: "operator",
    group: "priority",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 1000, help: "items sent to Jev in this job" }],
    run: async (ctx) => {
      const { runPrioritize } = await import("../priority/index.ts");
      const r = await runPrioritize(ctx.db, { limit: Number(ctx.params.limit), onSent: ctx.handled, cancelled: ctx.cancelled, log: ctx.log });
      return r.due ? `rated ${r.saved} of ${r.sent} items (${r.jev} by Jev, ${r.haiku} by Haiku), ${r.due - r.sent > 0 ? r.due - r.sent : 0} left; ${r.rescored} reach values changed` : `nothing new to rate; ${r.rescored} reach values changed`;
    },
  },
  {
    name: "dupes",
    title: "Find duplicates",
    description: "Looks up the nearest neighbours of new and changed open items in the same repo, among open items and items closed in the last year. Jev checks each pair; Haiku gives a second opinion where Jev is under 90 % sure either way. Each confirmed duplicate becomes a \"Close as a duplicate?\" decision; the act step closes only on an operator's answer. Writes nothing to GitHub.",
    stage: 3,
    requires: "operator",
    group: "dupes",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 2000, help: "pairs to check in this job" }],
    run: async (ctx) => {
      const { runDupes } = await import("../dupes/index.ts");
      const r = await runDupes(ctx.db, { limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
      const v = Object.entries(r.verdicts).map(([k, n]) => `${n} ${k}`).join(", ");
      return `scanned ${r.scanned} items, ${r.pairsAdded} new pairs; checked ${r.checked}${v ? ` (${v})` : ""}; ${r.asked.length} decisions asked, ${r.answersApplied} answers applied`;
    },
  },
  {
    name: "fixissue",
    title: "Fix issues",
    description: "The issue path of the pipeline. For open bugfix issues with a clear fix, Sonnet triages the issue, then writes a fix and a regression test as a diff that is checked and queued as build tasks: the test must fail on main and everything must pass with the fix. Rounds that fail are tried again, three at most.",
    stage: 7,
    requires: "operator",
    group: "fixissue",
    models: ["sonnet", "haiku"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 20, default: 3, help: "issues to start in this job" },
    ],
    check: checkFixIssueApproved,
    run: async (ctx) => {
      const { runFixIssue } = await import("../fixissue/index.ts");
      const refused = await checkFixIssueApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runFixIssue(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), dryRun: false, onHandled: ctx.handled }, ctx.log);
      ctx.usageRun(r.runId);
      return `${r.repo}: ${r.started.length} started, ${r.skipped.length} not a clear fix, ${r.queued.length} further rounds queued`;
    },
  },
  {
    name: "fixissue-collect",
    title: "Collect fix results",
    description: "Reads the finished build tasks of each fix attempt. A fix passes when its tests pass and the regression test fails without it; Opus then checks the patch; on a reject the round fails and Opus's reasons go into the next round. Then the commit is pushed to the pipeline's fork, the pull request is opened and the issue gets one comment. For a failed round, Haiku summarises the log for the next round.",
    stage: 7,
    requires: "operator",
    group: "fixissue",
    models: ["haiku", "opus"],
    params: [],
    run: async (ctx) => {
      const { runFixIssueCollect } = await import("../fixissue/index.ts");
      const r = await runFixIssueCollect(ctx.db, {}, ctx.log);
      ctx.usageRun(r.runId);
      ctx.handled(r.changed);
      return `${r.looked} pending: ${r.passed} passed, ${r.opened} PRs opened, ${r.failedRounds} failed rounds, ${r.failed} failed, ${r.retried} retried`;
    },
  },
  {
    name: "rank",
    title: "Rank open items",
    description: "Computes the work rank of every open item: priority level (raised by one for the security flag), type label, size (changed lines of a PR, the Fix triage's estimate for an issue), then reach. Review, Fix (which skips P4), Verify, Fix-up, Decide and the merge queue take their items in this order. Calls no model and writes nothing to GitHub.",
    stage: 2,
    requires: "operator",
    group: "local",
    models: [],
    params: [],
    run: async (ctx) => {
      const { runRank } = await import("../rank/index.ts");
      const r = runRank(ctx.db);
      ctx.handled(r.items);
      return `${r.items} open items ranked, ${r.changed} changed, ${r.removed} removed`;
    },
  },
  {
    name: "referee",
    title: "Referee label disagreements",
    description: "Sonnet settles items where Jev and Haiku chose different type labels and at least one is not a scope label (scope disagreements go to Decide). A sure answer settles the type; an unsure one leaves the label to a person.",
    stage: 2,
    requires: "operator",
    group: "referee",
    models: ["sonnet"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 500, default: 100, help: "items sent to Sonnet in this job" }],
    run: async (ctx) => {
      const { currentRun } = await import("./classify.ts");
      const { refereeCandidates, refereeItems } = await import("../classify/referee.ts");
      const run = currentRun(ctx.db);
      if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
      const items = refereeCandidates(ctx.db, run, Number(ctx.params.limit));
      if (!items.length) return `Nothing to referee in run ${run}.`;
      const got = await refereeItems(ctx.db, run, items, { pipeline: true, onSent: ctx.handled, cancelled: ctx.cancelled });
      ctx.usageRun(run);
      return `Run ${run}: Sonnet answered ${got} of ${items.length} disagreements.`;
    },
  },
  {
    name: "opus-review",
    title: "Final review by Opus",
    description: "Opus reviews, one pull request per call, the pull requests of one repo that Sonnet rated take or take-fix, unless the skip list exempts the diff. After a new push it reads only the changes since the head it reviewed before. Its verdict and fix list replace Sonnet's for every later stage.",
    stage: 5,
    requires: "operator",
    group: "review",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5, help: "pull requests to review in this job" },
    ],
    run: async (ctx) => {
      const { runOpusReview } = await import("../review/opus.ts");
      const r = await runOpusReview(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
      ctx.usageRun(r.runId);
      const v = Object.entries(r.verdicts).map(([k, n]) => `${n} ${k}`).join(", ");
      return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates} candidates${v ? ` (${v})` : ""}; ${r.skipListed} skip-listed, ${r.skipped.length} without a diff, ${r.missing.length} without an answer`;
    },
  },
];

let loaded: Promise<Map<string, StepDef>> | null = null;
let loadedMap: Map<string, StepDef> | null = null;

/** A step by name without waiting: the loaded list once `loadSteps` has finished, else the built-in steps. */
export const knownStep = (name: string): StepDef | undefined => loadedMap?.get(name) ?? STEPS.find((s) => s.name === name);

/**
 * Every step by name. CRAFT_AUTO_EXTRA_STEPS names a module exporting `steps:
 * StepDef[]` that is added too; tests and development smoke runs use it for
 * fake steps. The dashboard, the runner and each job's child read the same
 * variable, so they see the same list.
 */
export function loadSteps(): Promise<Map<string, StepDef>> {
  loaded ??= (async () => {
    const map = new Map(STEPS.map((s) => [s.name, s]));
    const extra = process.env.CRAFT_AUTO_EXTRA_STEPS;
    if (extra) for (const s of ((await import(pathToFileURL(resolve(extra)).href)) as { steps: StepDef[] }).steps) map.set(s.name, s);
    loadedMap = map;
    return map;
  })();
  return loaded;
}

export class ParamError extends Error {}

/** The request's params checked against the step's schema, with defaults filled in. Unknown keys are refused. */
export function validateParams(step: StepDef, raw: unknown, trackedRepos: string[]): Params {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ParamError("params must be an object");
  const given = raw as Record<string, unknown>;
  const known = new Set(step.params.map((p) => p.name));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new ParamError(`${step.name} has no parameter ${k}`);
  const out: Params = {};
  for (const p of step.params) {
    const v = given[p.name];
    if (v === undefined || v === null || v === "") {
      const d = "default" in p ? p.default : undefined;
      if (d !== undefined) out[p.name] = d;
      else if (p.required) throw new ParamError(`${p.label} is required`);
      continue;
    }
    switch (p.kind) {
      case "enum":
        if (typeof v !== "string" || !p.options.includes(v)) throw new ParamError(`${p.label} must be one of ${p.options.join(", ")}`);
        out[p.name] = v;
        break;
      case "repo":
        if (typeof v !== "string" || !trackedRepos.includes(v)) throw new ParamError(`${p.label} must be a tracked repo`);
        out[p.name] = v;
        break;
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v) || v < p.min || v > p.max) throw new ParamError(`${p.label} must be a whole number from ${p.min} to ${p.max}`);
        out[p.name] = v;
        break;
      case "run-id":
        if (typeof v !== "string" || !RUN_ID.test(v)) throw new ParamError(`${p.label} must be lowercase letters, digits and dashes (at most 48)`);
        out[p.name] = v;
        break;
    }
  }
  return out;
}
