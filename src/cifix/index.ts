// CI fix: a PR we want whose gate check failed at its reviewed head gets one of three things, by what the log says:
//   format  the formatter runs in a build environment (never on this host) and its diff is pushed; no model;
//   infra   the failed jobs are rerun once per head (the `cifix-rerun` step);
//   code    Sonnet writes a patch from the log and the PR's code, Opus checks it, then it is pushed.
// A branch we can't push to gets the patch as a comment where the repo allows comments. At most two tries per head.
// The log and the PR are untrusted data: nothing from them is run here, and a model only reads them.
//
//   autocraft cifix --repo R [--limit N] [--apply]
//   autocraft cifix-rerun --repo R [--limit N] [--apply]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { absolute } from "../build/artifacts.ts";
import { createTask, getTask, warmKeyOf } from "../build/tasks.ts";
import { askClaude } from "../classify/run.ts";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { Git, exec, fixupDir, type Exec } from "../fixup/git.ts";
import { DIFF_CAP, FILE_CAP, PR_QUERY, TOTAL_CAP, noteLive, scrubReason, whoAmI, type PrNode } from "../fixup/index.ts";
import { editable, validatePatch } from "../fixup/patch.ts";
import { longLivedOf, pushable, BASE_ORG } from "../fixup/pushable.ts";
import { HOLD_CANNOT_PUSH } from "../fixup/template.ts";
import { ghComment, ghRerunFailed, pushBranch, type Writer } from "../github/write.ts";
import { Client, type Querier } from "../mirror.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { selectCifix, type CifixCandidate } from "./candidates.ts";
import { guardPatch, TEST_PATH } from "./guard.ts";
import { readFailure } from "./logs.ts";
import { askText, commentText, commitMessage } from "./template.ts";
import { triage } from "./triage.ts";
import type { CiFailure, CifixPr } from "./types.ts";

export { selectCifix, classifyCifix, MAX_TRIES, type CifixCandidate } from "./candidates.ts";

const ORG = BASE_ORG;
const ACTOR = "cifix";
const RERUN_ACTOR = "cifix-rerun";
const PROMPT = CLAUDE_PROMPTS["cifix.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
/** Files shown to the patch model. */
const MAX_FILES = 8;
/** Characters of the failure log the Opus check sees. */
const CHECK_LOG_CAP = 8000;

/**
 * The formatter step. /src is a writable overlay inside the step, so the formatted copy is made beside an untouched
 * copy and the unified diff of the two goes to /out. No artifact means nothing to format.
 */
export const FORMAT_SCRIPT = [
  "set -e", "mkdir -p /tmp/w", "cp -a /src /tmp/w/a", "cp -a /src /tmp/w/b", "cd /tmp/w/b", "cargo fmt --all", "cd /tmp/w",
  "diff -ruN --exclude=target --exclude=.git a b > /tmp/w/format.txt || true",
  "if [ -s /tmp/w/format.txt ]; then cp /tmp/w/format.txt /out/format.txt; fi",
].join("; ");
export const FORMAT_ARTIFACT = "format.txt";

export type CifixDeps = {
  querier: Querier;
  /** Every git and gh write command. */
  exec: Exec;
  fetchDiff: DiffFetcher;
  /** Reads from GitHub (`gh` arguments): the failed check runs and their logs. */
  gh: Gh;
  /** The model's reply to the cifix.patch prompt, or null when it gave none. */
  ask: (db: DatabaseSync, input: CifixPr[], checkout?: string) => Promise<string | null>;
  /** The model's reply to the fixup.check prompt (Opus), or null when it gave none. */
  check: (db: DatabaseSync, input: FixupCheckInput[], checkout?: string) => Promise<string | null>;
  /** Host directory with a read-only checkout of the PR head for the sandboxed model calls, or null to ask without tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
};

export function defaultDeps(): CifixDeps {
  return {
    querier: new Client(1000), exec, fetchDiff: ghDiff, gh: ghExec, now: () => new Date(), root: fixupDir(),
    ask: async (db, input, checkout) => (await askClaude("cifix.patch", PROMPT.models[0]!, input, db, { checkout }))?.text ?? null,
    check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
    checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
  };
}

export type CifixParams = { repo: string; limit?: number; /** Default true. */ dryRun?: boolean; onHandled?: (n: number) => void };
export type CifixSummary = {
  runId: string; repo: string; dryRun: boolean;
  pushed: string[]; asked: string[]; queued: string[]; infra: string[];
  failed: { ref: string; reason: string }[]; held: { ref: string; reason: string }[];
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** The formatter's `diff -ruN a b` output as a git-format diff, which validatePatch and `git apply` read. */
export function gitFormatDiff(text: string): string {
  return text.split("\n").map((l) => {
    const m = /^diff .* a\/(\S+) b\/(\S+)$/.exec(l);
    if (m) return `diff --git a/${m[1]} b/${m[2]}`;
    return l.startsWith("--- ") || l.startsWith("+++ ") ? l.replace(/\t.*$/, "") : l;
  }).join("\n");
}

const DIFF_FILE = /^diff --git a\/(\S+) b\/\S+$/gm;
const LOG_FILE = /(?:-->|panicked at|\bat)\s+([\w./-]+\.rs):\d+/g;

type Fix = { patch: string; files: string[]; changed: number };

class Recorder {
  private db: DatabaseSync;
  private at: () => string;
  constructor(db: DatabaseSync, at: () => string) {
    this.db = db;
    this.at = at;
  }

  /**
   * One ci_fixes row. A formatter run keeps its `formatting` row and the result replaces its state. Every outcome
   * but the waiting states also notes the PR's stage, so the item page and the queue say what happened.
   */
  set(c: CifixCandidate, kind: "format" | "code" | "infra", state: string, reason: string | null, o: { files?: string[]; toHead?: string | null; task?: number | null; runs?: number[] } = {}): void {
    const at = this.at();
    const files = JSON.stringify(o.files ?? []);
    const open = this.db.prepare("SELECT rowid AS id FROM ci_fixes WHERE repo = ? AND number = ? AND head = ? AND state = 'formatting'").get(c.repo, c.number, c.head) as { id: number } | undefined;
    if (open && state !== "formatting") {
      this.db.prepare("UPDATE ci_fixes SET state = ?, reason = ?, files = ?, to_head = ? WHERE rowid = ?").run(state, reason, files, o.toHead ?? null, open.id);
    } else {
      this.db.prepare("INSERT INTO ci_fixes (repo, number, head, to_head, kind, state, reason, files, attempt, task_id, runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.repo, c.number, c.head, o.toHead ?? null, kind, state, reason, files, c.attempt, o.task ?? null, o.runs ? JSON.stringify(o.runs) : null, at);
    }
    if (state === "infra" || state === "formatting" || state === "rerun") return;
    const note = state === "pushed" ? `CI fix pushed at ${short(c.head)}: ${(o.files ?? []).join(", ")}`
      : state === "asked" ? `posted a CI fix at ${short(c.head)}: ${(o.files ?? []).join(", ")}` : `CI fix ${state} at ${short(c.head)}: ${reason}`;
    this.db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)").run(c.repo, c.number, "take", at, ACTOR, note);
  }
}

/** The failure text the models and the check see: every failed step's tail, with its check and step names. */
function logText(f: CiFailure): CifixPr["failure"] {
  return f.checks.map((c) => ({ check: c.name, steps: c.steps.map((s) => ({ job: s.job, step: s.step, log: s.tail })) }));
}

export async function runCifix(db: DatabaseSync, params: CifixParams, log: (line: string) => void = console.log, deps?: CifixDeps): Promise<CifixSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `cifix-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const summary: CifixSummary = { runId, repo, dryRun, pushed: [], asked: [], queued: [], infra: [], failed: [], held: [] };
  const sel = selectCifix(db, repo);
  const collect = params.limit === undefined ? sel.collect : sel.collect.slice(0, params.limit);
  const work = params.limit === undefined ? sel.work : sel.work.slice(0, Math.max(0, params.limit - collect.length));
  log(`cifix ${repo}: ${sel.work.length} PRs with a failing check to read, ${sel.collect.length} formatter results to apply, ${sel.rerun.length} reruns due`);
  if (dryRun) {
    for (const x of collect) log(`  would apply the formatter result for ${refOf(x.c)} at ${short(x.c.head)}`);
    for (const c of work) log(`  would read the failure of ${refOf(c)} at ${short(c.head)} (try ${c.attempt}, ${c.route})`);
    log(`cifix ${repo}: dry run, nothing called or written`);
    return summary;
  }
  const d = deps ?? defaultDeps();
  const rec = new Recorder(db, at);
  const gw: Writer = { db, login: ACTOR };
  const git = new Git(d.exec, d.root, repo);
  const approved = pushApprovalOf(db, repo) !== null;
  const commenting = commentApprovalOf(db, repo) !== null;
  let whoP: ReturnType<typeof whoAmI> | undefined;
  let handled = 0;

  const readPr = async (c: CifixCandidate): Promise<PrNode | null> => {
    const r = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
    const pr = r.repository?.pullRequest;
    noteLive(db, repo, c.number, pr, at());
    if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${refOf(c)}: skipped: no longer an open, non-draft PR`); return null; }
    if (pr.headRefOid !== c.head) { log(`  ${refOf(c)}: skipped: head moved to ${short(pr.headRefOid)} since the checks ran`); return null; }
    return pr;
  };

  /** Applies a validated patch to the PR head: pushed to the branch, or posted as a comment where the branch is closed to us. */
  const deliver = async (c: CifixCandidate, kind: "format" | "code", pr: PrNode, v: Fix, checkName: string, check?: (patch: string) => Promise<string | null>): Promise<void> => {
    const ref = refOf(c);
    const fail = (state: "failed" | "refused" | "rejected", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.set(c, kind, state, reason, { files: v.files });
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    const canPush = !!pr.headRepository && pushable(pr.headRepository.nameWithOwner, repo, pr.maintainerCanModify, pr.headRefName, longLivedOf(db, repo), !!pr.headRef?.branchProtectionRule);
    if (canPush ? !approved : !commenting) {
      const reason = canPush ? "pushing is not approved for this repo" : HOLD_CANNOT_PUSH;
      rec.set(c, kind, "cannot-push", reason, { files: v.files });
      summary.held.push({ ref, reason });
      log(`  ${ref}: held: ${reason}`);
      return;
    }
    const head = await git.fetchPr(ORG, repo, c.number);
    if (head !== c.head) { log(`  ${ref}: skipped: fetched head ${short(head)} is not the checked ${short(c.head)}`); return; }
    const scratch = mkdtempSync(join(d.root, ".index-"));
    let applied;
    try {
      applied = await git.applyToTree(head, v.patch, join(scratch, "index"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!applied.ok) { fail("refused", applied.reason); return; }
    if (check) {
      const refusal = await check(v.patch);
      if (refusal !== null) { fail(refusal.startsWith("rejected:") ? "rejected" : "failed", refusal.replace(/^rejected: /, "")); return; }
    }
    // The model calls took minutes: read the PR again before writing.
    const now = await readPr(c);
    if (!now) return;
    if (!canPush) {
      const cm = await ghComment(gw, d.exec, "cifix-comment", { repo, number: c.number, pr: true }, askText(checkName, v.patch), { run: runId, head: c.head });
      if (cm.code !== 0) { log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`); return; }
      rec.set(c, kind, "asked", null, { files: v.files });
      summary.asked.push(ref);
      log(`  ${ref}: posted the patch as a comment at ${short(c.head)}`);
      return;
    }
    const who = await (whoP ??= whoAmI(d.exec));
    const commit = await git.commit(applied.tree, head, commitMessage(kind, v.files), { name: who.login, email: who.email });
    const changes = await git.rawChanges(head, commit);
    const touched = changes.map((x) => x[3]!).sort().join("\n");
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n")) {
      fail("refused", "the commit would change files or modes outside the validated diff");
      return;
    }
    const push = await pushBranch(gw, git, "cifix-push", { repo, number: c.number, remote: pr.headRepository!.nameWithOwner, branch: pr.headRefName, sha: commit, expected: head }, { run: runId, from: head, to: commit, files: v.files, changed: v.changed, kind });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/stale info|rejected|fetch first/i.test(err)) fail("refused", "the branch moved since the checks ran");
      else if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) {
        rec.set(c, kind, "push-denied", HOLD_CANNOT_PUSH, { files: v.files });
        summary.held.push({ ref, reason: HOLD_CANNOT_PUSH });
        log(`  ${ref}: held: ${HOLD_CANNOT_PUSH}`);
      } else fail("failed", `push failed: ${err}`);
      return;
    }
    rec.set(c, kind, "pushed", null, { files: v.files, toHead: commit });
    summary.pushed.push(ref);
    log(`  ${ref}: pushed ${short(commit)} on ${short(head)}: ${v.files.join(", ")}`);
    const cm = await ghComment(gw, d.exec, "cifix-comment", { repo, number: c.number, pr: true }, commentText(v.files), { run: runId });
    if (cm.code !== 0) log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
  };

  /** The formatter task ended: its diff, if any, is validated and delivered. */
  const collectFormat = async (c: CifixCandidate, taskId: number): Promise<void> => {
    const ref = refOf(c);
    const t = getTask(db, taskId);
    const fail = (reason: string) => { rec.set(c, "format", "failed", reason); summary.failed.push({ ref, reason }); log(`  ${ref}: failed: ${reason}`); };
    if (!t || t.state !== "done") { fail(`the formatter task ${t?.state ?? "is gone"}`); return; }
    const art = db.prepare("SELECT file FROM build_artifacts WHERE task_id = ? AND name = ?").get(taskId, FORMAT_ARTIFACT) as { file: string } | undefined;
    const path = art ? absolute(art.file) : null;
    if (!path) { fail("the formatter changed nothing, so the failure is not formatting"); return; }
    const text = gitFormatDiff(readFileSync(path, "utf8"));
    const v = validatePatch(text, [...text.matchAll(DIFF_FILE)].map((m) => m[1]!));
    if (!v.ok) { fail(v.reason); return; }
    const pr = await readPr(c);
    if (!pr) return;
    params.onHandled?.(++handled);
    await deliver(c, "format", pr, v, "format", undefined);
  };

  /** Sonnet patches the code from the log, Opus checks the patch. */
  const fixCode = async (c: CifixCandidate, pr: PrNode, failure: CiFailure): Promise<void> => {
    const ref = refOf(c);
    const fail = (state: "failed" | "refused", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.set(c, "code", state, reason);
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    const head = await git.fetchPr(ORG, repo, c.number);
    if (head !== c.head) { log(`  ${ref}: skipped: fetched head ${short(head)} is not the checked ${short(c.head)}`); return; }
    const diff = await cachedDiff(repo, c.number, head, d.fetchDiff);
    if (!diff.ok) { fail("failed", `no diff: ${oneLine(diff.error)}`); return; }
    if (diff.text.length > DIFF_CAP) { fail("failed", `the PR diff is over the ${DIFF_CAP} character limit`); return; }
    const text = failure.checks.flatMap((x) => x.steps.map((s) => s.tail)).join("\n");
    // Files the log names come first, then the files the PR changes. Test files are not editable by a CI fix.
    const named = [...new Set([...text.matchAll(LOG_FILE)].map((m) => m[1]!).concat([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!)))]
      .filter((p) => editable(p) && !TEST_PATH.test(p)).slice(0, MAX_FILES);
    const shown: CifixPr["files"] = [];
    let total = 0;
    for (const path of named) {
      const f = await git.file(head, path);
      if (!f.ok) continue;
      total += f.content.length;
      if (f.content.length > FILE_CAP || total > TOTAL_CAP) { fail("failed", "the files the failure names are over the size limit"); return; }
      shown.push({ path, content: f.content });
    }
    if (!shown.length) { fail("failed", "the failure names no file a CI fix may edit"); return; }
    const title = ((db.prepare("SELECT title FROM items WHERE repo = ? AND number = ?").get(repo, c.number) as { title: string | null } | undefined)?.title ?? "").slice(0, 300);
    const checkout = (await d.checkout?.(repo, c.number, head)) ?? undefined;
    const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
    const reply = await d.ask(db, [{ ref, title, failure: logText(failure), files: shown, diff: diff.text, ...repoDir }], checkout);
    if (reply === null) { fail("failed", "the model gave no answer"); return; }
    const v = validatePatch(reply, shown.map((s) => s.path));
    if (!v.ok) { fail("refused", v.reason); return; }
    const guard = guardPatch(v.patch, v.files);
    if (guard) { fail("refused", guard); return; }
    if (v.patch.length > CHECK_PATCH_CAP) { fail("refused", `the patch is over the ${CHECK_PATCH_CAP} character limit for the check`); return; }
    const names = failure.checks.map((x) => x.name);
    const check = async (patch: string): Promise<string | null> => {
      const input: FixupCheckInput = {
        ref, title, fixes: [], diff: diff.text.slice(0, CHECK_DIFF_CAP), patch, ...repoDir,
        review_reason: `The check ${names.join(", ")} fails at this head. The patch must make it pass without changing what the pull request does.`,
        ci_failure: { checks: names, log: JSON.stringify(logText(failure)).slice(0, CHECK_LOG_CAP) },
      };
      const reply2 = await d.check(db, [input], checkout);
      if (reply2 === null) return "the patch check gave no answer";
      const verdict = parseCheck(reply2);
      if (!verdict.ok) return `the patch check gave no valid answer: ${verdict.error}`;
      recordCheck(db, { kind: "fixup", repo, number: c.number, subject: head, patch, round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: at() });
      audit(db, ACTOR, "cifix-check", ref, { run: runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons });
      return verdict.check.verdict === "reject" ? `rejected: Opus rejected the patch: ${checkLine(verdict.check)}` : null;
    };
    await deliver(c, "code", pr, v, names[0] ?? "CI", check);
  };

  const workOne = async (c: CifixCandidate): Promise<void> => {
    const ref = refOf(c);
    try {
      const pr = await readPr(c);
      if (!pr) return;
      params.onHandled?.(++handled);
      const failure = await readFailure(d.gh, repo, c.head);
      if (!failure) { rec.set(c, "code", "failed", "no failed check run at the head"); summary.failed.push({ ref, reason: "no failed check run at the head" }); return; }
      const t = triage(failure);
      log(`  ${ref}: ${t.kind}: ${t.why}`);
      if (t.kind === "unreadable") { rec.set(c, "code", "failed", t.why); summary.failed.push({ ref, reason: t.why }); return; }
      if (t.kind === "infra") {
        if (c.rerun) {
          const reason = "the failure looks like an infrastructure error again after the rerun";
          rec.set(c, "infra", "failed", reason);
          summary.failed.push({ ref, reason });
          return;
        }
        rec.set(c, "infra", "infra", t.why, { runs: [...new Set(failure.checks.flatMap((x) => (x.runId === null ? [] : [x.runId])))] });
        summary.infra.push(ref);
        return;
      }
      if (t.kind === "format") {
        const id = createTask(db, {
          step: "cifix", repo, number: c.number, headSha: c.head, requires: { os: "linux", toolchains: ["rust-stable"] }, warm: { key: warmKeyOf(repo), role: "use" },
          plan: [{ name: "format", cmd: ["sh", "-c", FORMAT_SCRIPT], network: "none", timeoutSec: 600, artifacts: [FORMAT_ARTIFACT] }],
        });
        rec.set(c, "format", "formatting", null, { task: id });
        summary.queued.push(ref);
        log(`  ${ref}: formatter task ${id} queued`);
        return;
      }
      await fixCode(c, pr, failure);
    } catch (e) {
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      rec.set(c, "code", "failed", reason);
      summary.failed.push({ ref, reason });
      log(`  ${ref}: failed: ${reason}`);
    }
  };

  if (collect.length || work.length) mkdirSync(d.root, { recursive: true });
  for (const x of collect) {
    try { await collectFormat(x.c, x.task); }
    catch (e) {
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      rec.set(x.c, "format", "failed", reason);
      summary.failed.push({ ref: refOf(x.c), reason });
    }
  }
  for (const c of work) await workOne(c);
  log(`cifix ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} commented, ${summary.queued.length} formatter runs queued, ${summary.infra.length} infra, ${summary.failed.length} failed, ${summary.held.length} held; run ${runId}`);
  return summary;
}

export type RerunSummary = { repo: string; reran: string[]; skipped: string[] };

/** Reruns the failed jobs of every PR whose failure was triaged as infrastructure: once per head. */
export async function runRerun(db: DatabaseSync, params: CifixParams, log: (line: string) => void = console.log, deps?: Pick<CifixDeps, "querier" | "exec" | "now">): Promise<RerunSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  const out: RerunSummary = { repo, reran: [], skipped: [] };
  const due = selectCifix(db, repo).rerun;
  const picks = params.limit === undefined ? due : due.slice(0, params.limit);
  log(`cifix-rerun ${repo}: ${due.length} heads due a rerun`);
  if (dryRun) {
    for (const x of picks) log(`  would rerun the failed jobs of ${refOf(x.c)} at ${short(x.c.head)}`);
    return out;
  }
  const d = deps ?? defaultDeps();
  const w: Writer = { db, login: RERUN_ACTOR };
  let n = 0;
  for (const { c, runs } of picks) {
    const ref = refOf(c);
    try {
      const r = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      noteLive(db, repo, c.number, pr, d.now().toISOString());
      if (!pr || pr.state !== "OPEN" || pr.isDraft || pr.headRefOid !== c.head) { log(`  ${ref}: skipped: closed, a draft or at another head`); out.skipped.push(ref); continue; }
      params.onHandled?.(++n);
      const errors: string[] = [];
      for (const run of runs) {
        const res = await ghRerunFailed(w, d.exec, { repo, number: c.number, runId: run }, { head: c.head });
        if (res.code !== 0) errors.push(oneLine(res.stderr || res.stdout));
      }
      // One rerun per head, whether or not GitHub took every run.
      db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, reason, files, attempt, runs, created_at) VALUES (?, ?, ?, 'infra', 'rerun', ?, '[]', 0, ?, ?)")
        .run(repo, c.number, c.head, errors.length ? errors[0]!.slice(0, 200) : null, JSON.stringify(runs), d.now().toISOString());
      out.reran.push(ref);
      log(`  ${ref}: reran ${runs.length} runs${errors.length ? ` (${errors.length} refused)` : ""}`);
    } catch (e) {
      log(`  ${ref}: not rerun: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  return out;
}

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
  cifix: {
    summary: "cifix --repo R [--limit N] [--apply]: read the failing gate check of taken PRs and fix it (formatter run, patch checked by Opus, or the patch as a comment); dry run unless --apply",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runCifix(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "cifix-rerun": {
    summary: "cifix-rerun --repo R [--limit N] [--apply]: rerun the failed jobs once per head where the failure looks like an infrastructure error; dry run unless --apply",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runRerun(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
};
