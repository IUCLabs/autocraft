// The pipeline steps the runner can run. Each step is a declaration: who may
// request it, a params schema, a concurrency group and the function that runs
// it. Adding a step means adding one entry to STEPS (and the module its `run`
// imports); the dashboard, the API, schedules and the runner pick it up from here.
//
// Params are only enums, tracked repo names, bounded integers and run ids:
// nothing a person types can reach a model's prompt or a shell.
import { existsSync } from "node:fs";
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
  /** Who may start, cancel or schedule it. Anything that writes to GitHub or spends model quota is operator-only. */
  requires: "operator";
  /** At most one job of a group runs at a time. */
  group: "models" | "github-write" | "local" | (string & {});
  params: ParamDef[];
  /** null when the step can run; otherwise why not, shown on the page. */
  available?: () => string | null;
  /** Checks a request beyond the schema (null = fine), at request time and again before the run. */
  check?: (db: DatabaseSync, params: Params) => Promise<string | null> | string | null;
  /** Runs the step in the job's child process and returns a one-line summary. */
  run: (ctx: StepContext) => Promise<string>;
};

const moduleExists = (rel: string): boolean => existsSync(new URL(rel, import.meta.url));

// Modules from parallel tracks, imported by path so this file type-checks before they land.
async function optional<T>(rel: string): Promise<T> {
  const path: string = rel;
  return (await import(path)) as T;
}

/** Labelling writes to GitHub only for repos an operator approved on the Repos page. */
async function checkApproved(db: DatabaseSync, p: Params): Promise<string | null> {
  const { approvalOf } = await import("../labels/approval.ts");
  return approvalOf(db, String(p.repo)) ? null : `labelling ${p.repo} is not approved`;
}

export const STEPS: StepDef[] = [
  {
    name: "classify-new",
    title: "Classify new and changed items",
    description: "Jev labels open items that have no verdict in the current classification run, or whose text changed since; Haiku gives a second opinion where Jev is under 90 % sure.",
    stage: 2,
    requires: "operator",
    group: "models",
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, help: "items per model in this job" }],
    run: async (ctx) => (await import("./classify.ts")).classifyNew(ctx),
  },
  {
    name: "classify-all",
    title: "Classification pass",
    description: "Jev labels every open item of the tracked repos into the given run, then Haiku the ones Jev is unsure of. A stopped pass continues where it left off when started again with the same run id; once complete, the run becomes the current one.",
    stage: 2,
    requires: "operator",
    group: "models",
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
    params: [{ name: "scope", label: "Items", kind: "enum", options: ["changed", "all"], default: "changed" }],
    available: () => (moduleExists("../embed/index.ts") ? null : "Not available yet: the embeddings command is not in this build."),
    run: async (ctx) => {
      const m = await optional<{ commands: { embed: { run(args: string[]): Promise<void> } } }>("../embed/index.ts");
      await m.commands.embed.run(ctx.params.scope === "all" ? ["--all"] : []);
      return ctx.params.scope === "all" ? "embedded every item" : "embedded new and changed items";
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
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
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
      const r = await applyLabels(ctx.db, new Client(500), repo, { runId, apply: true, login: ctx.job.requestedBy, log: ctx.log });
      return `${repo}: labelled ${r.labeled} of ${r.planned} items in ${r.batches} batches, ${r.failed.length} failed`;
    },
  },
  {
    name: "decide",
    title: "Ask decisions",
    description: "Turns items that need a decision, and items where Jev and Haiku disagree between scope labels, into decisions on the dashboard, each with a summary written by the chosen model.",
    stage: 3,
    requires: "operator",
    group: "models",
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
    group: "models",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "PRs to review in this job" },
    ],
    run: async (ctx) => {
      const { runReview } = await import("../review/index.ts");
      const r = await runReview(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit) }, ctx.log);
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
      return `${ctx.params.repo}: refreshed ${r.prs} open pull requests`;
    },
  },
];

let loaded: Promise<Map<string, StepDef>> | null = null;

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
