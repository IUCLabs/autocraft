// Stage 6, Integrate (fix-ups): for a take-fix PR we may push to, Sonnet turns
// the review's fix list into a unified diff, our code validates and applies
// it on top of the reviewed head, and the result is pushed to the
// contributor's branch. The new head gets reviewed again by the Review stage.
//
//   autocraft fixup --repo R [--limit N] [--apply]
//   autocraft fixup repost R#N [--apply]
//   autocraft push-approval [--repo R]
//
// Without --apply it is a dry run: local tables only, nothing called or written.
// The checkout is untrusted data: nothing from it is ever run (see git.ts).
import { duplicateHeld } from "../dupes/held.ts";
import { commitIdentity, type CommitIdentity } from "../github/identity.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getTask, TERMINAL } from "../build/tasks.ts";
import { askClaude } from "../classify/run.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { audit } from "../dash/audit.ts";
import { withNote } from "../github/note.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guard, guardRepo, liveOf } from "../core/guard.ts";
import { ghAskComment, ghComment, ghEditComment, pushBranch, type Note, type Writer } from "../github/write.ts";
import { connect } from "../db.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { LINT_MAX_ROUNDS } from "../core/rules.ts";
import { CheckTool, applyCheck, refusal } from "../checktool/index.ts";
import { foldFormat, queueLint, readLint } from "../prepush/index.ts";
import { dropSessions, SessionLedger, sessionAsk, storeSessions, sweepSessions, type SessionAsk } from "../prepush/resume.ts";
import { pushApprovalOf } from "./approval.ts";
import { MAX_ATTEMPTS, parseFixes, type FixCandidate } from "./candidates.ts";
import { selectFixups } from "./select.ts";
import { Git, exec, fixupDir, type Exec } from "./git.ts";
import { scrubGitError } from "../worker/patch.ts";
import { longLivedOf, pushable } from "./pushable.ts";
import { claimForWork } from "../github/claim.ts";
import { askConflict, mergeConflict, newestOwnComment, type ConflictRun } from "./conflict.ts";
import { referenceDir } from "../reference.ts";
import { cleanReason } from "../act/templates.ts";
import { defaultSemanticDeps, referenceProblems } from "../reference-lint.ts";
import { dropTexts } from "../replylint.ts";
import { fixupEditable, operatorEditable, quotesText, splitChanges, validatePatch, type ConflictPr, type FixupPr } from "./patch.ts";
import { outsideShown, shownSize, viewFile } from "./excerpt.ts";
import { HOLD_CANNOT_PUSH, askText, carryCommentText, commentText, commitMessage, fixupCommentEdited, fixupCommentLines, operatorCommentText } from "./template.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { jobItem } from "../runner/job-items.ts";
import { ownerOf } from "../owners.ts";

export { MAX_ATTEMPTS, type FixCandidate, type FixSelection } from "./candidates.ts";
export { selectFixups } from "./select.ts";

const ACTOR = "fixup";
const PROMPT = CLAUDE_PROMPTS["fixup.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
const CONFLICT = CLAUDE_PROMPTS["fixup.conflict"];
/** Characters of one file shown whole (a larger file is shown in part, and the part is held to the same limit), of all files shown, and of the PR diff; over any of them the PR is held. */
export const FILE_CAP = 40_000;
export const TOTAL_CAP = 120_000;
export const DIFF_CAP = 60_000;

export type FixupDeps = {
  querier: Querier;
  /** Every git and gh command. */
  exec: Exec;
  fetchDiff: DiffFetcher;
  /** The model's reply to the fixup.patch prompt, or null when it gave none. */
  ask: (db: DatabaseSync, input: FixupPr[], checkout?: string, tool?: CheckTool, session?: SessionAsk) => Promise<string | null>;
  /** The model's reply to the fixup.check prompt (Opus), or null when it gave none. */
  check: (db: DatabaseSync, input: FixupCheckInput[], checkout?: string) => Promise<string | null>;
  /** The model's reply to the fixup.conflict prompt (Sonnet), or null when it gave none. Absent: conflicts are not resolved by a model. */
  resolve?: (db: DatabaseSync, input: ConflictPr[], checkout?: string, session?: SessionAsk) => Promise<string | null>;
  /** Host directory with a read-only checkout of the PR head for the sandboxed model calls, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
};

export function defaultDeps(): FixupDeps {
  return {
    querier: new Client(1000), exec, fetchDiff: ghDiff, now: () => new Date(), root: fixupDir(),
    ask: async (db, input, checkout, tool, session) => (await askClaude("fixup.patch", PROMPT.models[0]!, input, db, { checkout, check: tool, session }))?.text ?? null,
    check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
    resolve: async (db, input, checkout, session) => (await askClaude("fixup.conflict", CONFLICT.models[0]!, input, db, { checkout, session }))?.text ?? null,
    checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
  };
}

export type FixupParams = {
  repo: string;
  limit?: number;
  /** Default true. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};
export type FixupSummary = {
  runId: string; repo: string; dryRun: boolean;
  pushed: string[]; asked: string[]; failed: { ref: string; reason: string }[]; held: { ref: string; reason: string }[];
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const short = (sha: string) => sha.slice(0, 7);
/** Reasons are shown on the dashboard: first line only, known directories and any absolute path removed. */
export function scrubReason(text: string, root: string): string {
  return scrubGitError(text, [root, homedir()]).replace(/(^|[\s"'(=:])\/[^\s"')]*/g, "$1<path>");
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      id state isDraft headRefOid baseRefOid headRefName maintainerCanModify mergeable
      headRepository { nameWithOwner }
      headRef { branchProtectionRule { id } }
      assignees(first: 10) { nodes { login } }
    }
  }
}`;

export type PrNode = {
  id: string; state: string; isDraft: boolean; headRefOid: string; baseRefOid?: string; headRefName: string; maintainerCanModify: boolean; mergeable: string | null;
  headRepository: { nameWithOwner: string } | null; headRef?: { branchProtectionRule?: { id: string } | null } | null; assignees?: { nodes?: { login: string }[] };
};

/**
 * Writes what the live read found into pr_checks, as the checks sync would, so a PR the live read shows is no candidate
 * (conflicting, closed, a draft, head moved) is not selected again until the checks data changes.
 */
export function noteLive(db: DatabaseSync, repo: string, number: number, pr: PrNode | null | undefined, at: string): void {
  if (!pr) return;
  // The planner reads the mirrored value when the checks row is missing or at another head: a conflict seen live must reach it, or the PR keeps planning as a fix-up.
  if (pr.mergeable === "CONFLICTING" || pr.mergeable === "MERGEABLE") db.prepare("UPDATE main.items SET mergeable = ? WHERE repo = ? AND number = ? AND kind = 'pr' AND head_oid = ?").run(pr.mergeable, repo, number, pr.headRefOid);
  const row = db.prepare("SELECT head_oid FROM pr_checks WHERE repo = ? AND number = ?").get(repo, number) as { head_oid: string } | undefined;
  if (!row) return;
  if (row.head_oid === pr.headRefOid) {
    db.prepare("UPDATE pr_checks SET state = ?, is_draft = ?, mergeable = ?, maintainer_can_modify = ?, fetched_at = ? WHERE repo = ? AND number = ?")
      .run(pr.state, pr.isDraft ? 1 : 0, pr.mergeable, pr.maintainerCanModify ? 1 : 0, at, repo, number);
  } else {
    // The old head's checks say nothing about the new one: pending until the checks sync reads them.
    db.prepare("UPDATE pr_checks SET head_oid = ?, state = ?, is_draft = ?, overall = 'pending', checks = '[]', mergeable = ?, maintainer_can_modify = ?, fetched_at = ? WHERE repo = ? AND number = ?")
      .run(pr.headRefOid, pr.state, pr.isDraft ? 1 : 0, pr.mergeable, pr.maintainerCanModify ? 1 : 0, at, repo, number);
  }
}

export type Who = { login: string; nodeId: string; email: string };

/** The Plan action's source of a candidate. */
const sourceOf = (c: FixCandidate): string => (c.carry ? "carry" : c.source ?? "review");

export async function whoAmI(run: Exec): Promise<Who> {
  const r = await run("gh", ["api", "user"]);
  if (r.code !== 0) throw new Error("could not read the pipeline's GitHub account");
  const u = JSON.parse(r.stdout) as { login?: string; id?: number; node_id?: string };
  if (!u.login || !u.id || !u.node_id) throw new Error("could not read the pipeline's GitHub account");
  return { login: u.login, nodeId: u.node_id, email: `${u.id}+${u.login}@users.noreply.github.com` };
}

class Recorder {
  private db: DatabaseSync;
  private at: () => string;
  constructor(db: DatabaseSync, at: () => string) {
    this.db = db;
    this.at = at;
  }

  /** Written before the push: the commit about to be pushed, so a crash between the push and its record leaves the head in the push chain. */
  pushing(c: FixCandidate, commit: string, files: string[]): void {
    // A stored patch's row (any source) is the record of the push; a carry-over also keeps its own.
    if (c.lint) this.db.prepare("UPDATE fixups SET state = 'pushing', to_head = ?, files = ? WHERE rowid = ?").run(commit, JSON.stringify(files), c.lint.rowid);
    if (c.carry) {
      this.db.prepare("UPDATE dupe_carries SET to_head = ?, from_head = ?, updated_at = ? WHERE decision_id = ? AND number = ?").run(commit, c.head, this.at(), c.carry.decisionId, c.number);
      return;
    }
    if (c.lint) return;
    this.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, reason, files, attempt, created_at, source, operator_fix) VALUES (?, ?, ?, ?, 'pushing', NULL, ?, ?, ?, ?, ?)")
      .run(c.repo, c.number, c.head, commit, JSON.stringify(files), c.attempt, this.at(), c.source ?? null, c.operator?.id ?? null);
  }

  /** The model patch waits for its lint task: a first row, or the same row with the next round's patch and task. */
  linting(c: FixCandidate, patch: string, files: string[], task: number, lintState: "pending" | "requeued", round: number, session: string | null, changes: string[] = []): void {
    const list = changes.length ? JSON.stringify(changes) : null;
    if (c.lint) {
      this.db.prepare("UPDATE fixups SET patch = ?, files = ?, lint_task = ?, lint_round = ?, lint_state = ?, session = ?, changes = ? WHERE rowid = ?").run(patch, JSON.stringify(files), task, round, lintState, session, list, c.lint.rowid);
      return;
    }
    this.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, reason, files, attempt, created_at, source, patch, lint_task, lint_round, lint_state, carry_decision, session, operator_fix, changes) VALUES (?, ?, ?, NULL, 'linting', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.repo, c.number, c.head, JSON.stringify(files), c.attempt, this.at(), c.carry ? "carry" : c.source ?? null, patch, task, round, lintState, c.carry?.decisionId ?? null, session, c.operator?.id ?? null, list);
  }

  /** Stored patches whose Plan no longer lists the push (head moved, a Hold or Close answer, approval revoked) are dropped. */
  dropUnlisted(repo: string, listed: FixCandidate[]): void {
    const keep = new Set(listed.map((c) => c.lint!.rowid));
    const rows = this.db.prepare("SELECT rowid AS id, lint_task FROM fixups WHERE repo = ? AND state = 'linting'").all(repo) as { id: number; lint_task: number | null }[];
    for (const r of rows) {
      const t = r.lint_task != null ? getTask(this.db, r.lint_task) : null;
      if (t && !TERMINAL.includes(t.state)) continue;
      if (!keep.has(r.id)) this.db.prepare("UPDATE fixups SET state = 'superseded', reason = 'the plan no longer lists the push of the stored patch', patch = NULL WHERE rowid = ?").run(r.id);
    }
  }

  /** A fixups row and a stages row: `hold` for the two states that need a person, else the PR's `take` stage with a note. */
  fixup(c: FixCandidate, state: "pushed" | "failed" | "refused" | "rejected" | "cannot-push" | "too-large" | "asked" | "comment-failed" | "push-denied", reason: string | null, files: string[], toHead: string | null = null): void {
    const at = this.at();
    if (c.carry) {
      // A carry-over keeps its own record; the PR's take-fix tries and stage are not touched.
      const ended = state === "pushed" || state === "asked" || state === "cannot-push" || state === "too-large" || state === "push-denied" || state === "comment-failed";
      const tried = !ended;
      const next = ended || c.attempt >= MAX_ATTEMPTS ? (state === "pushed" || state === "asked" ? "done" : "held") : "queued";
      this.db.prepare("UPDATE dupe_carries SET state = ?, attempts = attempts + ?, outcome = ?, to_head = ?, from_head = ?, updated_at = ? WHERE decision_id = ? AND number = ?")
        .run(next, tried || state === "pushed" ? 1 : 0, reason ? `${state}: ${reason}` : state, toHead, toHead ? c.head : null, at, c.carry.decisionId, c.number);
      // The stored patch's row, if the carry-over went through the lint check, ends with it.
      if (c.lint) this.db.prepare("UPDATE fixups SET state = ?, reason = ?, files = ?, to_head = ?, patch = NULL WHERE rowid = ?").run(state, reason, JSON.stringify(files), toHead, c.lint.rowid);
      return;
    }
    // The candidate's own row: its stored patch, else the open row of its source (and of its operator request).
    const open = (c.lint ? { id: c.lint.rowid } : this.db.prepare("SELECT rowid AS id FROM fixups WHERE repo = ? AND number = ? AND from_head = ? AND state IN ('pushing', 'linting') AND COALESCE(source, 'review') = ? AND operator_fix IS ? ORDER BY rowid DESC")
      .get(c.repo, c.number, c.head, c.source ?? "review", c.operator?.id ?? null)) as { id: number } | undefined;
    if (open) {
      this.db.prepare("UPDATE fixups SET state = ?, reason = ?, files = ?, to_head = ? WHERE rowid = ?").run(state, reason, JSON.stringify(files), toHead, open.id);
    } else {
      this.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, reason, files, attempt, created_at, source, operator_fix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.repo, c.number, c.head, toHead, state, reason, JSON.stringify(files), c.attempt, at, c.source ?? null, c.operator?.id ?? null);
    }
    const hold = state === "cannot-push" || state === "too-large" || state === "push-denied";
    const note = state === "pushed" ? `fix-up pushed at ${short(c.head)}: ${files.join(", ")}`
      : state === "asked" ? `asked the contributor for changes at ${short(c.head)}: ${files.join(", ")}` : `fix-up ${state} at ${short(c.head)}: ${reason}`;
    this.db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.repo, c.number, hold ? "hold" : "take", at, ACTOR, hold ? reason : note);
  }
}

export async function runFixup(db: DatabaseSync, params: FixupParams, log: (line: string) => void = console.log, deps?: FixupDeps): Promise<FixupSummary> {
  const ledger = new SessionLedger();
  try {
    if (!(params.dryRun ?? true)) sweepSessions(db, deps?.now() ?? new Date());
    return await runFixupWith(db, params, log, deps, ledger);
  } finally {
    ledger.release();
  }
}

async function runFixupWith(db: DatabaseSync, params: FixupParams, log: (line: string) => void, deps: FixupDeps | undefined, ledger: SessionLedger): Promise<FixupSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `fixup-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const gw: Writer = { db, login: ACTOR };
  const summary: FixupSummary = { runId, repo, dryRun, pushed: [], asked: [], failed: [], held: [] };
  const sel = selectFixups(db, repo);
  const asks = params.limit === undefined ? sel.ask : sel.ask.slice(0, params.limit);
  // Stored patches whose lint task ended come first: they hold a model patch that is already paid for.
  const wanted = [...sel.lint, ...sel.fix];
  const budget = params.limit === undefined ? Infinity : Math.max(0, params.limit - asks.length);
  // A PR found conflicting live is skipped without using the limit, so the candidates behind it still get their turn.
  const picks = budget === 0 ? [] : wanted;
  const left = params.limit === undefined ? Infinity : Math.max(0, params.limit - asks.length - Math.min(budget, wanted.length));
  const cAsks = sel.conflictAsk.slice(0, left);
  const cMerges = sel.conflictMerge.slice(0, Math.max(0, left - cAsks.length));
  log(`fixup ${repo}: ${sel.conflictMerge.length} conflicted PRs to merge into, ${sel.conflictAsk.length} to ask`);
  log(`fixup ${repo}: ${sel.fix.length} PRs to fix up, ${sel.cannotPush.length + sel.ask.length} we can't push to${pushApprovalOf(db, repo) ? "" : " (pushing is not approved for this repo)"}`);
  if (dryRun) {
    for (const c of picks.slice(0, budget)) log(`  would fix up ${refOf(c)} at ${short(c.head)} (try ${c.attempt}): ${[...new Set(c.fixes.map((f) => f.file))].join(", ")}`);
    for (const c of asks) log(`  would comment the fixes on ${refOf(c)} at ${short(c.head)}`);
    for (const c of cMerges) log(`  would merge ${c.base} into ${refOf(c)} at ${short(c.head)} (try ${c.attempt})`);
    for (const c of cAsks) log(`  would ask the contributor of ${refOf(c)} to merge ${c.base}`);
    for (const c of sel.cannotPush) log(`  would hold ${refOf(c)}: ${HOLD_CANNOT_PUSH}`);
    log(`fixup ${repo}: dry run, nothing called or written`);
    return summary;
  }
  const d = deps ?? defaultDeps();
  const rec = new Recorder(db, at);
  rec.dropUnlisted(repo, sel.lint);

  // Not approved for comments: no GitHub write, recorded once per head.
  for (const c of sel.cannotPush) {
    rec.fixup(c, "cannot-push", HOLD_CANNOT_PUSH, []);
    summary.held.push({ ref: refOf(c), reason: HOLD_CANNOT_PUSH });
    log(`  ${refOf(c)}: held: ${HOLD_CANNOT_PUSH}`);
  }
  const handled = { n: 0 };
  const askOne = async (c: FixCandidate, count = true) => {
    const ref = refOf(c);
    try {
      const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      noteLive(db, repo, c.number, pr, at());
      if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR`); return; }
      if (pr.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(pr.headRefOid)} since the review`); return; }
      if (c.carry && !c.carry.suggestion) {
        // Only the text the operator saw and approved is ever posted.
        const reason = "no approved suggestion text";
        rec.fixup(c, "cannot-push", reason, []);
        summary.held.push({ ref, reason });
        log(`  ${ref}: held: ${reason}`);
        return;
      }
      const body = c.carry ? c.carry.suggestion! : askText(c.fixes);
      const g = await guard(db, { repo, number: c.number }, { kind: "fixup", bucket: "ask", head: c.head, source: sourceOf(c) }, params.by ?? CLI_BY);
      if ("refused" in g) { log(`  ${ref}: not asked: ${g.refused}`); return; }
      const cm = await ghAskComment(gw, d.exec, "fixup-comment", g, c.carry ? (c.model ? { by: "operator", model: c.model } : { by: "fixed-operator" }) : { by: "model", kind: "comment", model: c.model }, body, { run: runId, head: c.head });
      if (cm.code !== 0) { const why = scrubReason(oneLine(cm.stderr), d.root); rec.fixup(c, "comment-failed", why, []); log(`  ${ref}: comment failed: ${why}`); return; }
      rec.fixup(c, "asked", null, [...new Set(c.fixes.map((f) => f.file))]);
      if (count) params.onHandled?.(++handled.n);
      summary.asked.push(ref);
      jobItem(db, repo, c.number, `asked the contributor for changes at ${short(c.head)}`, log);
    } catch (e) {
      log(`  ${ref}: not asked: ${oneLine(String((e as Error).message ?? e))}`);
    }
  };
  for (const c of asks) await askOne(c);
  const git = new Git(d.exec, d.root, repo);
  let whoP: Promise<Who> | undefined;
  let identP: Promise<CommitIdentity> | undefined;
  /** The author of our commits and comments here: the app's bot user on an app-lane repo, else the box account. */
  const ident = (): Promise<CommitIdentity> => (identP ??= commitIdentity(db, repo, () => (whoP ??= whoAmI(d.exec))));
  /** The stage starts work on a PR: the pipeline's account is assigned when nobody is. */
  const claim = async (c: { number: number }): Promise<void> => {
    if (duplicateHeld(db, repo, c.number)) { log(`  ${repo}#${c.number}: not assigned: held`); return; }
    const g = guardRepo(db, repo, "push", params.by ?? CLI_BY);
    if ("refused" in g) { log(`  ${repo}#${c.number}: not assigned: ${g.refused}`); return; }
    await claimForWork(gw, g, d.querier, repo, c.number, "pr", async () => { const who = await (whoP ??= whoAmI(d.exec)); return { id: who.nodeId, login: who.login }; }, { run: runId }, log);
  };
  const conflictRun: ConflictRun = {
    ledger,
    repo, runId, log, d, gw, at, summary, prQuery: PR_QUERY, scrub: (raw) => scrubReason(raw, d.root), git: () => git,
    who: ident, onHandled: params.onHandled, handled, claim, by: params.by ?? CLI_BY,
  };
  for (const c of cAsks) await askConflict(db, conflictRun, c);
  if (!picks.length && !cMerges.length) return summary;

  const who = await ident();
  mkdirSync(d.root, { recursive: true });
  let worked = 0;
  for (const c of picks) {
    if (worked >= budget) break;
    const ref = refOf(c);
    let files = [...new Set(c.fixes.map((f) => f.file))];
    const fail = (state: "failed" | "refused" | "rejected", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.fixup(c, state, reason, files);
      summary.failed.push({ ref, reason });
      jobItem(db, repo, c.number, `${state}: ${reason}`, log);
    };
    const hold = (state: "cannot-push" | "too-large" | "push-denied", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.fixup(c, state, reason, files);
      summary.held.push({ ref, reason });
      jobItem(db, repo, c.number, `held: ${reason}`, log);
    };
    try {
      if (!c.carry && files.some((f) => !fixupEditable(f))) { hold("too-large", "the fixes name files a fix-up may not edit"); continue; }
      const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      noteLive(db, repo, c.number, pr, at());
      if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR`); continue; }
      if (pr.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(pr.headRefOid)} since the review`); continue; }
      if (pr.mergeable === "CONFLICTING") { log(`  ${ref}: skipped: conflicts with the base branch; the conflict merge handles it`); continue; }
      worked++;
      params.onHandled?.(++handled.n);
      if (!pr.headRepository || !pushable(pr.headRepository.nameWithOwner, repo, pr.maintainerCanModify, pr.headRefName, longLivedOf(db, repo), !!pr.headRef?.branchProtectionRule)) {
        // A carry-over we can't push is suggested on the PR instead, when the repo allows comments.
        if (c.carry && commentApprovalOf(db, repo)) await askOne(c, false);
        else hold("cannot-push", HOLD_CANNOT_PUSH);
        continue;
      }
      let carried: FixupPr["carried_from"];
      if (c.carry) {
        const w = await carryWork(c, d.fetchDiff);
        if (!w.ok) { fail("refused", w.reason); continue; }
        c.fixes = w.fixes;
        carried = w.carried;
        files = [...new Set(c.fixes.map((f) => f.file))];
      }
      const head = await git.fetchPr(ownerOf(repo), repo, c.number);
      if (head !== c.head) { log(`  ${ref}: skipped: fetched head ${short(head)} is not the reviewed ${short(c.head)}`); continue; }

      const diff = await cachedDiff(repo, c.number, head, d.fetchDiff);
      if (!diff.ok) { fail("failed", `no diff: ${oneLine(diff.error)}`); continue; }
      if (diff.text.length > DIFF_CAP) { hold("too-large", `the PR diff is over the ${DIFF_CAP} character limit`); continue; }
      // An operator's fix-up may edit any file of the repository a fix-up may touch: the instructions name no file. The PR's own files are the ones shown.
      if (c.operator) {
        files = [...new Set([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!))].filter(operatorEditable);
      }
      // With a sandbox checkout the model reads the files itself, so they are listed by path and no size limit applies.
      const checkout = (await d.checkout?.(repo, c.number, head)) ?? undefined;
      const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
      const shown: FixupPr["files"] = [];
      let total = 0, tooBig: string | null = null, bad: string | null = null;
      for (const path of files) {
        const f = await git.file(head, path);
        if (!f.ok) { bad = f.reason; break; }
        if (checkout) { shown.push({ path }); continue; }
        const v = viewFile(path, f.content, c.fixes.filter((x) => x.file === path).map((x) => x.change), diff.text, FILE_CAP);
        if (!v.ok) { tooBig = v.reason; break; }
        total += shownSize(v.file);
        if (total > TOTAL_CAP) { tooBig = `the files named in the fixes are over the ${TOTAL_CAP} character limit`; break; }
        shown.push(v.file);
      }
      if (bad) { fail("refused", bad); continue; }
      if (tooBig) { hold("too-large", tooBig); continue; }
      if (!c.carry) await claim(c);
      // A stored patch: the lint task's outcome decides whether it is pushed (clean), asked for again (findings) or queued again (lost task).
      let findings: string[] = [];
      let folded: string | null = null;
      if (c.lint) {
        const res = readLint(db, c.lint.task ?? -1);
        if (res.kind === "pending") { log(`  ${ref}: the lint task is still running`); continue; }
        if (res.kind === "infra-failed") {
          if (c.lint.state === "requeued") { fail("failed", `lint: ${res.reason}`); continue; }
          const again = queueLint(db, { step: "fixup", repo, number: c.number, head, base: pr.baseRefOid ?? null, patch: c.lint.patch });
          if (again === null) { fail("failed", `lint: ${res.reason}`); continue; }
          rec.linting(c, c.lint.patch, files, again, "requeued", c.lint.round, c.lint.session, c.lint.changes);
          log(`  ${ref}: lint task failed (${res.reason}); queued again as task ${again}`);
          continue;
        }
        if (res.findings.length) {
          if (c.lint.round >= LINT_MAX_ROUNDS) { fail("rejected", `clippy findings remain after ${c.lint.round} rounds: ${oneLine(res.findings[0]!.message)}`); continue; }
          findings = res.findings.map((x) => x.rendered);
        } else {
          const fold = await foldFormat(git, head, c.lint.patch, res.formatDiff ?? "", d.root);
          if (!fold.ok) { fail("refused", fold.reason); continue; }
          folded = fold.patch;
        }
      }
      // The model's patch: the stored one when it is clean, else a new answer (with the findings on the earlier patch).
      const ses: SessionAsk = c.lint && findings.length ? sessionAsk(c.lint.session, "", findings, new Date(at())) : {};
      if (folded !== null) dropSessions(c.lint!.session);
      const raw = folded !== null ? c.lint!.patch : await d.ask(db, [{ ref, title: oneTitle(db, c), fixes: c.fixes, files: shown, diff: diff.text, ...(c.operator ? { operator: c.operator.instructions } : {}), ...(carried ? { carried_from: carried } : {}),
        ...(c.lint && findings.length ? { previous: { patch: c.lint.patch, findings } } : {}), ...repoDir }], checkout,
        new CheckTool({ db, step: "fixup", repo, number: c.number, head, base: pr.baseRefOid ?? null, applies: applyCheck(git, d.root, head, (p) => refusal(c.operator ? validatePatch(splitChanges(p).diff, null, operatorEditable) : validatePatch(p, files, fixupEditable))) }), ses);
      ledger.hold(ses.kept);
      if (c.lint && folded === null) dropSessions(c.lint.session, ses.kept ? { "": ses.kept } : {});
      if (raw === null) { fail("failed", "the model gave no answer"); continue; }
      // An operator fix-up's reply ends with the model's list of what it changed; a stored patch keeps the list in its row.
      const split = c.operator && folded === null ? splitChanges(raw, c.operator.instructions) : { diff: raw, changes: c.lint?.changes ?? [] };
      const reply = split.diff;
      const v = c.operator ? validatePatch(reply, null, operatorEditable) : validatePatch(reply, files, fixupEditable);
      if (!v.ok) { fail("refused", v.reason); continue; }

      const scratch = mkdtempSync(join(d.root, ".index-"));
      let applied;
      try {
        applied = await git.applyToTree(head, folded ?? v.patch, join(scratch, "index"), shown.flatMap((f) => ("excerpt" in f ? [f.path] : [])));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      if (!applied.ok) { fail("refused", applied.reason); continue; }
      const commit = await git.commit(applied.tree, head, commitMessage(v.files, !!c.operator), { name: who.login, email: who.email });
      const changes = await git.rawChanges(head, commit);
      const touched = changes.map((x) => x[3]!).sort().join("\n");
      if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n")) {
        fail("refused", "the commit would change files or modes outside the validated diff");
        continue;
      }

      const outside = outsideShown(shown, await git.diffText(head, commit));
      if (outside) { fail("refused", outside); continue; }

      // Opus checks the validated patch; only an approve goes on. A stored patch that came back clean was checked already (the format changes are whitespace only).
      if (folded === null) {
        if (v.patch.length > CHECK_PATCH_CAP) { fail("refused", `the patch is over the ${CHECK_PATCH_CAP} character limit for the check`); continue; }
        const checkReply = await d.check(db, [{ ref, title: oneTitle(db, c), review_reason: c.reason, fixes: c.fixes, ...(c.operator ? { operator: c.operator.instructions } : {}), diff: diff.text.slice(0, CHECK_DIFF_CAP), patch: v.patch, ...(carried ? { carried_from: carried.map((x) => ({ ...x, diff: x.diff.slice(0, Math.floor(CHECK_DIFF_CAP / carried.length)) })) } : {}), ...repoDir }], checkout);
        if (checkReply === null) { fail("failed", "the patch check gave no answer"); continue; }
        const verdict = parseCheck(checkReply);
        if (!verdict.ok) { fail("failed", `the patch check gave no valid answer: ${verdict.error}`); continue; }
        recordCheck(db, { kind: "fixup", repo, number: c.number, subject: head, patch: v.patch, round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: at() });
        audit(db, ACTOR, "fixup-check", ref, { run: runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons });
        if (verdict.check.verdict === "reject") { fail("rejected", `Opus rejected the patch: ${checkLine(verdict.check)}`); continue; }
      }

      // The model calls took minutes: read the PR again before pushing.
      const again = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const now = again.repository?.pullRequest;
      noteLive(db, repo, c.number, now, at());
      if (!now || now.state !== "OPEN" || now.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR after the model calls`); continue; }
      if (now.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(now.headRefOid)} during the model calls`); continue; }

      const g = await guard(db, { repo, number: c.number }, c.lint ? { kind: "lint", bucket: "fixup", head: c.head, source: sourceOf(c) } : { kind: "fixup", bucket: "fix", head: c.head, source: sourceOf(c) }, params.by ?? CLI_BY, liveOf(db, d.querier));
      if ("refused" in g) { log(`  ${ref}: skipped: ${g.refused}`); continue; }
      // A model patch is stored and linted before it is pushed (the collect step above pushes it); a patch without a Rust file needs no lint.
      if (folded === null) {
        const round = c.lint ? c.lint.round + 1 : 1;
        const task = queueLint(db, { step: "fixup", repo, number: c.number, head, base: now.baseRefOid ?? null, patch: v.patch });
        if (task !== null) {
          rec.linting(c, v.patch, v.files, task, "pending", round, ses.kept ? storeSessions({ "": ses.kept }, new Date(at())) : null, split.changes);
          if (ses.kept) ledger.stored({ "": ses.kept });
          jobItem(db, repo, c.number, `patch stored; lint task ${task} queued (round ${round})`, log);
          continue;
        }
      }
      rec.pushing(c, commit, v.files);
      const push = await pushBranch(gw, git, "fixup-push", g, { remote: pr.headRepository.nameWithOwner, branch: pr.headRefName, sha: commit }, { run: runId, from: head, to: commit, files: v.files, changed: v.changed });
      if (push.code !== 0) {
        const err = oneLine(push.stderr);
        if (/stale info|rejected|fetch first/i.test(err)) fail("refused", "the branch moved since the review");
        else if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) hold("push-denied", HOLD_CANNOT_PUSH);
        else fail("failed", `push failed: ${err}`);
        continue;
      }
      rec.fixup(c, "pushed", null, v.files, commit);
      summary.pushed.push(ref);
      jobItem(db, repo, c.number, `pushed ${short(commit)} on ${short(head)}: ${v.files.join(", ")}`, log);

      const body = c.carry ? carryCommentText(c.carry.sources.map((x) => x.number), v.files) : c.operator ? operatorCommentText(v.files, await postableChanges(db, repo, `${repo}#${c.number}`, split.changes, c.operator.instructions)) : commentText(v.files, c.attempt);
      const note: Note = c.carry ? { by: "operator", model: PROMPT.models[0] } : c.operator ? { by: "fixed-operator" } : { by: "model", kind: "comment", model: PROMPT.models[0] };
      // A plain review-fix push right after our own review-fix comment extends that comment instead of adding a second one.
      const prev = c.carry || c.operator ? null : await newestOwnComment(d.querier, who.login, repo, c.number);
      const prevLines = prev ? fixupCommentLines(prev.body) : null;
      const cm = prev && prevLines
        ? await ghEditComment(gw, g, d.exec, "fixup-comment-edit", { repo, number: c.number, commentId: prev.id }, note, fixupCommentEdited(prevLines, v.files), { run: runId })
        : await ghComment(gw, g, d.exec, "fixup-comment", { repo, number: c.number, pr: true }, note, body, { run: runId });
      if (cm.code !== 0) log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
    } catch (e) {
      fail("failed", oneLine(String((e as Error).message ?? e)));
    }
  }
  for (const c of cMerges) await mergeConflict(db, conflictRun, c);
  log(`fixup ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} asked, ${summary.failed.length} failed, ${summary.held.length} held; run ${runId}`);
  return summary;
}

/** The model's list of changes with the items the reference lint flags (a mention or quote of the reference documentation) left out. */
async function postableChanges(db: DatabaseSync, repo: string, ref: string, changes: string[], instructions: string): Promise<string[]> {
  const items = changes.map((t) => cleanReason(t, 200) ?? "").filter((t) => t && !quotesText(t, instructions));
  const dir = referenceDir(repo);
  const bad = dropTexts(await referenceProblems(items.map((text, i) => ({ field: `changes[${i}]`, text })), dir, dir ? defaultSemanticDeps(db, ref) : undefined));
  return items.filter((t) => !bad.has(t));
}

const DIFF_FILE = /^diff --git a\/(\S+) b\/\S+$/gm;
const CARRY_MAX_FIXES = 8;

/**
 * The fixes and the source diffs for a carry-over: each point is tied to the editable files of the source PR's diff it
 * names, or to all of that PR's editable files when it names none. Reads the source diffs (cached by head).
 */
async function carryWork(c: FixCandidate, fetchDiff: DiffFetcher): Promise<{ ok: true; fixes: FixCandidate["fixes"]; carried: NonNullable<FixupPr["carried_from"]> } | { ok: false; reason: string }> {
  const fixes: FixCandidate["fixes"] = [];
  const carried: NonNullable<FixupPr["carried_from"]> = [];
  for (const src of c.carry!.sources) {
    if (!src.head) return { ok: false, reason: `#${src.number} has no recorded head` };
    const diff = await cachedDiff(c.repo, src.number, src.head, fetchDiff);
    if (!diff.ok) return { ok: false, reason: `no diff of #${src.number}: ${oneLine(diff.error)}` };
    if (diff.text.length > DIFF_CAP) return { ok: false, reason: `the diff of #${src.number} is over the ${DIFF_CAP} character limit` };
    const paths = [...new Set([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!))].filter(fixupEditable);
    for (const point of src.points) {
      const named = paths.filter((p) => point.includes(p));
      for (const file of named.length ? named : paths) fixes.push({ file, change: `from #${src.number}: ${point}` });
    }
    carried.push({ ref: `${c.repo}#${src.number}`, points: src.points, diff: diff.text });
  }
  if (!fixes.length) return { ok: false, reason: "the closed pull requests change no file a fix-up may edit" };
  return { ok: true, fixes: fixes.slice(0, CARRY_MAX_FIXES), carried };
}

function oneTitle(db: DatabaseSync, c: FixCandidate): string {
  return ((db.prepare("SELECT title FROM items WHERE repo = ? AND number = ?").get(c.repo, c.number) as { title: string | null } | undefined)?.title ?? "").slice(0, 300);
}

export type RepostResult = { status: "unchanged" | "dry-run" | "edited" | "failed"; old: string; text: string };

/**
 * Re-posts the ask comment of a PR we asked, by editing the comment we posted, from the fix list of the review at the
 * head the ask was made on. Does nothing when the text equals the one last recorded for that comment.
 */
export async function repostAsk(db: DatabaseSync, repo: string, number: number, apply: boolean, run: Exec = exec): Promise<RepostResult> {
  const state = db.prepare("SELECT state, from_head FROM fixups WHERE repo = ? AND number = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(repo, number) as { state: string; from_head: string } | undefined;
  if (state?.state !== "asked") throw new Error(`${repo}#${number} is not in the asked state`);
  const rows = db.prepare("SELECT action, details FROM audit WHERE target = ? AND action IN ('fixup-comment', 'fixup-comment-edit') ORDER BY rowid DESC").all(`${repo}#${number}`) as { action: string; details: string }[];
  const ds = rows.map((r) => ({ action: r.action, d: JSON.parse(r.details) as { state?: string; url?: string; text?: string; comment?: string } })).filter((r) => r.d.state === "done");
  const last = ds[0];
  const url = ds.find((r) => r.action === "fixup-comment" && r.d.url)?.d.url;
  const id = /#issuecomment-(\d+)$/.exec(url ?? "")?.[1];
  if (!last || !id) throw new Error(`no recorded ask comment for ${repo}#${number}`);
  const review = db.prepare("SELECT fixes, model FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict = 'take-fix'").get(repo, number, state.from_head) as { fixes: string | null; model: string | null } | undefined;
  const fixes = parseFixes(review?.fixes ?? null);
  if (!fixes.length) throw new Error(`no fix list for ${repo}#${number} at ${state.from_head.slice(0, 7)}`);
  const old = last.d.text ?? "";
  const note: Note = { by: "model", kind: "comment", model: review?.model };
  const text = askText(fixes);
  // The recorded text is the text as posted, note line included.
  if (withNote(note, text) === old) return { status: "unchanged", old, text };
  if (!apply) return { status: "dry-run", old, text };
  const g = guardRepo(db, repo, "comment", CLI_BY);
  if ("refused" in g) throw new Error(g.refused);
  const r = await ghEditComment({ db, login: ACTOR }, g, run, "fixup-comment-edit", { repo, number, commentId: id }, note, text, { head: state.from_head });
  return { status: r.code === 0 ? "edited" : "failed", old, text };
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
  fixup: {
    summary: "fixup --repo R [--limit N] [--apply] | fixup repost <repo>#<n> [--apply] | fixup try <repo>#<n>: push the review's small fixes to take-fix PRs we may push to; repost edits our ask comment to the full fix list (dry run unless --apply); try runs the patch step for one PR with the check tool and prints the tool calls, the patch, the Opus check and the lint result, storing and pushing nothing",
    async run(args: string[]): Promise<void> {
      if (args[0] === "try") {
        const m = /^([^#\s]+)#(\d+)$/.exec(args[1] ?? "");
        if (!m || args.length !== 2) throw new Error("usage: autocraft fixup try <repo>#<n>");
        process.exitCode = await (await import("./try.ts")).runFixupTry(connect(), m[1]!, Number(m[2]));
        return;
      }
      if (args[0] === "repost") {
        const m = /^([^#\s]+)#(\d+)$/.exec(args[1] ?? "");
        if (!m || args.slice(2).some((a) => a !== "--apply")) throw new Error("usage: autocraft fixup repost <repo>#<n> [--apply]");
        const r = await repostAsk(connect(), m[1]!, Number(m[2]), args.includes("--apply"));
        console.log(`old:\n${r.old}\n\nnew:\n${r.text}\n\n${r.status}`);
        if (r.status === "failed") process.exitCode = 1;
        return;
      }
      const f = parseArgs(args);
      await runFixup(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "push-approval": {
    summary: "push-approval [--repo R]: which repos the operator approved for fix-up pushes",
    run(args: string[]): void {
      const i = args.indexOf("--repo");
      const db = connect();
      const repos = i >= 0 ? [args[i + 1]!] : (db.prepare("SELECT name FROM tracked_repos ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      for (const r of repos) {
        const a = pushApprovalOf(db, r);
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
