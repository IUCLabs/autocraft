// Stage 7, Fix issues: the issue path of the pipeline. For an open bugfix issue with a clear fix, Sonnet triages
// it, then writes a unified diff (the fix and one regression test) that our code validates. Build tasks in the
// sandbox must show the test failing on main and everything passing with the fix. A passing fix is committed with
// the pipeline account's identity, pushed to its fork and opened as a PR, which then goes through Review, Verify
// and the merge queue like any other PR.
//
//   craft-auto fixissue --repo R [--limit N] [--apply]
//   craft-auto fixissue-collect [--apply]
//   craft-auto fixissue-approval [--repo R]
//
// Without --apply it is a dry run: local tables only. No model is a tool user: replies are text our code
// validates, and nothing from an issue or a patch runs on this user (the build tasks run in the sandbox).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TERMINAL, cancelTask, getTask } from "../build/tasks.ts";
import { BuildError } from "../build/envs.ts";
import { askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { Git, exec, fixupDir, type Exec } from "../fixup/git.ts";
import { whoAmI } from "../fixup/index.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { diffCacheDir } from "../review/diff.ts";
import { rustPlan } from "../worker/rust.ts";
import type { TaskStep } from "../worker/types.ts";
import { createTask, type NewTask } from "../build/tasks.ts";
import { cachedCrates, ghApi, ghCrates, type CratesFetcher } from "../verify/crates.ts";
import { cloneTask, queueWarmBuild } from "../verify/tasks.ts";
import { outcomeOf, summariseFailure } from "../verify/results.ts";
import { regressionPath } from "../verify/plan.ts";
import { fixIssueApprovalOf } from "./approval.ts";
import { notRustKey, selectIssues, type IssueCandidate } from "./candidates.ts";
import { parseTriage, sourcePaths, validateFixPatch } from "./parse.ts";
import { branchName, commentText, commitMessage, prBody, prTitle } from "./template.ts";
import { COMMENTS_SHOWN, COMMENT_CHARS, FILE_CAP, ISSUE_BODY_LIMIT, MAX_PATHS, MAX_ROUNDS, TOTAL_CAP, type IssueText, type PatchInput, type TriageInput } from "./types.ts";

export { selectIssues, type IssueCandidate } from "./candidates.ts";

const ORG = "storytold";
const ACTOR = "fixissue";
const TRIAGE = CLAUDE_PROMPTS["fixissue.triage"];
const PATCH = CLAUDE_PROMPTS["fixissue.patch"];
const SHA = /^[0-9a-f]{40}$/;
const MAX_PUSH_TRIES = 3;
const REQUIRES = { os: "linux", toolchains: ["rust-stable"] } as const;

type Id = "fixissue.triage" | "fixissue.patch";

export type FixIssueDeps = {
  /** Every git and gh command. */
  exec: Exec;
  /** The model's reply to a fixissue prompt, or null when it gave none. */
  ask: (db: DatabaseSync, id: Id, input: TriageInput | PatchInput, runId: string) => Promise<string | null>;
  /** The head commit of the repo's default branch, or null. */
  mainHead: (repo: string, branch: string) => Promise<string | null>;
  fetchCrates: CratesFetcher;
  /** Every file path of the repo at a commit, or null. */
  fetchPaths: (repo: string, sha: string) => Promise<string[] | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
};

async function shaOf(path: string): Promise<string | null> {
  try {
    const s = (await ghApi(path, ".sha")).trim();
    return SHA.test(s) ? s : null;
  } catch { return null; }
}

export const ghPaths: FixIssueDeps["fetchPaths"] = async (repo, sha) => {
  try {
    return JSON.parse(await ghApi(`repos/${ORG}/${repo}/git/trees/${sha}?recursive=1`, "[.tree[] | select(.type == \"blob\") | .path]")) as string[];
  } catch { return null; }
};

export function defaultDeps(): FixIssueDeps {
  return {
    exec, now: () => new Date(), root: fixupDir(), fetchCrates: ghCrates, fetchPaths: ghPaths,
    mainHead: (repo, branch) => shaOf(`repos/${ORG}/${repo}/commits/${encodeURIComponent(branch)}`),
    ask: async (db, id, input, runId) => {
      const model = CLAUDE_PROMPTS[id].models[0]!;
      const start = new Date().toISOString();
      const reply = await askClaude(id, model, [input] as never, db);
      saveUsage(db, runId, `fixissue-${input.ref.replace(/[^A-Za-z0-9]/g, "-")}`, "fixissue", model, reply ? 1 : 0, reply?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, start, new Date().toISOString());
      return reply?.text ?? null;
    },
  };
}

const iso = (d: FixIssueDeps): string => d.now().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Source paths of a commit, cached by sha next to the diff cache. */
async function cachedPaths(repo: string, sha: string, fetch: FixIssueDeps["fetchPaths"]): Promise<string[] | null> {
  const f = join(diffCacheDir(), repo, `paths-${sha}.json`);
  if (existsSync(f)) {
    try { return JSON.parse(readFileSync(f, "utf8")) as string[]; } catch { /* fetch again */ }
  }
  const all = await fetch(repo, sha);
  if (!all) return null;
  const paths = sourcePaths(all, MAX_PATHS);
  mkdirSync(join(diffCacheDir(), repo), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(paths));
  renameSync(`${f}.tmp`, f);
  return paths;
}

// ---- rows ----------------------------------------------------------------------

export type AttemptRow = {
  repo: string; number: number; main_sha: string; text_hash: string; state: string; round: number;
  files: string | null; crate: string | null; crate_dir: string | null; patch: string | null; test_patch: string | null;
  head_task_id: number | null; base_task_id: number | null; retries: number; push_tries: number;
  summary: string | null; pr_url: string | null; reason: string | null; created_at: string; updated_at: string;
};

export const attemptOf = (db: DatabaseSync, repo: string, number: number): AttemptRow | null =>
  (db.prepare("SELECT * FROM fix_attempts WHERE repo = ? AND number = ?").get(repo, number) as AttemptRow | undefined) ?? null;

function update(db: DatabaseSync, d: FixIssueDeps, r: { repo: string; number: number }, set: Record<string, string | number | null>): void {
  const keys = Object.keys(set);
  db.prepare(`UPDATE fix_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE repo = ? AND number = ?`)
    .run(...keys.map((k) => set[k]!), iso(d), r.repo, r.number);
}

function stage(db: DatabaseSync, d: FixIssueDeps, r: { repo: string; number: number }, kind: "hold" | "take", note: string): void {
  db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)").run(r.repo, r.number, kind, iso(d), ACTOR, note.slice(0, 300));
}

function fail(db: DatabaseSync, d: FixIssueDeps, r: AttemptRow, reason: string): void {
  update(db, d, r, { state: "failed", reason: oneLine(reason) });
  stage(db, d, r, "hold", `fix failed: ${oneLine(reason)}`);
}

/** A round that did not work out: another round, or `failed` after the last. */
function roundFailed(db: DatabaseSync, d: FixIssueDeps, r: AttemptRow, round: number, reason: string, patch: string | null, log: (l: string) => void): void {
  const why = oneLine(reason);
  log(`  ${refOf(r)}: round ${round} failed: ${why}`);
  if (round >= MAX_ROUNDS) {
    update(db, d, r, { round, patch, summary: why });
    fail(db, d, { ...r, round }, `${MAX_ROUNDS} rounds without a passing fix; last: ${why}`);
  } else update(db, d, r, { state: "retry", round, patch, summary: why, head_task_id: null, base_task_id: null, retries: 0 });
}

function issueText(db: DatabaseSync, c: { repo: string; number: number; title: string; body: string }): IssueText {
  const comments = (db.prepare("SELECT author, body FROM comments WHERE repo = ? AND number = ? AND COALESCE(kind, 'comment') = 'comment' ORDER BY created_at LIMIT 40").all(c.repo, c.number) as { author: string | null; body: string | null }[])
    .filter((x) => x.author && !x.author.endsWith("[bot]")).slice(0, COMMENTS_SHOWN)
    .map((x) => ({ author: x.author!, body: (x.body ?? "").slice(0, COMMENT_CHARS) }));
  return { ref: refOf(c), title: c.title.slice(0, 300), body: c.body.slice(0, ISSUE_BODY_LIMIT), comments };
}

// ---- sandbox tasks -------------------------------------------------------------

const regressionStep = (crate: string): TaskStep =>
  ({ name: "regression", cmd: ["cargo", "test", "--offline", "--locked", "-p", crate, "--test", "autocraft_regression"], network: "none", timeoutSec: 3600 });

/** Head: main plus the full patch, the crate's tests and the regression test. Base: main plus the test file, expected to fail. */
export function tasksFor(r: { repo: string; number: number; main_sha: string; crate: string }, patch: string, testPatch: string): NewTask[] {
  const common = { step: "fixissue", repo: r.repo, number: r.number, headSha: r.main_sha, baseSha: r.main_sha, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, warm: { key: r.repo, role: "use" as const } };
  const steps = rustPlan({ cargoArgs: ["-p", r.crate] });
  const baseSteps = steps.map((s): TaskStep => (s.name === "test" ? { ...s, cmd: [...s.cmd, "--test", "autocraft_regression"] } : s));
  return [{ ...common, plan: [...steps, regressionStep(r.crate)], patch }, { ...common, plan: baseSteps, patch: testPatch }];
}

// ---- running: triage and patch rounds -------------------------------------------

export type FixIssueParams = { repo: string; limit?: number; dryRun?: boolean; onHandled?: (n: number) => void };
export type FixIssueSummary = { runId: string; repo: string; dryRun: boolean; started: string[]; queued: string[]; skipped: string[]; failed: string[] };

const branchOf = (db: DatabaseSync, repo: string): string =>
  (db.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repo) as { default_branch: string | null } | undefined)?.default_branch ?? "main";

type Ctx = { db: DatabaseSync; d: FixIssueDeps; git: Git; log: (l: string) => void; runId: string; usage: Usage };

async function ask(x: Ctx, id: Id, input: TriageInput | PatchInput): Promise<string | null> {
  return x.d.ask(x.db, id, input, x.runId);
}

/** Triage of a new candidate, then its first patch round. */
async function startAttempt(x: Ctx, c: IssueCandidate): Promise<"started" | "skipped" | "none"> {
  const { db, d, log } = x;
  const ref = refOf(c);
  const branch = branchOf(db, c.repo);
  const main = await d.mainHead(c.repo, branch);
  if (!main) { log(`  ${ref}: no head for ${branch}`); return "none"; }
  const cr = await cachedCrates(c.repo, main, d.fetchCrates);
  if (!cr.ok) { log(`  ${ref}: no crate list: ${cr.error}`); return "none"; }
  if (!cr.rust) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(notRustKey(c.repo), main);
    log(`  ${c.repo}: not a Rust workspace`);
    return "none";
  }
  const paths = await cachedPaths(c.repo, main, d.fetchPaths);
  if (!paths) { log(`  ${ref}: no file list`); return "none"; }
  const input: TriageInput = { ...issueText(db, c), crates: cr.crates, paths };
  let parsed: ReturnType<typeof parseTriage> | null = null;
  for (let attempt = 0; attempt < TRIAGE.limits.attempts && !(parsed && parsed.ok); attempt++) {
    const reply = await ask(x, "fixissue.triage", input);
    if (reply !== null) parsed = parseTriage(reply, ref, cr.crates, paths);
  }
  const at = iso(d);
  const row = (state: string, reason: string, extra: Partial<AttemptRow> = {}): AttemptRow => {
    db.prepare(`INSERT OR REPLACE INTO fix_attempts (repo, number, main_sha, text_hash, state, round, files, crate, crate_dir, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`).run(c.repo, c.number, main, c.hash, state, extra.files ?? null, extra.crate ?? null, extra.crate_dir ?? null, reason, at, at);
    return attemptOf(db, c.repo, c.number)!;
  };
  if (!parsed) { log(`  ${ref}: no answer from the triage`); return "none"; }
  if (!parsed.ok || !parsed.triage.fixable) {
    const reason = parsed.ok ? parsed.triage.reason : `triage gave no valid answer: ${parsed.error}`;
    row("skipped", reason);
    stage(db, d, c, "hold", `not a clear fix: ${oneLine(reason)}`);
    log(`  ${ref}: skipped: ${reason}`);
    return "skipped";
  }
  const t = parsed.triage;
  const r = row("retry", t.reason, { files: JSON.stringify(t.files), crate: t.crate.name, crate_dir: t.crate.dir });
  await patchRound(x, r);
  return "started";
}

/** The next round of an attempt: patch, validate, check it applies, queue the tasks. */
async function patchRound(x: Ctx, r: AttemptRow): Promise<boolean> {
  const { db, d, git, log } = x;
  const ref = refOf(r);
  const round = r.round + 1;
  const files = JSON.parse(r.files ?? "[]") as string[];
  const testPath = regressionPath(r.crate_dir!);
  const row = attemptOf(db, r.repo, r.number)!;
  try {
    if (!(await git.fetchBranch(ORG, r.repo, branchOf(db, r.repo), r.main_sha))) { fail(db, d, row, "the base commit is no longer in the repository"); return false; }
  } catch (e) {
    log(`  ${ref}: fetch failed: ${oneLine(String((e as Error).message ?? e))}`);
    return false;
  }
  const shown: PatchInput["files"] = [];
  let total = 0;
  for (const path of files) {
    const f = await git.file(r.main_sha, path);
    if (!f.ok) { fail(db, d, row, f.reason); return false; }
    total += f.content.length;
    if (f.content.length > FILE_CAP || total > TOTAL_CAP) { fail(db, d, row, "the files to read are over the size limit"); return false; }
    shown.push({ path, content: f.content });
  }
  const issue = db.prepare("SELECT title, body FROM items WHERE repo = ? AND number = ?").get(r.repo, r.number) as { title: string | null; body: string | null } | undefined;
  const input: PatchInput = {
    ...issueText(db, { repo: r.repo, number: r.number, title: issue?.title ?? "", body: issue?.body ?? "" }),
    crate: { name: r.crate!, dir: r.crate_dir! }, test_path: testPath, files: shown,
    ...(round > 1 && r.patch ? { previous: { patch: r.patch.slice(0, 60_000), failure: r.summary ?? "it did not pass" } } : {}),
  };
  const reply = await ask(x, "fixissue.patch", input);
  if (reply === null) { roundFailed(db, d, row, round, "the model gave no answer", r.patch, log); return false; }
  const v = validateFixPatch(reply, files, testPath, r.crate_dir!);
  if (!v.ok) { roundFailed(db, d, row, round, v.reason, reply.slice(0, 60_000), log); return false; }
  const scratch = mkdtempSync(join(d.root, ".index-"));
  let applied;
  try {
    applied = await git.applyToTree(r.main_sha, v.patch, join(scratch, "index"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!applied.ok) { roundFailed(db, d, row, round, applied.reason, v.patch, log); return false; }
  try {
    const ids = tasksFor({ repo: r.repo, number: r.number, main_sha: r.main_sha, crate: r.crate! }, v.patch, v.testPatch).map((t) => createTask(db, t));
    queueWarmBuild(db, r.repo, r.main_sha);
    update(db, d, r, { state: "testing", round, patch: v.patch, test_patch: v.testPatch, head_task_id: ids[0]!, base_task_id: ids[1]!, summary: null });
    log(`  ${ref}: round ${round}: ${v.files.join(", ")} (${v.changed} lines); tasks ${ids.join(", ")} queued`);
    return true;
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    log(`  ${ref}: tasks not queued: ${e.message}`);
    return false;
  }
}

export async function runFixIssue(db: DatabaseSync, params: FixIssueParams, log: (line: string) => void = console.log, deps?: FixIssueDeps): Promise<FixIssueSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const d = deps ?? defaultDeps();
  const runId = `fixissue-${repo}-${iso(d).replace(/[-:]/g, "").slice(0, 15)}`;
  const s: FixIssueSummary = { runId, repo, dryRun, started: [], queued: [], skipped: [], failed: [] };
  const retries = db.prepare("SELECT * FROM fix_attempts WHERE repo = ? AND state = 'retry' ORDER BY updated_at").all(repo) as AttemptRow[];
  const cands = selectIssues(db, repo);
  const picks = params.limit === undefined ? cands : cands.slice(0, params.limit);
  log(`fixissue ${repo}: ${cands.length} candidate issues, ${retries.length} rounds due${fixIssueApprovalOf(db, repo) ? "" : " (fixing issues is not approved for this repo)"}`);
  if (dryRun) {
    for (const r of retries) log(`  would write round ${r.round + 1} for ${refOf(r)}`);
    for (const c of picks) log(`  would triage ${refOf(c)}: ${c.title.slice(0, 80)}`);
    log(`fixissue ${repo}: dry run, nothing called or written`);
    return s;
  }
  if (!fixIssueApprovalOf(db, repo)) throw new Error(`fixing issues in ${repo} is not approved`);
  mkdirSync(d.root, { recursive: true });
  const x: Ctx = { db, d, git: new Git(d.exec, d.root, repo), log, runId, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
  for (const r of retries) {
    try {
      if (await patchRound(x, r)) s.queued.push(refOf(r));
    } catch (e) {
      log(`  ${refOf(r)}: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  let handled = 0;
  for (const c of picks) {
    try {
      params.onHandled?.(++handled);
      const o = await startAttempt(x, c);
      if (o === "started") s.started.push(refOf(c));
      else if (o === "skipped") s.skipped.push(refOf(c));
      if (attemptOf(db, c.repo, c.number)?.state === "failed") s.failed.push(refOf(c));
    } catch (e) {
      log(`  ${refOf(c)}: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  log(`fixissue ${repo}: ${s.started.length} started, ${s.skipped.length} skipped, ${s.queued.length} rounds queued; run ${runId}`);
  return s;
}

// ---- collecting ------------------------------------------------------------------

export type CollectParams = { dryRun?: boolean; onHandled?: (n: number) => void };
export type CollectDeps = FixIssueDeps & {
  /** Haiku's account of a failed step. */
  summarise: (db: DatabaseSync, repo: string, number: number, taskId: number, step: string) => Promise<string>;
};
export type CollectSummary = { runId: string; looked: number; passed: number; opened: number; failedRounds: number; failed: number; retried: number; changed: number };

export function collectDefaults(): CollectDeps {
  const d = defaultDeps();
  return {
    ...d,
    summarise: async (db, repo, number, taskId, step) => summariseFailure(db, { repo, number }, taskId, { role: "head", step, exitCode: null, timedOut: false }, { model: CLAUDE_PROMPTS["verify.summary"].models[0]! }, `fixissue-collect-${Date.now()}`),
  };
}

/** Whether work is waiting for fixissue-collect: tasks finished or a passed fix to open. Read-only, for the autopilot. */
export function collectDue(db: DatabaseSync): boolean {
  const terminal = TERMINAL.map((s) => `'${s}'`).join(", ");
  return !!db.prepare(`SELECT 1 FROM fix_attempts a
    LEFT JOIN build_tasks h ON h.id = a.head_task_id LEFT JOIN build_tasks b ON b.id = a.base_task_id
    WHERE a.state = 'passed' OR (a.state = 'testing' AND h.state IN (${terminal}) AND (b.id IS NULL OR b.state IN (${terminal}))) LIMIT 1`).get();
}

/** Whether a patch round is due or a candidate waits, for the autopilot's fixissue lane. */
export function fixDue(db: DatabaseSync, repo: string): boolean {
  return !!db.prepare("SELECT 1 FROM fix_attempts WHERE repo = ? AND state = 'retry' LIMIT 1").get(repo) || selectIssues(db, repo).length > 0;
}

export async function runFixIssueCollect(db: DatabaseSync, params: CollectParams = {}, log: (line: string) => void = console.log, deps?: CollectDeps): Promise<CollectSummary> {
  const d = deps ?? collectDefaults();
  const s: CollectSummary = { runId: `fixissue-collect-${iso(d).replace(/[-:]/g, "").slice(0, 15)}`, looked: 0, passed: 0, opened: 0, failedRounds: 0, failed: 0, retried: 0, changed: 0 };
  const rows = db.prepare("SELECT * FROM fix_attempts WHERE state IN ('testing', 'passed') ORDER BY updated_at").all() as AttemptRow[];
  s.looked = rows.length;
  if (params.dryRun) { log(`fixissue-collect: ${rows.length} pending; dry run`); return s; }
  const x = (repo: string): Ctx => ({ db, d, git: new Git(d.exec, d.root, repo), log, runId: s.runId, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } });

  for (const r of rows) {
    const ref = refOf(r);
    try {
      if (r.state === "passed") { if (await openPr(x(r.repo), r)) { s.opened++; s.changed++; } continue; }
      const item = db.prepare("SELECT state FROM items WHERE repo = ? AND number = ?").get(r.repo, r.number) as { state: string } | undefined;
      const head = r.head_task_id === null ? null : getTask(db, r.head_task_id);
      const base = r.base_task_id === null ? null : getTask(db, r.base_task_id);
      if (item && item.state !== "OPEN") {
        for (const t of [head, base]) if (t && !TERMINAL.includes(t.state)) cancelTask(db, t.id, ACTOR);
        update(db, d, r, { state: "failed", reason: "the issue is closed" });
        s.failed++; s.changed++;
        continue;
      }
      if (!head || !base) { fail(db, d, r, "the build task is gone"); s.failed++; s.changed++; continue; }
      if (!TERMINAL.includes(head.state) || !TERMINAL.includes(base.state)) continue;
      const ho = outcomeOf(head), bo = outcomeOf(base);
      if (ho.kind === "error" || bo.kind === "error") {
        const why = ho.kind === "error" ? ho.reason : (bo as { reason: string }).reason;
        if (r.retries < 1) {
          update(db, d, r, { head_task_id: cloneTask(db, head.id), base_task_id: cloneTask(db, base.id), retries: r.retries + 1 });
          s.retried++; s.changed++;
          log(`  ${ref}: ${why}; queued the tasks again`);
        } else { fail(db, d, r, `build environment error: ${why}`); s.failed++; s.changed++; }
        continue;
      }
      s.changed++;
      if (ho.kind === "fail") {
        const summary = await d.summarise(db, r.repo, r.number, head.id, ho.step);
        roundFailed(db, d, r, r.round, `head: ${summary}`, r.patch, log);
        s.failedRounds++;
      } else if (bo.kind === "pass") {
        roundFailed(db, d, r, r.round, "the regression test passes without the fix, so it does not show the bug", r.patch, log);
        s.failedRounds++;
      } else if (bo.kind === "fail" && (bo.step !== "test" || bo.timedOut)) {
        roundFailed(db, d, r, r.round, bo.timedOut ? "the regression test timed out without the fix" : `the regression test did not build without the fix (${bo.step} failed)`, r.patch, log);
        s.failedRounds++;
      } else {
        update(db, d, r, { state: "passed" });
        s.passed++;
        log(`  ${ref}: round ${r.round} passed`);
        if (await openPr(x(r.repo), { ...r, state: "passed" })) s.opened++;
      }
      const after = attemptOf(db, r.repo, r.number);
      if (after?.state === "failed") s.failed++;
    } catch (e) {
      log(`  ${ref}: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  log(`fixissue-collect: ${s.looked} pending: ${s.passed} passed, ${s.opened} PRs opened, ${s.failedRounds} failed rounds, ${s.failed} failed, ${s.retried} retried`);
  return s;
}

/** The pipeline account's fork of the repo as owner/name, created when missing. */
async function forkOf(run: Exec, login: string, repo: string): Promise<string> {
  const find = async (): Promise<string | null> => {
    const r = await run("gh", ["api", `repos/${ORG}/${repo}/forks?per_page=100`, "--jq", `.[] | select(.owner.login == "${login}") | .full_name`]);
    return r.code === 0 ? r.stdout.trim().split("\n")[0] || null : null;
  };
  const same = await run("gh", ["api", `repos/${login}/${repo}`, "--jq", ".parent.full_name"]);
  if (same.code === 0 && same.stdout.trim() === `${ORG}/${repo}`) return `${login}/${repo}`;
  const known = await find();
  if (known) return known;
  const f = await run("gh", ["repo", "fork", `${ORG}/${repo}`, "--clone=false"]);
  if (f.code !== 0) throw new Error(`could not fork ${repo}: ${oneLine(f.stderr)}`);
  const made = await find();
  if (!made) throw new Error(`the fork of ${repo} is not visible yet`);
  return made;
}

/** Commits the passed patch on main, pushes it to the fork, opens the PR and comments on the issue. */
async function openPr(x: Ctx, r: AttemptRow): Promise<boolean> {
  const { db, d, git, log } = x;
  const ref = refOf(r);
  const files = (JSON.parse(r.files ?? "[]") as string[]);
  const testPath = regressionPath(r.crate_dir!);
  const tried = (): void => {
    if (r.push_tries + 1 >= MAX_PUSH_TRIES) fail(db, d, r, "could not open the pull request");
    else update(db, d, r, { push_tries: r.push_tries + 1 });
  };
  try {
    const who = await whoAmI(d.exec);
    if (!(await git.fetchBranch(ORG, r.repo, branchOf(db, r.repo), r.main_sha))) { fail(db, d, r, "the base commit is no longer in the repository"); return false; }
    const issue = db.prepare("SELECT title FROM items WHERE repo = ? AND number = ?").get(r.repo, r.number) as { title: string | null } | undefined;
    const title = issue?.title ?? "";
    const scratch = mkdtempSync(join(d.root, ".index-"));
    let applied;
    try {
      applied = await git.applyToTree(r.main_sha, r.patch!, join(scratch, "index"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!applied.ok) { fail(db, d, r, applied.reason); return false; }
    const commit = await git.commit(applied.tree, r.main_sha, commitMessage(r.number, title, [...files, testPath]), { name: who.login, email: who.email });
    const changes = await git.rawChanges(r.main_sha, commit);
    const allowed = new Set([...files, testPath]);
    if (changes.some((c) => !allowed.has(c[3]!) || (c[2] === "A" ? c[1] !== "100644" : c[2] !== "M" || c[0] !== c[1]))) {
      fail(db, d, r, "the commit would change files or modes outside the validated diff");
      return false;
    }
    const fork = await forkOf(d.exec, who.login, r.repo);
    const branch = branchName(r.number, title, who.login);
    const push = await git.pushNew(fork, branch, commit);
    if (push.code !== 0) { log(`  ${ref}: push failed: ${oneLine(push.stderr)}`); tried(); return false; }
    audit(db, ACTOR, "fixissue-push", ref, { run: x.runId, branch, commit, fork });
    const body = prBody(r.number, files, testPath);
    const pr = await d.exec("gh", ["pr", "create", "--repo", `${ORG}/${r.repo}`, "--base", branchOf(db, r.repo), "--head", `${fork.split("/")[0]}:${branch}`, "--title", prTitle(title), "--body-file", "-"], { input: body });
    const url = pr.stdout.trim().split("\n").pop() ?? "";
    if (pr.code !== 0 || !new RegExp(`^https://github\\.com/${ORG}/${r.repo}/pull/\\d+$`).test(url)) { log(`  ${ref}: PR not opened: ${oneLine(pr.stderr || pr.stdout)}`); tried(); return false; }
    update(db, d, r, { state: "pr-opened", pr_url: url });
    audit(db, ACTOR, "fixissue-pr", ref, { run: x.runId, url, branch });
    stage(db, d, r, "take", `fix PR opened: ${url}`);
    log(`  ${ref}: opened ${url}`);
    const text = commentText(url);
    const cm = await d.exec("gh", ["issue", "comment", String(r.number), "--repo", `${ORG}/${r.repo}`, "--body-file", "-"], { input: text });
    if (cm.code === 0) audit(db, ACTOR, "fixissue-comment", ref, { run: x.runId, text });
    else log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
    return true;
  } catch (e) {
    log(`  ${ref}: ${oneLine(String((e as Error).message ?? e))}`);
    tried();
    return false;
  }
}

// ---- commands --------------------------------------------------------------------

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply`);
  }
  if (!repo) throw new Error("missing --repo");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  fixissue: {
    summary: "fixissue --repo R [--limit N] [--apply]: triage open bugfix issues, write a fix and a regression test, queue the sandbox tasks (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runFixIssue(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "fixissue-collect": {
    summary: "fixissue-collect [--apply]: read the finished sandbox tasks of fix attempts; open the PR of a passing fix (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      if (args.some((a) => a !== "--apply")) throw new Error("options: --apply");
      await runFixIssueCollect(connect(), { dryRun: !args.includes("--apply") });
    },
  },
  "fixissue-approval": {
    summary: "fixissue-approval [--repo R]: which repos the operator approved for fix PRs from issues",
    run(args: string[]): void {
      const i = args.indexOf("--repo");
      const db = connect();
      const repos = i >= 0 ? [args[i + 1]!] : (db.prepare("SELECT name FROM tracked_repos ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      for (const r of repos) {
        const a = fixIssueApprovalOf(db, r);
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
