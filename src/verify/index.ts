// Stage 6, Verify: for each taken PR, one Sonnet call (no tools) chooses what verification the change
// needs beyond GitHub CI, and our code turns a valid choice into build tasks. Pass or fail comes from the
// tasks' exit codes, never from a model. Reads GitHub; never writes to it.
//
//   autocraft verify --repo R [--limit N] [--dry-run]
//
// Part 2 (results) belongs in ./results.ts: it reads the finished tasks of each `planned` or `running`
// verification, sets the state, summary and finished_at, writes the failure summary and cancels the
// queued tasks of a verification whose PR head moved on (state `stale`).
import type { DatabaseSync } from "node:sqlite";
import { BuildError } from "../build/envs.ts";
import { connect } from "../db.ts";
import { add, askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { cachedDiff, codeDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { cachedCrates, ghApi, ghCrates, type CratesFetcher } from "./crates.ts";
import { NOT_RUST_REASON, selectCandidates, unavailableCandidates, type VerifyCandidate } from "./candidates.ts";
import { parsePlanReply, type VerifyPlan } from "./plan.ts";
import { queueTasks, queueWarmBuild } from "./tasks.ts";
import type { Crate, VerifyPlanInput } from "./types.ts";

export { collectDue, listVerifications, runCollect, verificationOf, type VerificationView } from "./results.ts";

const PROMPT = CLAUDE_PROMPTS["verify.plan"];
const ORG = "storytold";
/** Characters of code diff the planner is shown; a larger change is not planned automatically. */
export const MAX_DIFF_CHARS = 80_000;
const SHA = /^[0-9a-f]{40}$/;

export type VerifyDeps = {
  fetchDiff: DiffFetcher;
  fetchCrates: CratesFetcher;
  /** The PR's base commit, or null when GitHub did not answer. */
  baseOf: (repo: string, number: number) => Promise<string | null>;
  /** The head commit of the repo's default branch, or null. */
  mainHead: (repo: string, branch: string) => Promise<string | null>;
  model: string;
  /** Host directory with a read-only checkout of the PR head for the sandboxed planner call, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
};

async function sha(path: string, jq: string): Promise<string | null> {
  try {
    const s = (await ghApi(path, jq)).trim();
    return SHA.test(s) ? s : null;
  } catch { return null; }
}

export function defaultDeps(): VerifyDeps {
  return {
    fetchDiff: ghDiff, fetchCrates: ghCrates, model: PROMPT.models[0]!, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
    baseOf: (repo, n) => sha(`repos/${ORG}/${repo}/pulls/${n}`, ".base.sha"),
    mainHead: (repo, branch) => sha(`repos/${ORG}/${repo}/commits/${encodeURIComponent(branch)}`, ".sha"),
  };
}

export type VerifyParams = { repo: string; limit?: number; dryRun?: boolean; onHandled?: (n: number) => void };
export type VerifySummary = {
  runId: string; repo: string; candidates: number; handled: number;
  kinds: Record<string, number>; errors: number; tasks: number[]; warm: number | null; skipped: string[];
};

const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

type Saved = { kind: string; reason: string; plan: unknown; model: string | null; headTask: number | null; baseTask: number | null; baseSha: string | null; state: string; summary: string | null };

/** Stores the verification of a PR head and its stages row. */
export function saveVerification(db: DatabaseSync, c: { repo: string; number: number; head_oid: string }, v: Saved): void {
  const at = now();
  db.prepare(`INSERT OR REPLACE INTO verifications (repo, number, head_sha, base_sha, kind, reason, plan, model, head_task_id, base_task_id, state, summary, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.repo, c.number, c.head_oid, v.baseSha, v.kind, v.reason, v.plan === null ? null : JSON.stringify(v.plan), v.model, v.headTask, v.baseTask, v.state, v.summary, at,
      v.state === "ci-enough" || v.state === "error" || v.state === "unavailable" ? at : null);
  const stage = v.state === "planned" ? "verify-planned" : v.state === "ci-enough" ? "verify-ci-enough" : v.state === "unavailable" ? "verify-unavailable" : "verify-error";
  db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)")
    .run(c.repo, c.number, stage, at, "verify", `${v.kind} at ${c.head_oid.slice(0, 7)}: ${v.summary ?? v.reason}`.slice(0, 300));
}

/** The plan as stored: the patch is in the task row, so the plan column keeps its size. */
const storedPlan = (p: VerifyPlan): unknown => (p.kind === "regression" ? { kind: p.kind, crate: p.crate, dir: p.dir, test_lines: p.patch.split("\n").length - 6 } : p);

/** Verify cannot build this PR's repo: the Merge? decision says "not verified" and an operator decides. */
const unavailableRow = (reason: string): Saved => ({ kind: "unavailable", reason, plan: null, model: null, headTask: null, baseTask: null, baseSha: null, state: "unavailable", summary: reason });

const errorRow = (reason: string): Saved => ({ kind: "error", reason, plan: null, model: null, headTask: null, baseTask: null, baseSha: null, state: "error", summary: reason });

export async function runVerify(db: DatabaseSync, params: VerifyParams, log: (line: string) => void = console.log, deps: VerifyDeps = defaultDeps()): Promise<VerifySummary> {
  const { repo } = params;
  const runId = `verify-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = selectCandidates(db, repo);
  const summary: VerifySummary = { runId, repo, candidates: cands.length, handled: 0, kinds: {}, errors: 0, tasks: [], warm: null, skipped: [] };
  if (params.dryRun) {
    log(`verify ${repo}: ${cands.length} candidates; dry run, nothing fetched or asked`);
    return summary;
  }
  if (params.limit !== undefined) cands = cands.slice(0, params.limit);
  // Nothing to build for these: recorded at once so the PR goes on to the Merge? decision.
  for (const u of unavailableCandidates(db, repo)) {
    saveVerification(db, u.c, unavailableRow(u.reason));
    log(`  ${refOf(u.c)}: verification unavailable: ${u.reason}`);
    summary.handled++;
    params.onHandled?.(summary.handled);
  }
  const branch = (db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch ?? "main";
  let queued = false;

  for (const c of cands) {
    const ref = refOf(c);
    const handle = (): void => { summary.handled++; params.onHandled?.(summary.handled); };
    const cr = await cachedCrates(repo, c.head_oid, deps.fetchCrates);
    if (!cr.ok) { log(`  ${ref}: no crate list: ${cr.error}`); summary.skipped.push(ref); continue; }
    if (!cr.rust) {
      saveVerification(db, c, unavailableRow(NOT_RUST_REASON));
      log(`  ${ref}: verification unavailable: ${NOT_RUST_REASON}`);
      handle();
      continue;
    }
    const d = await cachedDiff(repo, c.number, c.head_oid, deps.fetchDiff);
    if (!d.ok) {
      if (d.tooLarge) { saveVerification(db, c, errorRow("GitHub refuses the diff: too large to plan")); summary.errors++; handle(); }
      else { log(`  ${ref}: no diff: ${d.error}`); summary.skipped.push(ref); }
      continue;
    }
    let cd = codeDiff(d.text);
    if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
    if (cd.text.length > MAX_DIFF_CHARS) { saveVerification(db, c, errorRow(`code diff of ${cd.text.length} characters is too large to plan`)); summary.errors++; handle(); continue; }
    const base = await deps.baseOf(repo, c.number);
    if (!base) { log(`  ${ref}: no base commit`); summary.skipped.push(ref); continue; }

    const input = planInput(c, cr.crates, cd);
    const checkout = (await deps.checkout?.(repo, c.number, c.head_oid)) ?? undefined;
    if (checkout) input.repo_dir = REPO_PATH;
    const start = now();
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let result: ReturnType<typeof parsePlanReply> | null = null;
    for (let attempt = 0; attempt < PROMPT.limits.attempts && !(result && result.ok); attempt++) {
      const reply = await askClaude("verify.plan", deps.model, [input], db, { checkout });
      if (!reply) continue;
      usage = add(usage, reply.usage);
      result = parsePlanReply(reply.text, ref, cr.crates, c.label);
    }
    saveUsage(db, runId, `verify-${c.number}`, "verify", deps.model, result ? 1 : 0, usage, start, now());
    if (!result) { log(`  ${ref}: no answer from the planner`); summary.skipped.push(ref); handle(); continue; }
    handle();
    if (!result.ok) {
      log(`  ${ref}: invalid plan: ${result.error}`);
      saveVerification(db, c, { ...errorRow(result.error), model: deps.model });
      summary.errors++;
      continue;
    }
    const plan = result.plan;
    summary.kinds[plan.kind] = (summary.kinds[plan.kind] ?? 0) + 1;
    if (plan.kind === "ci-enough") {
      saveVerification(db, c, { kind: plan.kind, reason: plan.reason, plan: null, model: deps.model, headTask: null, baseTask: null, baseSha: base, state: "ci-enough", summary: plan.reason });
      continue;
    }
    try {
      const ids = queueTasks(db, plan, { repo, number: c.number, head: c.head_oid, base });
      summary.tasks.push(...ids);
      queued = true;
      saveVerification(db, c, { kind: plan.kind, reason: plan.reason, plan: storedPlan(plan), model: deps.model, headTask: ids[0] ?? null, baseTask: ids[1] ?? null, baseSha: base, state: "planned", summary: plan.reason });
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      log(`  ${ref}: tasks not queued: ${e.message}`);
      saveVerification(db, c, { ...errorRow(`tasks not queued: ${e.message}`), model: deps.model });
      summary.errors++;
    }
  }

  if (queued) {
    const main = await deps.mainHead(repo, branch);
    if (main) summary.warm = queueWarmBuild(db, repo, main);
    else log(`verify ${repo}: no head for ${branch}; no warm build queued`);
  }
  log(`verify ${repo}: ${summary.handled} planned (${Object.entries(summary.kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}); ${summary.errors} errors, ${summary.skipped.length} skipped; ${summary.tasks.length} tasks${summary.warm ? ", 1 warm build" : ""}`);
  return summary;
}

function planInput(c: VerifyCandidate, crates: Crate[], cd: ReturnType<typeof codeDiff>): VerifyPlanInput {
  return {
    ref: refOf(c), title: c.title, body: c.body, label: c.label, review: c.review, crates,
    files: cd.files, tests_omitted: cd.testsOmitted, diff: cd.text,
  };
}

function parseArgs(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const n = args[i]!.replace(/^--/, "");
    if (!["repo", "limit", "dry-run"].includes(n)) throw new Error(`unknown option ${args[i]}; options: --repo --limit --dry-run`);
    if (n === "dry-run") out[n] = true;
    else {
      const v = args[++i];
      if (v === undefined) throw new Error(`--${n} needs a value`);
      out[n] = v;
    }
  }
  return out;
}

export const commands = {
  "verify-collect": {
    summary: "verify-collect [--dry-run]: set passed, failed or error on pending verifications from their finished tasks",
    async run(args: string[]): Promise<void> {
      if (args.some((a) => a !== "--dry-run")) throw new Error("options: --dry-run");
      const { runCollect } = await import("./results.ts");
      await runCollect(connect(), { dryRun: args.length > 0 });
    },
  },
  verify: {
    summary: "verify --repo R [--limit N] [--dry-run]: plan the verification of taken PRs and queue build tasks",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      await runVerify(connect(), { repo: f.repo, limit, dryRun: f["dry-run"] === true });
    },
  },
};
