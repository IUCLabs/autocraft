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
import { outsideShown, shownSize, viewFile } from "../fixup/excerpt.ts";
import { editable, validatePatch } from "../fixup/patch.ts";
import { readGate } from "../merge/changes-requested.ts";
import { longLivedOf, pushable, BASE_ORG } from "../fixup/pushable.ts";
import { HOLD_CANNOT_PUSH } from "../fixup/template.ts";
import { ghComment, ghRerunFailed, pushBranch, type Note, type Writer } from "../github/write.ts";
import { Client, type Querier } from "../mirror.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { MAX_PUSHES_PER_PR, MAX_TRIES_PER_PR, selectCifix, type CifixCandidate } from "./candidates.ts";
import { formattingOnly, guardPatch, TEST_PATH } from "./guard.ts";
import { readFailure } from "./logs.ts";
import { askText, commentText, commitMessage } from "./template.ts";
import { formatDiffPaths, matchPrFiles, triage } from "./triage.ts";
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
/** How long a rerun gets to produce new check results before the PR is given up on. */
const RERUN_WAIT_MS = 2 * 3600_000;

/**
 * The formatter step. /src is a writable overlay inside the step, so the formatted copy is made beside an untouched
 * copy and the unified diff of the two goes to /out. No artifact means nothing to format.
 */
/** Where the build image keeps its Rust toolchain. */
export const IMAGE_CARGO = "/usr/local/cargo";
export const IMAGE_RUSTUP = "/usr/local/rustup";
export const FORMAT_SCRIPT = [
  // `set -f`: the file list is never glob-expanded.
  "set -e", "set -f", "mkdir -p /tmp/w", "cp -a /src /tmp/w/a", "cp -a /src /tmp/w/b", "cd /tmp/w",
  // The PR controls `.cargo/config.toml` (aliases) and `rust-toolchain.toml`: the image's rustfmt runs on the named files
  // directly, by absolute path, from outside the checkout, under an empty environment with the toolchain paths fixed.
  'files="$*"', "set --", 'for f in $files; do set -- "$@" "b/$f"; done',
  `env -i PATH=${IMAGE_CARGO}/bin:/usr/bin:/bin HOME=/tmp RUSTUP_HOME=${IMAGE_RUSTUP} CARGO_HOME=${IMAGE_CARGO} ${IMAGE_CARGO}/bin/rustfmt --edition 2021 "$@"`,
  ": > /tmp/w/format.txt",
  'for f in $files; do if ! cmp -s "a/$f" "b/$f"; then echo "diff -uN a/$f b/$f" >> /tmp/w/format.txt; diff -uN "a/$f" "b/$f" >> /tmp/w/format.txt || true; fi; done',
  "if [ -s /tmp/w/format.txt ]; then cp /tmp/w/format.txt /out/format.txt; fi",
].join("; ");
/** The most files one formatter run names. */
const FORMAT_FILES_MAX = 20;
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

/** The note for a comment about a model-written patch. */
const codeNote: Note = { by: "model", kind: "comment", model: PROMPT.models[0] };

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
  pushed: string[]; asked: string[]; queued: string[]; infra: string[]; skipped: string[];
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
const LOCATION = /^\s*--> ([\w./-]+\.rs):\d+/;
const ERROR_LINE = /^\s*error(\[E\d+\])?: /;

/** Files named on the compiler location line (`--> path:line`) directly after an `error` line. The log is untrusted, so no other mention counts. */
export function errorFiles(log: string): string[] {
  const lines = log.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === 0 || !ERROR_LINE.test(lines[i - 1]!)) return;
    const m = LOCATION.exec(l);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  });
  return out;
}

type Fix = { patch: string; files: string[]; changed: number };

class Recorder {
  private db: DatabaseSync;
  private at: () => string;
  constructor(db: DatabaseSync, at: () => string) {
    this.db = db;
    this.at = at;
  }

  private open(c: CifixCandidate): { id: number } | undefined {
    return this.db.prepare("SELECT rowid AS id FROM ci_fixes WHERE repo = ? AND number = ? AND head = ? AND state IN ('formatting', 'pushing') ORDER BY rowid DESC").get(c.repo, c.number, c.head) as { id: number } | undefined;
  }

  /** Written before the push: the commit about to be pushed, so a crash between the push and its record leaves the head in the push chain. */
  pushing(c: CifixCandidate, kind: "format" | "code", commit: string, files: string[]): void {
    const open = this.open(c);
    if (open) this.db.prepare("UPDATE ci_fixes SET state = 'pushing', to_head = ?, files = ? WHERE rowid = ?").run(commit, JSON.stringify(files), open.id);
    else {
      this.db.prepare("INSERT INTO ci_fixes (repo, number, head, to_head, kind, state, reason, files, attempt, created_at) VALUES (?, ?, ?, ?, ?, 'pushing', NULL, ?, ?, ?)")
        .run(c.repo, c.number, c.head, commit, kind, JSON.stringify(files), c.attempt, this.at());
    }
  }

  /**
   * One ci_fixes row. A formatter run keeps its `formatting` row and the result replaces its state. Every outcome
   * but the waiting states also notes the PR's stage, so the item page and the queue say what happened.
   */
  set(c: CifixCandidate, kind: "format" | "code" | "infra", state: string, reason: string | null, o: { files?: string[]; toHead?: string | null; task?: number | null; runs?: number[] } = {}): void {
    const at = this.at();
    const files = JSON.stringify(o.files ?? []);
    const open = this.open(c);
    if (open && state !== "formatting") {
      this.db.prepare("UPDATE ci_fixes SET state = ?, reason = ?, files = ?, to_head = ? WHERE rowid = ?").run(state, reason, files, o.toHead ?? null, open.id);
    } else {
      this.db.prepare("INSERT INTO ci_fixes (repo, number, head, to_head, kind, state, reason, files, attempt, task_id, runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.repo, c.number, c.head, o.toHead ?? null, kind, state, reason, files, c.attempt, o.task ?? null, o.runs ? JSON.stringify(o.runs) : null, at);
    }
    if (state === "infra" || state === "formatting" || state === "rerun" || state === "rerunning") return;
    const note = state === "pushed" ? `CI fix pushed at ${short(c.head)}: ${(o.files ?? []).join(", ")}`
      : state === "skipped" ? `CI fix skipped at ${short(c.head)}: ${reason}`
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
  const summary: CifixSummary = { runId, repo, dryRun, pushed: [], asked: [], queued: [], infra: [], skipped: [], failed: [], held: [] };
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

  /** Why the last `readPr` returned null. */
  let gone = "";
  const readPr = async (c: CifixCandidate): Promise<PrNode | null> => {
    const r = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
    const pr = r.repository?.pullRequest;
    noteLive(db, repo, c.number, pr, at());
    if (!pr || pr.state !== "OPEN" || pr.isDraft) { gone = "no longer an open, non-draft PR"; log(`  ${refOf(c)}: skipped: ${gone}`); return null; }
    if (pr.headRefOid !== c.head) { gone = `head moved to ${short(pr.headRefOid)} since the checks ran`; log(`  ${refOf(c)}: skipped: ${gone}`); return null; }
    return pr;
  };

  /** The content at `head` of each file, or the reason one cannot be read. */
  const headFiles = async (head: string, files: string[]): Promise<Map<string, string> | string> => {
    const out = new Map<string, string>();
    for (const f of files) {
      const r = await git.file(head, f);
      if (!r.ok) return r.reason;
      out.set(f, r.content);
    }
    return out;
  };

  /** Applies a validated patch to the PR head: pushed to the branch, or posted as a comment where the branch is closed to us. */
  const deliver = async (c: CifixCandidate, kind: "format" | "code", pr: PrNode, v: Fix, checkName: string, check?: (patch: string) => Promise<string | null>, shown: CifixPr["files"] = []): Promise<void> => {
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
    if (head !== c.head) {
      noteLive(db, repo, c.number, { ...pr, headRefOid: head }, at());
      fail("failed", `fetched head ${short(head)} is not the checked ${short(c.head)}`);
      return;
    }
    if (kind === "format") {
      // Formatting alone, whatever produced the diff: whitespace-only per hunk, and the same limits as any patch.
      const heads = await headFiles(head, v.files);
      const guard = typeof heads === "string" ? heads : guardPatch(v.patch, v.files, heads);
      if (guard) { fail("refused", guard); return; }
    }
    const scratch = mkdtempSync(join(d.root, ".index-"));
    let applied;
    try {
      applied = await git.applyToTree(head, v.patch, join(scratch, "index"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!applied.ok) { fail("refused", applied.reason); return; }
    if (kind === "format") {
      // Formatting alone, by tokens, on the whole files before and after.
      for (const f of v.files) {
        const before = await git.file(head, f), after = await git.file(applied.tree, f);
        const why = !before.ok ? before.reason : !after.ok ? after.reason : formattingOnly(f, before.content, after.content);
        if (why) { fail("refused", why); return; }
      }
    }
    if (check) {
      const refusal = await check(v.patch);
      if (refusal !== null) { fail(refusal.startsWith("rejected:") ? "rejected" : "failed", refusal.replace(/^rejected: /, "")); return; }
    }
    // The model calls took minutes: read the PR again before writing.
    const now = await readPr(c);
    if (!now) { fail("failed", gone); return; }
    // A maintainer's changes request may have come in during the model calls; an unreadable answer counts as blocked.
    const blocked = await readGate(db, d.querier, ORG, repo, c.number, log);
    if (blocked !== null) {
      const reason = blocked ?? "the PR's reviews could not be read";
      rec.set(c, kind, "skipped", reason, { files: v.files });
      summary.skipped.push(ref);
      log(`  ${ref}: skipped: ${reason}`);
      return;
    }
    if (!canPush) {
      const cm = await ghComment(gw, d.exec, "cifix-comment", { repo, number: c.number, pr: true }, codeNote, askText(checkName, v.patch), { run: runId, head: c.head });
      if (cm.code !== 0) {
        const reason = `the comment failed: ${scrubReason(oneLine(cm.stderr), d.root)}`;
        rec.set(c, kind, "comment-failed", reason, { files: v.files });
        summary.failed.push({ ref, reason });
        log(`  ${ref}: ${reason}`);
        return;
      }
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
    const outside = outsideShown(shown, await git.diffText(head, commit));
    if (outside) { fail("refused", outside); return; }
    rec.pushing(c, kind, commit, v.files);
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
    const cm = await ghComment(gw, d.exec, "cifix-comment", { repo, number: c.number, pr: true }, kind === "format" ? { by: "fixed" } : codeNote, commentText(v.files), { run: runId });
    if (cm.code !== 0) log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
  };

  /** The formatter task ended: its diff, if any, is validated and delivered. Every exit records a state, which closes the `formatting` row. */
  const collectFormat = async (c: CifixCandidate, taskId: number): Promise<void> => {
    const ref = refOf(c);
    const t = getTask(db, taskId);
    const fail = (state: "failed" | "refused", reason: string) => { rec.set(c, "format", state, reason); summary.failed.push({ ref, reason }); log(`  ${ref}: ${state}: ${reason}`); };
    if (!t || t.state !== "done") { fail("failed", `the formatter task ${t?.state ?? "is gone"}`); return; }
    // The files the formatter was told to format: the PR's files that the log's `Diff in` lines name.
    const row = db.prepare("SELECT files FROM ci_fixes WHERE repo = ? AND number = ? AND head = ? AND state = 'formatting'").get(c.repo, c.number, c.head) as { files: string | null } | undefined;
    const allowed = JSON.parse(row?.files ?? "[]") as string[];
    const art = db.prepare("SELECT file FROM build_artifacts WHERE task_id = ? AND name = ?").get(taskId, FORMAT_ARTIFACT) as { file: string } | undefined;
    const path = art ? absolute(art.file) : null;
    if (!path) { fail("failed", "the formatter changed nothing, so the failure is not formatting"); return; }
    const text = gitFormatDiff(readFileSync(path, "utf8"));
    const v = validatePatch(text, allowed);
    if (!v.ok) { fail("refused", v.reason); return; }
    const pr = await readPr(c);
    if (!pr) { fail("failed", gone); return; }
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
    if (head !== c.head) { noteLive(db, repo, c.number, { ...pr, headRefOid: head }, at()); fail("failed", `fetched head ${short(head)} is not the checked ${short(c.head)}`); return; }
    const diff = await cachedDiff(repo, c.number, head, d.fetchDiff);
    if (!diff.ok) { fail("failed", `no diff: ${oneLine(diff.error)}`); return; }
    if (diff.text.length > DIFF_CAP) { fail("failed", `the PR diff is over the ${DIFF_CAP} character limit`); return; }
    const text = failure.checks.flatMap((x) => x.steps.map((s) => s.tail)).join("\n");
    // Files a compiler error points at come first, then the files the PR changes; nothing else is editable. Test files are not editable by a CI fix.
    const named = [...new Set(errorFiles(text).concat([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!)))]
      .filter((p) => editable(p) && !TEST_PATH.test(p)).slice(0, MAX_FILES);
    const shown: CifixPr["files"] = [];
    // The guard reads whole files even when the model sees only parts.
    const contents = new Map<string, string>();
    let total = 0;
    for (const path of named) {
      const f = await git.file(head, path);
      if (!f.ok) continue;
      // The log lines that mention the file give the lines a large file is cut around.
      const v = viewFile(path, f.content, text.split("\n").filter((l) => l.includes(path)), diff.text, FILE_CAP);
      if (!v.ok) { fail("failed", v.reason); return; }
      total += shownSize(v.file);
      if (total > TOTAL_CAP) { fail("failed", "the parts of the files the failure names are over the size limit"); return; }
      shown.push(v.file);
      contents.set(path, f.content);
    }
    if (!shown.length) { fail("failed", "the failure names no file a CI fix may edit"); return; }
    const title = ((db.prepare("SELECT title FROM items WHERE repo = ? AND number = ?").get(repo, c.number) as { title: string | null } | undefined)?.title ?? "").slice(0, 300);
    const checkout = (await d.checkout?.(repo, c.number, head)) ?? undefined;
    const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
    const reply = await d.ask(db, [{ ref, title, failure: logText(failure), files: shown, diff: diff.text, ...repoDir }], checkout);
    if (reply === null) { fail("failed", "the model gave no answer"); return; }
    const v = validatePatch(reply, shown.map((s) => s.path));
    if (!v.ok) { fail("refused", v.reason); return; }
    const guard = guardPatch(v.patch, v.files, contents);
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
    await deliver(c, "code", pr, v, names[0] ?? "CI", check, shown);
  };

  const workOne = async (c: CifixCandidate): Promise<void> => {
    const ref = refOf(c);
    try {
      const pr = await readPr(c);
      if (!pr) return;
      // A PR that only waits for rerun results is not counted as handled (it does not use the step's limit).
      const handle = () => params.onHandled?.(++handled);
      const reading = await readFailure(d.gh, repo, c.head);
      const skip = (why: string) => { rec.set(c, "code", "skipped", why); summary.skipped.push(ref); log(`  ${ref}: skipped: ${why}`); };
      if (reading.kind === "skip") { handle(); skip(reading.why); return; }
      const failure = reading.failure;
      const t = triage(failure);
      log(`  ${ref}: ${t.kind}: ${t.why}`);
      if (t.kind === "skip") { handle(); skip(t.why); return; }
      if (t.kind !== "infra" || !c.rerun) handle();
      if (t.kind === "unreadable") { rec.set(c, "code", "failed", t.why); summary.failed.push({ ref, reason: t.why }); return; }
      if (t.kind === "infra") {
        if (c.rerun) {
          // Only results from after the rerun can say it failed again; older ones are what the rerun was meant to replace.
          const fresh = failure.checks.every((x) => !!x.completedAt && !!c.rerunAt && Date.parse(x.completedAt) > Date.parse(c.rerunAt));
          if (!fresh) {
            const waited = !c.rerunAt || Date.parse(at()) > Date.parse(c.rerunAt) + RERUN_WAIT_MS;
            if (!waited) { log(`  ${ref}: waiting: the checks were not rerun yet`); return; }
            handle();
            const reason = "the rerun produced no new check results";
            rec.set(c, "infra", "failed", reason);
            summary.failed.push({ ref, reason });
            return;
          }
          handle();
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
        // Only files that are in both the PR's diff and the log's `Diff in` lines are formatted.
        const diff = await cachedDiff(repo, c.number, c.head, d.fetchDiff);
        if (!diff.ok) { rec.set(c, "format", "failed", `no diff: ${oneLine(diff.error)}`); summary.failed.push({ ref, reason: "no diff" }); return; }
        const prFiles = [...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!);
        const names = matchPrFiles(formatDiffPaths(failure), prFiles).filter((p) => editable(p) && !TEST_PATH.test(p));
        if (!names.length || names.length > FORMAT_FILES_MAX) {
          const reason = names.length ? `the formatter failure names ${names.length} of the PR's files` : "the formatter failure is in files the PR does not change";
          rec.set(c, "format", "refused", reason);
          summary.failed.push({ ref, reason });
          log(`  ${ref}: refused: ${reason}`);
          return;
        }
        // The build environment (packages, env) is read from the PR's base commit, never from the PR's own workflow.
        const base = (await d.gh(["api", `repos/${ORG}/${repo}/pulls/${c.number}`, "--jq", ".base.sha"])).trim();
        if (!/^[0-9a-f]{40}$/.test(base)) { rec.set(c, "format", "failed", "no base commit for the build environment"); summary.failed.push({ ref, reason: "no base commit" }); return; }
        const id = createTask(db, {
          step: "cifix", repo, number: c.number, headSha: c.head, baseSha: base, requires: { os: "linux", toolchains: ["rust-stable"] }, warm: { key: warmKeyOf(repo), role: "use" },
          plan: [{ name: "format", cmd: ["sh", "-c", FORMAT_SCRIPT, "format", ...names], network: "none", timeoutSec: 600, artifacts: [FORMAT_ARTIFACT] }],
        });
        rec.set(c, "format", "formatting", null, { task: id, files: names });
        summary.queued.push(ref);
        log(`  ${ref}: formatter task ${id} queued for ${names.join(", ")}`);
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
  for (const c of sel.capped) {
    const reason = `the PR's limit of ${MAX_PUSHES_PER_PR} pushed CI fixes or ${MAX_TRIES_PER_PR} tries is used`;
    rec.set(c, "code", "capped", reason);
    log(`  ${refOf(c)}: ${reason}`);
  }
  for (const x of collect) {
    try { await collectFormat(x.c, x.task); }
    catch (e) {
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      rec.set(x.c, "format", "failed", reason);
      summary.failed.push({ ref: refOf(x.c), reason });
    }
  }
  for (const c of work) await workOne(c);
  log(`cifix ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} commented, ${summary.queued.length} formatter runs queued, ${summary.infra.length} infra, ${summary.skipped.length} skipped, ${summary.failed.length} failed, ${summary.held.length} held; run ${runId}`);
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
      // Recorded before the calls: one rerun per head, even if this process dies in the middle of them.
      db.prepare("INSERT INTO ci_fixes (repo, number, head, kind, state, reason, files, attempt, runs, created_at) VALUES (?, ?, ?, 'infra', 'rerunning', NULL, '[]', 0, ?, ?)")
        .run(repo, c.number, c.head, JSON.stringify(runs), d.now().toISOString());
      const errors: string[] = [];
      for (const run of runs) {
        const res = await ghRerunFailed(w, d.exec, { repo, number: c.number, runId: run }, { head: c.head });
        if (res.code !== 0) errors.push(oneLine(res.stderr || res.stdout));
      }
      // One rerun per head, whether or not GitHub took every run.
      db.prepare("UPDATE ci_fixes SET state = 'rerun', reason = ? WHERE repo = ? AND number = ? AND head = ? AND state = 'rerunning'")
        .run(errors.length ? errors[0]!.slice(0, 200) : null, repo, c.number, c.head);
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
