// The private fix of a finding: a patch on the scan's pinned commit, built and tested in the worker container, reviewed by
// Opus, and kept as a local commit in the bare cache that is never pushed before Land. Nothing here writes to GitHub:
// `gh api user` and the fetch of the default branch are reads.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TERMINAL, cancelTask, createTask, getTask, type NewTask } from "../build/tasks.ts";
import { BuildError } from "../build/envs.ts";
import { CheckTool, applyCheck, refusal } from "../checktool/index.ts";
import { runModelStep } from "../agents/step.ts";
import { textStep } from "../agents/steps.ts";
import { Git, exec as realExec, fixupDir, type Exec } from "../fixup/git.ts";
import { whoAmI } from "../fixup/index.ts";
import { branchOf, tasksFor } from "../fixissue/index.ts";
import { editable, validateFixPatch } from "../fixissue/parse.ts";
import { parseCheck } from "../patchcheck/index.ts";
import { CHECK_PATCH_CAP } from "../patchcheck/types.ts";
import { foldFormat, readLint } from "../prepush/index.ts";
import { ownerOf } from "../owners.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { cachedCrates, ghCrates, type CratesFetcher } from "../verify/crates.ts";
import { regressionPath } from "../verify/plan.ts";
import { baseScopeRepos } from "../pilot.ts";
import { cloneTask, queueWarmBuild } from "../verify/tasks.ts";
import { outcomeOf } from "../verify/results.ts";
import type { Crate } from "../verify/types.ts";
import {
  FIX_RUN_BASE, FIX_ROUNDS, fixBranch, giveaway, parseFixReply, patchGiveaway, quietProblem, securityRepo,
  type SecurityFixCheckInput, type SecurityFixInput,
} from "./rules.ts";
import { advance, rawFinding, recordFixCall, scanRow } from "./store.ts";
import { usageRunId } from "./real.ts";

const SHA = /^[0-9a-f]{40}$/;
/** Refs of the local fix commits. They live in the bare cache only and are never a push source before Land. */
export const fixRef = (repo: string, n: number): string => `refs/autocraft/security/${repo}-${n}`;
const oneLine = (s: string, max = 300): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const ASK_STEPS = { fix: "security.fix", review: "security.fixcheck" } as const;

export type BuildRequest = { repo: string; sha: string; crate: string; patch: string; testPatch: string };
export type BuildVerdict = { ok: true; formatDiff: string | null } | { ok: false; reason: string };
export type FixDeps = {
  exec: Exec;
  /** Directory of the bare cache repositories. */
  root: string;
  fetchCrates: CratesFetcher;
  /** A read-only checkout of the commit for the sandboxed model calls, or null when none can be made. */
  checkout: (repo: string, branch: string, sha: string) => Promise<string | null>;
  /** One model call; `tool` is the build tool of the fix call. The reply text is null when the call gave none. */
  ask: (id: "security.fix" | "security.fixcheck", input: SecurityFixInput | SecurityFixCheckInput, o: { checkout?: string; tool?: CheckTool; agent: string; run: string }) => Promise<{ text: string | null; cost: number | null }>;
  /** Builds and tests the patch in the worker container, and the regression test alone on the pinned commit. */
  build: (db: DatabaseSync, r: BuildRequest, cancelled: () => boolean, log: (l: string) => void) => Promise<BuildVerdict>;
  who: () => Promise<{ login: string; email: string }>;
  cancelled: () => boolean;
  log: (line: string) => void;
};

/** The last part of the failing step's log of a finished task, for the next round's prompt. */
function failureTail(db: DatabaseSync, taskId: number, step: string): string {
  const rows = db.prepare("SELECT chunk FROM build_task_logs WHERE task_id = ? AND step = ? ORDER BY seq DESC LIMIT 40").all(taskId, step) as { chunk: string }[];
  return rows.reverse().map((r) => r.chunk).join("").slice(-2500);
}

/** The worker run of one round, as the Fix stage does it: the patch's crate tests, fmt and clippy; the regression test on the pinned commit must fail. */
export async function buildInWorker(db: DatabaseSync, r: BuildRequest, cancelled: () => boolean, log: (l: string) => void): Promise<BuildVerdict> {
  // Tasks need the real repo to fetch it. Their step name says nothing about what the patch is for, and they carry no item number.
  const queue = (): number[] => {
    const ids = tasksFor({ repo: r.repo, number: null, main_sha: r.sha, crate: r.crate }, r.patch, r.testPatch, "fix-check").map((t: NewTask) => createTask(db, t));
    // The warm build is a pipeline task: it would never be claimed for a repo outside the pipeline scope.
    if (baseScopeRepos(db).has(r.repo)) queueWarmBuild(db, r.repo, r.sha);
    return ids;
  };
  let ids: number[];
  try { ids = queue(); } catch (e) {
    if (e instanceof BuildError) return { ok: false, reason: `the build tasks were not queued: ${e.message}` };
    throw e;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const deadline = Date.now() + 2 * 3_600_000;
    for (;;) {
      const tasks = ids.map((id) => getTask(db, id));
      if (tasks.every((t) => t && TERMINAL.includes(t.state))) break;
      if (cancelled() || Date.now() > deadline) {
        for (const t of tasks) if (t && !TERMINAL.includes(t.state)) cancelTask(db, t.id, "security-fix");
        return { ok: false, reason: cancelled() ? "the fix was cancelled" : "the build tasks took too long" };
      }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    const head = getTask(db, ids[0]!)!, base = getTask(db, ids[1]!)!;
    const ho = outcomeOf(head), bo = outcomeOf(base);
    const lint = ho.kind === "pass" && bo.kind !== "error" && head.plan.some((st) => st.name === "clippy") ? readLint(db, head.id) : null;
    if (ho.kind === "error" || bo.kind === "error" || lint?.kind === "infra-failed") {
      const why = ho.kind === "error" ? ho.reason : bo.kind === "error" ? bo.reason : (lint as { reason: string }).reason;
      if (attempt === 0) { ids = [cloneTask(db, head.id), cloneTask(db, base.id)]; log(`  build environment error (${oneLine(why, 120)}); tasks queued again`); continue; }
      return { ok: false, reason: `build environment error: ${oneLine(why, 200)}` };
    }
    if (ho.kind === "fail") return { ok: false, reason: `with the fix, the ${ho.step} step ${ho.timedOut ? "timed out" : "failed"}:\n${failureTail(db, head.id, ho.step)}` };
    if (bo.kind === "pass") return { ok: false, reason: "the regression test passes without the fix, so it does not show the defect" };
    if (bo.kind === "fail" && (bo.step !== "test" || bo.timedOut)) return { ok: false, reason: bo.timedOut ? "the regression test timed out without the fix" : `the regression test did not build without the fix (${bo.step} failed)` };
    if (lint?.kind === "result" && lint.findings.length) return { ok: false, reason: `clippy findings on the lines the patch changes:\n${lint.findings.slice(0, 5).map((f) => f.rendered).join("\n")}`.slice(0, 1500) };
    return { ok: true, formatDiff: lint?.kind === "result" ? lint.formatDiff : null };
  }
  return { ok: false, reason: "the build did not finish" };
}

export function defaultFixDeps(db: DatabaseSync, scanId: number, io: { cancelled: () => boolean; log: (l: string) => void }): FixDeps {
  return {
    exec: realExec, root: fixupDir(), fetchCrates: ghCrates, build: buildInWorker, ...io,
    checkout: (repo, branch, sha) => checkoutForCommit(repo, branch, sha, io.log),
    who: async () => { const w = await whoAmI(realExec); return { login: w.login, email: w.email }; },
    ask: async (id, input, o) => {
      const before = (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM agent_runs").get() as { n: number }).n;
      const r = await runModelStep(db, textStep<typeof input>(id), input, { checkout: o.checkout, check: o.tool, cancelled: io.cancelled, usage: { run: o.run, agent: o.agent, stage: "security", items: (ok) => (ok ? 1 : 0) } });
      const spent = (db.prepare(`SELECT SUM(r.cost_usd) AS c FROM agent_runs r JOIN agent_run_items i ON i.run_id = r.id WHERE i.repo = ? AND i.number = ? AND r.id > ?`).get(input.repo, input.number, before) as { c: number | null }).c;
      return { text: r.ok ? r.value : null, cost: spent ?? r.usage.cost };
    },
  };
}

/** The crate that owns `path`: the one with the longest directory prefix. */
export function crateOf(crates: Crate[], path: string): Crate | null {
  let best: Crate | null = null;
  for (const c of crates) {
    const inside = c.dir === "." || c.dir === "" || path === c.dir || path.startsWith(`${c.dir}/`);
    if (inside && (!best || c.dir.length > best.dir.length)) best = c;
  }
  return best;
}

/** Puts the finding back where an operator can decide again, with the reason on it. */
function giveUp(db: DatabaseSync, repo: string, n: number, why: string, log: (l: string) => void): string {
  advance(db, repo, n, ["fixing"], "new", { note: oneLine(why, 400) });
  log(`${repo} finding ${n}: no fix: ${oneLine(why, 200)}`);
  return `finding ${n}: no fix: ${oneLine(why, 120)}`;
}

/**
 * Writes the private fix of finding `n` (state `fixing`, set by the API): rounds of model patch, wording check, worker
 * build and tests, and Opus review, up to FIX_ROUNDS. On success the finding is `ready` with the commit; otherwise it
 * returns to `new` with a note. Returns the job's summary line.
 */
export async function runFix(db: DatabaseSync, repo: string, n: number, d: FixDeps): Promise<string> {
  const row = rawFinding(db, repo, n);
  if (!row || row.state !== "fixing") return `finding ${n}: not fixing`;
  const { log } = d;
  try {
    const scan = scanRow(db, row.scan_id);
    const sha = scan?.commit_sha ?? "";
    if (!SHA.test(sha)) return giveUp(db, repo, n, "the scan has no pinned commit", log);
    const git = new Git(d.exec, d.root, repo);
    const branch = branchOf(db, repo);
    await git.init();
    if (!(await git.fetchBranch(ownerOf(repo), repo, branch, sha))) return giveUp(db, repo, n, "the pinned commit is no longer in the repository", log);
    const refs = JSON.parse(row.refs) as { path: string; line: number; claim: string }[];
    const cr = await cachedCrates(repo, sha, d.fetchCrates);
    if (!cr.ok) return giveUp(db, repo, n, `no crate list: ${cr.error}`, log);
    const crate = cr.rust ? crateOf(cr.crates, refs[0]?.path ?? "") : null;
    if (!crate || !/^[A-Za-z0-9_./-]+$/.test(crate.dir) || crate.dir.split("/").includes("..")) return giveUp(db, repo, n, "the fix step covers Rust crates only, and the finding is not in one", log);
    const listed = (await git.must(["ls-tree", "-r", "--name-only", sha, "--", crate.dir === "." ? "" : crate.dir].filter((x) => x !== ""))).split("\n").filter(Boolean);
    const allowed = listed.filter((p) => editable(p));
    const testPath = regressionPath(crate.dir);
    const verification = row.verification ? JSON.parse(row.verification) as { proposedTest?: string | null } : null;
    const checkout = (await d.checkout(repo, branch, sha)) ?? undefined;
    const base = { repo: securityRepo(repo), number: FIX_RUN_BASE + n, project: repo, commit: sha, ...(checkout && { repo_dir: REPO_PATH }) };
    const finding = { title: row.title, severity: row.severity, refs, reach: row.reach, impact: row.impact, area: row.area };
    const run = usageRunId(row.scan_id);
    let previous: SecurityFixInput["previous"];
    let lastWhy = "no round ran";
    for (let round = 1; round <= FIX_ROUNDS; round++) {
      if (d.cancelled()) return giveUp(db, repo, n, "the fix was cancelled", log);
      const failRound = (why: string, patch?: string): void => {
        lastWhy = why;
        previous = { patch: (patch ?? previous?.patch ?? "").slice(0, 60_000), failure: why };
        log(`${repo} finding ${n}: round ${round} failed: ${oneLine(why, 160)}`);
      };
      const input: SecurityFixInput = { ...base, finding, crate: { name: crate.name, dir: crate.dir }, test_path: testPath, proposed_test: verification?.proposedTest ?? null, ...(previous && { previous }) };
      const tool = new CheckTool({ db, step: "fix-check", repo, number: null, recordRepo: securityRepo(repo), head: sha, base: sha, applies: applyCheck(git, d.root, sha, (p) => refusal(validateFixPatch(p, allowed, testPath, crate.dir))) });
      const started = new Date().toISOString();
      let reply: Awaited<ReturnType<FixDeps["ask"]>>;
      try { reply = await d.ask(ASK_STEPS.fix, input, { checkout, tool, agent: `security-fix-${n}`, run }); } finally { tool.close(); }
      recordFixCall(db, row.scan_id, n, "fix", started, reply.text !== null, reply.cost);
      if (reply.text === null) { failRound("the model gave no answer"); continue; }
      const parsed = parseFixReply(reply.text);
      if (!parsed) { failRound("the reply did not follow the form: TITLE line, SUMMARY line, the marker line and the diff"); continue; }
      const quiet = quietProblem(parsed.title, parsed.summary) ?? (patchGiveaway(parsed.patch) ? `the diff adds the word "${patchGiveaway(parsed.patch)}"; name things for what the code does` : null);
      if (quiet) { failRound(quiet, parsed.patch); continue; }
      const v = validateFixPatch(parsed.patch, allowed, testPath, crate.dir);
      if (!v.ok) { failRound(v.reason, parsed.patch); continue; }
      const scratch = mkdtempSync(join(d.root, ".index-"));
      let applied;
      try { applied = await git.applyToTree(sha, v.patch, join(scratch, "index")); } finally { rmSync(scratch, { recursive: true, force: true }); }
      if (!applied.ok) { failRound(applied.reason, v.patch); continue; }
      const built = await d.build(db, { repo, sha, crate: crate.name, patch: v.patch, testPatch: v.testPatch }, d.cancelled, log);
      if (!built.ok) { failRound(built.reason, v.patch); continue; }
      let patch = v.patch, tree = applied.tree;
      // The formatter's whitespace-only changes ride in the same commit.
      if (built.formatDiff) {
        const fold = await foldFormat(git, sha, v.patch, built.formatDiff, d.root);
        if (!fold.ok) { failRound(`the formatter result was refused: ${fold.reason}`, v.patch); continue; }
        const scratch2 = mkdtempSync(join(d.root, ".index-"));
        try {
          const again = await git.applyToTree(sha, fold.patch, join(scratch2, "index"));
          if (!again.ok) { failRound(again.reason, v.patch); continue; }
          patch = fold.patch; tree = again.tree;
        } finally { rmSync(scratch2, { recursive: true, force: true }); }
      }
      if (patch.length > CHECK_PATCH_CAP) { failRound(`the patch is over the ${CHECK_PATCH_CAP} character limit for the review`, v.patch); continue; }
      const review = await reviewPatch(db, d, { ...base, finding: { title: row.title, refs, reach: row.reach, impact: row.impact }, patch, test_path: testPath }, { checkout, scanId: row.scan_id, n, run });
      if (!review.ok) { failRound(review.reason, v.patch); continue; }
      const who = await d.who();
      const files = [...v.files, testPath];
      const message = `${parsed.title}\n\n${parsed.summary}\n`;
      const worded = giveaway(message);
      if (worded) { failRound(`the commit message says "${worded}"; describe only what the code does now`, v.patch); continue; }
      const commit = await git.commit(tree, sha, message, { name: who.login, email: who.email });
      const changes = await git.rawChanges(sha, commit);
      const okFiles = new Set(files);
      if (changes.some((c) => !okFiles.has(c[3]!) || (c[2] === "A" ? c[1] !== "100644" : c[2] !== "M" || c[0] !== c[1]))) { failRound("the commit would change files or modes outside the validated diff", v.patch); continue; }
      await git.must(["update-ref", fixRef(repo, n), commit]);
      const moved = advance(db, repo, n, ["fixing"], "ready", {
        fix_commit: commit, fix_patch: patch, fix_title: parsed.title, fix_summary: parsed.summary, fix_branch: fixBranch(parsed.title, randomBytes(3).toString("hex")), fix_files: JSON.stringify(files), fix_ref: fixRef(repo, n), note: null,
      });
      return moved ? `${repo} finding ${n}: fix ready (${files.length} files, round ${round})` : `finding ${n}: left fixing while the fix was written`;
    }
    return giveUp(db, repo, n, lastWhy, log);
  } catch (e) {
    giveUp(db, repo, n, `the fix failed: ${(e as Error).message}`, log);
    throw e;
  }
}

/** Opus reviews the private diff; an approve lets the fix stand. */
async function reviewPatch(db: DatabaseSync, d: FixDeps, input: SecurityFixCheckInput, o: { checkout?: string; scanId: number; n: number; run: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const started = new Date().toISOString();
  const reply = await d.ask(ASK_STEPS.review, input, { checkout: o.checkout, agent: `security-review-${o.n}`, run: o.run });
  const parsed = reply.text === null ? null : parseCheck(reply.text);
  recordFixCall(db, o.scanId, o.n, "review", started, parsed?.ok === true, reply.cost);
  if (!parsed) return { ok: false, reason: "the patch review gave no answer" };
  if (!parsed.ok) return { ok: false, reason: `the patch review gave no valid answer: ${parsed.error}` };
  if (parsed.check.verdict === "reject") return { ok: false, reason: `Opus rejected the patch: ${parsed.check.reasons}${parsed.check.problems.length ? ` (${parsed.check.problems.join("; ")})` : ""}` };
  return { ok: true };
}
