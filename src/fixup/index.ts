// Stage 6, Integrate (fix-ups): for a take-fix PR we may push to, Sonnet turns
// the review's fix list into a unified diff, our code validates and applies
// it on top of the reviewed head, and the result is pushed to the
// contributor's branch. The new head gets reviewed again by the Review stage.
//
//   craft-auto fixup --repo R [--limit N] [--apply]
//   craft-auto push-approval [--repo R]
//
// Without --apply it is a dry run: local tables only, nothing called or written.
// The checkout is untrusted data: nothing from it is ever run (see git.ts).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { askClaude } from "../classify/run.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { pushApprovalOf } from "./approval.ts";
import { MAX_ATTEMPTS, selectFixups, type FixCandidate } from "./candidates.ts";
import { Git, exec, fixupDir, type Exec } from "./git.ts";
import { scrubGitError } from "../worker/patch.ts";
import { editable, validatePatch, type FixupPr } from "./patch.ts";
import { HOLD_CANNOT_PUSH, askText, carryCommentText, commentText, commitMessage } from "./template.ts";
import { commentApprovalOf } from "../act/approval.ts";

export { selectFixups, MAX_ATTEMPTS, type FixCandidate, type FixSelection } from "./candidates.ts";

const ORG = "storytold";
const ACTOR = "fixup";
const PROMPT = CLAUDE_PROMPTS["fixup.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
/** Characters of one file, of all files, and of the PR diff shown to the model; over any of them the PR is held. */
export const FILE_CAP = 40_000;
export const TOTAL_CAP = 120_000;
export const DIFF_CAP = 60_000;

export type FixupDeps = {
  querier: Querier;
  /** Every git and gh command. */
  exec: Exec;
  fetchDiff: DiffFetcher;
  /** The model's reply to the fixup.patch prompt, or null when it gave none. */
  ask: (db: DatabaseSync, input: FixupPr[], checkout?: string) => Promise<string | null>;
  /** The model's reply to the fixup.check prompt (Opus), or null when it gave none. */
  check: (db: DatabaseSync, input: FixupCheckInput[], checkout?: string) => Promise<string | null>;
  /** Host directory with a read-only checkout of the PR head for the sandboxed model calls, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
};

export function defaultDeps(): FixupDeps {
  return {
    querier: new Client(1000), exec, fetchDiff: ghDiff, now: () => new Date(), root: fixupDir(),
    ask: async (db, input, checkout) => (await askClaude("fixup.patch", PROMPT.models[0]!, input, db, { checkout }))?.text ?? null,
    check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
    checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
  };
}

export type FixupParams = {
  repo: string;
  limit?: number;
  /** Default true. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
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

export const PR_QUERY = `query($name: String!, $n: Int!) {
  repository(owner: "${ORG}", name: $name) {
    pullRequest(number: $n) {
      id state isDraft headRefOid headRefName maintainerCanModify mergeable
      headRepository { nameWithOwner }
      assignees(first: 10) { nodes { login } }
    }
  }
}`;
export const ASSIGN = `mutation($id: ID!, $user: ID!) {
  addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;

type PrNode = {
  id: string; state: string; isDraft: boolean; headRefOid: string; headRefName: string; maintainerCanModify: boolean; mergeable: string | null;
  headRepository: { nameWithOwner: string } | null; assignees?: { nodes?: { login: string }[] };
};

export type Who = { login: string; nodeId: string; email: string };

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

  /** A fixups row and a stages row: `hold` for the two states that need a person, else the PR's `take` stage with a note. */
  fixup(c: FixCandidate, state: "pushed" | "failed" | "refused" | "rejected" | "cannot-push" | "too-large" | "asked", reason: string | null, files: string[], toHead: string | null = null): void {
    const at = this.at();
    if (c.carry) {
      // A carry-over keeps its own record; the PR's take-fix tries and stage are not touched.
      const ended = state === "pushed" || state === "asked" || state === "cannot-push" || state === "too-large";
      const tried = !ended;
      const next = ended || c.attempt >= MAX_ATTEMPTS ? (state === "pushed" || state === "asked" ? "done" : "held") : "queued";
      this.db.prepare("UPDATE dupe_carries SET state = ?, attempts = attempts + ?, outcome = ?, to_head = ?, updated_at = ? WHERE decision_id = ? AND number = ?")
        .run(next, tried || state === "pushed" ? 1 : 0, reason ? `${state}: ${reason}` : state, toHead, at, c.carry.decisionId, c.number);
      return;
    }
    this.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, reason, files, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.repo, c.number, c.head, toHead, state, reason, JSON.stringify(files), c.attempt, at);
    const hold = state === "cannot-push" || state === "too-large";
    const note = state === "pushed" ? `fix-up pushed at ${short(c.head)}: ${files.join(", ")}`
      : state === "asked" ? `asked the contributor for changes at ${short(c.head)}: ${files.join(", ")}` : `fix-up ${state} at ${short(c.head)}: ${reason}`;
    this.db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.repo, c.number, hold ? "hold" : "take", at, ACTOR, hold ? reason : note);
  }
}

export async function runFixup(db: DatabaseSync, params: FixupParams, log: (line: string) => void = console.log, deps?: FixupDeps): Promise<FixupSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `fixup-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const summary: FixupSummary = { runId, repo, dryRun, pushed: [], asked: [], failed: [], held: [] };
  const sel = selectFixups(db, repo);
  const asks = params.limit === undefined ? sel.ask : sel.ask.slice(0, params.limit);
  const picks = params.limit === undefined ? sel.fix : sel.fix.slice(0, Math.max(0, params.limit - asks.length));
  log(`fixup ${repo}: ${sel.fix.length} PRs to fix up, ${sel.cannotPush.length + sel.ask.length} we can't push to${pushApprovalOf(db, repo) ? "" : " (pushing is not approved for this repo)"}`);
  if (dryRun) {
    for (const c of picks) log(`  would fix up ${refOf(c)} at ${short(c.head)} (try ${c.attempt}): ${[...new Set(c.fixes.map((f) => f.file))].join(", ")}`);
    for (const c of asks) log(`  would comment the fixes on ${refOf(c)} at ${short(c.head)}`);
    for (const c of sel.cannotPush) log(`  would hold ${refOf(c)}: ${HOLD_CANNOT_PUSH}`);
    log(`fixup ${repo}: dry run, nothing called or written`);
    return summary;
  }
  const d = deps ?? defaultDeps();
  const rec = new Recorder(db, at);

  // Not approved for comments: no GitHub write, recorded once per head.
  for (const c of sel.cannotPush) {
    rec.fixup(c, "cannot-push", HOLD_CANNOT_PUSH, []);
    summary.held.push({ ref: refOf(c), reason: HOLD_CANNOT_PUSH });
    log(`  ${refOf(c)}: held: ${HOLD_CANNOT_PUSH}`);
  }
  let handled = 0;
  const askOne = async (c: FixCandidate, count = true) => {
    const ref = refOf(c);
    try {
      const r = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
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
      const cm = await d.exec("gh", ["pr", "comment", String(c.number), "--repo", `${ORG}/${repo}`, "--body-file", "-"], { input: body });
      if (cm.code !== 0) { log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`); return; }
      rec.fixup(c, "asked", null, [...new Set(c.fixes.map((f) => f.file))]);
      audit(db, ACTOR, "fixup-comment", ref, { run: runId, head: c.head, text: body });
      if (count) params.onHandled?.(++handled);
      summary.asked.push(ref);
      log(`  ${ref}: asked the contributor for changes at ${short(c.head)}`);
    } catch (e) {
      log(`  ${ref}: not asked: ${oneLine(String((e as Error).message ?? e))}`);
    }
  };
  for (const c of asks) await askOne(c);
  if (!picks.length) return summary;

  const who = await whoAmI(d.exec);
  const git = new Git(d.exec, d.root, repo);
  mkdirSync(d.root, { recursive: true });
  for (const c of picks) {
    const ref = refOf(c);
    let files = [...new Set(c.fixes.map((f) => f.file))];
    const fail = (state: "failed" | "refused" | "rejected", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.fixup(c, state, reason, files);
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    const hold = (state: "cannot-push" | "too-large", raw: string) => {
      const reason = scrubReason(raw, d.root);
      rec.fixup(c, state, reason, files);
      summary.held.push({ ref, reason });
      log(`  ${ref}: held: ${reason}`);
    };
    try {
      if (!c.carry && files.some((f) => !editable(f))) { hold("too-large", "the fixes name files a fix-up may not edit"); continue; }
      const r = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR`); continue; }
      if (pr.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(pr.headRefOid)} since the review`); continue; }
      params.onHandled?.(++handled);
      if (!pr.maintainerCanModify || !pr.headRepository) {
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
      if (pr.mergeable === "CONFLICTING") { log(`  ${ref}: skipped: conflicts with the base branch`); continue; }

      const head = await git.fetchPr(ORG, repo, c.number);
      if (head !== c.head) { log(`  ${ref}: skipped: fetched head ${short(head)} is not the reviewed ${short(c.head)}`); continue; }

      const shown: FixupPr["files"] = [];
      let total = 0, tooBig: string | null = null, bad: string | null = null;
      for (const path of files) {
        const f = await git.file(head, path);
        if (!f.ok) { bad = f.reason; break; }
        total += f.content.length;
        if (f.content.length > FILE_CAP) { tooBig = `${path} is over the ${FILE_CAP} character limit`; break; }
        if (total > TOTAL_CAP) { tooBig = `the files named in the fixes are over the ${TOTAL_CAP} character limit`; break; }
        shown.push({ path, content: f.content });
      }
      if (bad) { fail("refused", bad); continue; }
      if (tooBig) { hold("too-large", tooBig); continue; }
      const diff = await cachedDiff(repo, c.number, head, d.fetchDiff);
      if (!diff.ok) { fail("failed", `no diff: ${oneLine(diff.error)}`); continue; }
      if (diff.text.length > DIFF_CAP) { hold("too-large", `the PR diff is over the ${DIFF_CAP} character limit`); continue; }

      const checkout = (await d.checkout?.(repo, c.number, head)) ?? undefined;
      const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
      const reply = await d.ask(db, [{ ref, title: oneTitle(db, c), fixes: c.fixes, files: shown, diff: diff.text, ...(carried ? { carried_from: carried } : {}), ...repoDir }], checkout);
      if (reply === null) { fail("failed", "the model gave no answer"); continue; }
      const v = validatePatch(reply, files);
      if (!v.ok) { fail("refused", v.reason); continue; }

      const scratch = mkdtempSync(join(d.root, ".index-"));
      let applied;
      try {
        applied = await git.applyToTree(head, v.patch, join(scratch, "index"));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      if (!applied.ok) { fail("refused", applied.reason); continue; }
      const commit = await git.commit(applied.tree, head, commitMessage(v.files), { name: who.login, email: who.email });
      const changes = await git.rawChanges(head, commit);
      const touched = changes.map((x) => x[3]!).sort().join("\n");
      if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n")) {
        fail("refused", "the commit would change files or modes outside the validated diff");
        continue;
      }

      // Opus checks the validated patch; only an approve goes on to the push.
      if (v.patch.length > CHECK_PATCH_CAP) { fail("refused", `the patch is over the ${CHECK_PATCH_CAP} character limit for the check`); continue; }
      const checkReply = await d.check(db, [{ ref, title: oneTitle(db, c), review_reason: c.reason, fixes: c.fixes, diff: diff.text.slice(0, CHECK_DIFF_CAP), patch: v.patch, ...(carried ? { carried_from: carried.map((x) => ({ ...x, diff: x.diff.slice(0, Math.floor(CHECK_DIFF_CAP / carried.length)) })) } : {}), ...repoDir }], checkout);
      if (checkReply === null) { fail("failed", "the patch check gave no answer"); continue; }
      const verdict = parseCheck(checkReply);
      if (!verdict.ok) { fail("failed", `the patch check gave no valid answer: ${verdict.error}`); continue; }
      recordCheck(db, { kind: "fixup", repo, number: c.number, subject: head, patch: v.patch, round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: at() });
      audit(db, ACTOR, "fixup-check", ref, { run: runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons });
      if (verdict.check.verdict === "reject") { fail("rejected", `Opus rejected the patch: ${checkLine(verdict.check)}`); continue; }

      // The model calls took minutes: read the PR again before claiming and pushing.
      const again = await d.querier.query(PR_QUERY, { name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const now = again.repository?.pullRequest;
      if (!now || now.state !== "OPEN" || now.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR after the model calls`); continue; }
      if (now.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(now.headRefOid)} during the model calls`); continue; }

      // Claim after the patch is validated and approved, just before the push.
      if (!c.carry && !(now.assignees?.nodes ?? []).length) {
        await d.querier.query(ASSIGN, { id: now.id, user: who.nodeId });
        audit(db, ACTOR, "assign", ref, { run: runId, assignee: who.login });
        log(`  ${ref}: assigned to ${who.login}`);
      }

      const push = await git.push(pr.headRepository.nameWithOwner, pr.headRefName, commit, head);
      if (push.code !== 0) {
        const err = oneLine(push.stderr);
        if (/stale info|rejected|fetch first/i.test(err)) fail("refused", "the branch moved since the review");
        else if (/denied|403|permission|not allowed|protected branch/i.test(err)) hold("cannot-push", HOLD_CANNOT_PUSH);
        else fail("failed", `push failed: ${err}`);
        continue;
      }
      audit(db, ACTOR, "fixup-push", ref, { run: runId, from: head, to: commit, files: v.files, changed: v.changed });
      rec.fixup(c, "pushed", null, v.files, commit);
      summary.pushed.push(ref);
      log(`  ${ref}: pushed ${short(commit)} on ${short(head)}: ${v.files.join(", ")}`);

      const body = c.carry ? carryCommentText(c.carry.sources.map((x) => x.number), v.files) : commentText(v.files);
      const cm = await d.exec("gh", ["pr", "comment", String(c.number), "--repo", `${ORG}/${repo}`, "--body-file", "-"], { input: body });
      if (cm.code === 0) audit(db, ACTOR, "fixup-comment", ref, { run: runId, text: body });
      else log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
    } catch (e) {
      fail("failed", oneLine(String((e as Error).message ?? e)));
    }
  }
  log(`fixup ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} asked, ${summary.failed.length} failed, ${summary.held.length} held; run ${runId}`);
  return summary;
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
    const paths = [...new Set([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!))].filter(editable);
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
    summary: "fixup --repo R [--limit N] [--apply]: push the review's small fixes to take-fix PRs we may push to (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
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
