// Fix-up for conflicted take / take-fix PRs: merge the default branch into the PR's branch. A clean merge needs no model.
// Conflicts go to Sonnet, which returns resolved file contents; our code validates them, Opus checks the result, and the
// merge commit (head first, base second) is pushed with a lease. Never a rebase or a force-push. Like the rest of
// Fix-up, no working tree exists: the checkout is untrusted data (see git.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { REPO_PATH } from "../sandbox/command.ts";
import { audit } from "../dash/audit.ts";
import { ghComment, pushBranch, type Writer } from "../github/write.ts";
import { cachedDiff } from "../review/diff.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { BASE_NAME, classifyConflicts, MAX_CONFLICT_TRIES, type ConflictCandidate } from "./conflict-state.ts";
import type { Git } from "./git.ts";
import { noteLive, type FixupDeps, type FixupSummary, type PrNode, type Who } from "./index.ts";
import { endNewline, hasMarkers, keepsOutside, parseResolution, resolvablePath, type ConflictPr } from "./patch.ts";
import { BASE_ORG, longLivedOf, pushable } from "./pushable.ts";
import { conflictAskText, conflictCommentText, mergeMessage } from "./template.ts";

const CHECK = CLAUDE_PROMPTS["fixup.check"];
const FILE_CAP = 40_000;
const TOTAL_CAP = 120_000;


export type ConflictRun = {
  repo: string; runId: string; log: (line: string) => void; d: FixupDeps; gw: Writer; at: () => string; summary: FixupSummary;
  prQuery: string; scrub: (raw: string) => string; who: () => Promise<Who>; git: () => Git;
  /** Called once per PR handled. */
  onHandled?: (n: number) => void; handled: { n: number };
  /** Assigns the PR to the pipeline's account when nobody is assigned; takes our assignment back when the stage gives up. */
  claim: (c: ConflictCandidate, pr: PrNode) => Promise<void>;
  release: (c: ConflictCandidate) => Promise<void>;
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Conflict work for a repo: what to merge and whom to ask, in work order. */
export function selectConflicts(db: DatabaseSync, repo: string): { merge: ConflictCandidate[]; ask: ConflictCandidate[] } {
  const all = classifyConflicts(db, repo);
  return { merge: all.filter((x) => x.bucket === "merge").map((x) => x.c), ask: all.filter((x) => x.bucket === "ask").map((x) => x.c) };
}

function record(db: DatabaseSync, at: string, c: ConflictCandidate, state: string, reason: string | null, files: string[], base: string | null, toHead: string | null = null): void {
  db.prepare("INSERT INTO conflict_merges (repo, number, from_head, to_head, base_sha, state, reason, files, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(c.repo, c.number, c.head, toHead, base, state, reason, JSON.stringify(files), c.attempt, at);
  db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'take', ?, 'fixup', ?)")
    .run(c.repo, c.number, at, state === "merged" ? `merged ${c.base} at ${short(c.head)}: ${files.length ? files.join(", ") : "no conflicts"}` : state === "asked" ? `asked the contributor to merge ${c.base} at ${short(c.head)}` : `conflict merge ${state} at ${short(c.head)}: ${reason}`);
}

async function live(db: DatabaseSync, x: ConflictRun, c: ConflictCandidate): Promise<PrNode | null> {
  const r = await x.d.querier.query(x.prQuery, { name: x.repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
  const pr = r.repository?.pullRequest;
  noteLive(db, x.repo, c.number, pr, x.at());
  if (!pr || pr.state !== "OPEN" || pr.isDraft) { x.log(`  ${refOf(c)}: skipped: no longer an open, non-draft PR`); return null; }
  if (pr.headRefOid !== c.head) { x.log(`  ${refOf(c)}: skipped: head moved to ${short(pr.headRefOid)} since the review`); return null; }
  return pr;
}

/** One comment per head asking the contributor to bring the base branch in, for a branch we can't push to. */
export async function askConflict(db: DatabaseSync, x: ConflictRun, c: ConflictCandidate): Promise<void> {
  const ref = refOf(c);
  try {
    const pr = await live(db, x, c);
    if (!pr) return;
    if (pr.mergeable !== "CONFLICTING") { x.log(`  ${ref}: skipped: GitHub no longer reports a conflict`); return; }
    if (!BASE_NAME.test(c.base)) { x.log(`  ${ref}: skipped: unusable base branch name`); return; }
    const cm = await ghComment(x.gw, x.d.exec, "conflict-comment", { repo: x.repo, number: c.number, pr: true }, conflictAskText(c.base), { run: x.runId, head: c.head });
    if (cm.code !== 0) { x.log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`); return; }
    record(db, x.at(), c, "asked", null, [], null);
    x.summary.asked.push(ref);
    x.onHandled?.(++x.handled.n);
    x.log(`  ${ref}: asked the contributor to merge ${c.base} at ${short(c.head)}`);
  } catch (e) {
    x.log(`  ${ref}: not asked: ${oneLine(String((e as Error).message ?? e))}`);
  }
}

/** Merges the base branch into one PR and pushes the merge commit. */
export async function mergeConflict(db: DatabaseSync, x: ConflictRun, c: ConflictCandidate): Promise<void> {
  const ref = refOf(c);
  let files: string[] = [];
  let baseSha: string | null = null;
  let gaveUp = false;
  const fail = (state: "failed" | "refused" | "rejected", raw: string) => {
    if (c.attempt >= MAX_CONFLICT_TRIES) gaveUp = true;
    const reason = x.scrub(raw);
    record(db, x.at(), c, state, reason, files, baseSha);
    x.summary.failed.push({ ref, reason });
    x.log(`  ${ref}: conflict merge ${state}: ${reason}`);
  };
  /** A skip that holds at every run for this head: recorded once so the PR is not selected again. */
  const skip = (why: string) => { x.log(`  ${ref}: skipped: ${why}`); record(db, x.at(), c, "skipped", why, [], baseSha); };
  const held = (state: "push-denied", reason: string) => {
    gaveUp = true;
    record(db, x.at(), c, state, reason, files, baseSha);
    x.summary.held.push({ ref, reason });
    x.log(`  ${ref}: held: ${reason}`);
  };
  try {
    if (!BASE_NAME.test(c.base)) { skip("unusable base branch name"); return; }
    const pr = await live(db, x, c);
    if (!pr) return;
    if (pr.mergeable !== "CONFLICTING") { x.log(`  ${ref}: skipped: GitHub no longer reports a conflict`); return; }
    if (!pr.headRepository || !pushable(pr.headRepository.nameWithOwner, x.repo, pr.maintainerCanModify, pr.headRefName, longLivedOf(db, x.repo), !!pr.headRef?.branchProtectionRule)) { x.log(`  ${ref}: skipped: the branch is no longer pushable`); return; }
    x.onHandled?.(++x.handled.n);
    const git = x.git();
    const head = await git.fetchPr(BASE_ORG, x.repo, c.number);
    if (head !== c.head) { x.log(`  ${ref}: skipped: fetched head ${short(head)} is not the reviewed ${short(c.head)}`); return; }
    baseSha = await git.fetchBase(BASE_ORG, x.repo, c.base);
    if ((await git.git(["merge-base", "--is-ancestor", baseSha, head])).code === 0) { skip(`${c.base} is already in the branch`); return; }
    await x.claim(c, pr);
    const who = await x.who();
    const merge = await git.mergeInto(head, baseSha);
    let tree = merge.tree;
    let resolved: { path: string; conflicted: string; resolved: string }[] = [];
    let diff = "";
    let checkout: string | undefined;
    if (!merge.clean) {
      files = merge.conflicted;
      if (!files.length) { fail("refused", "the merge is not clean but names no conflicted file"); return; }
      const shown: ConflictPr["files"] = [];
      const modes = new Map<string, string>();
      let total = 0;
      for (const path of files) {
        if (!resolvablePath(path)) { fail("refused", `${path} is not a file a conflict resolution may touch`); return; }
        const f = await git.file(merge.tree, path);
        if (!f.ok) { fail("refused", f.reason); return; }
        if (!hasMarkers(f.content)) { fail("refused", `${path} conflicts without content markers`); return; }
        if (f.content.includes("\r") || f.content.includes("\uFFFD")) { fail("refused", `${path} has CRLF line endings or is not UTF-8`); return; }
        total += f.content.length;
        if (f.content.length > FILE_CAP || total > TOTAL_CAP) { fail("refused", "the conflicted files are over the size limit"); return; }
        modes.set(path, f.mode);
        shown.push({ path, content: f.content });
      }
      const prDiff = await cachedDiff(x.repo, c.number, head, x.d.fetchDiff);
      if (!prDiff.ok) { fail("failed", `no diff: ${oneLine(prDiff.error)}`); return; }
      if (!x.d.resolve) { fail("failed", "no resolver"); return; }
      checkout = (await x.d.checkout?.(x.repo, c.number, head)) ?? undefined;
      const body = ((db.prepare("SELECT body FROM items WHERE repo = ? AND number = ?").get(x.repo, c.number) as { body: string | null } | undefined)?.body ?? "").slice(0, 4000);
      const reply = await x.d.resolve(db, [{ ref, title: c.title, body, review_reason: c.reason, base: c.base, files: shown, ...(checkout ? { repo_dir: REPO_PATH } : {}) }], checkout);
      if (reply === null) { fail("failed", "the model gave no answer"); return; }
      const res = parseResolution(reply, files);
      if (!res.ok) { fail("refused", res.reason); return; }
      const resFiles = res.files.map((f) => ({ path: f.path, content: endNewline(shown.find((s) => s.path === f.path)!.content, f.content) }));
      const scratch = mkdtempSync(join(x.d.root, ".index-"));
      try {
        tree = await git.withFiles(merge.tree, resFiles.map((f) => ({ path: f.path, mode: modes.get(f.path)!, content: f.content })), join(scratch, "index"));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const moved = resFiles.find((f) => !keepsOutside(shown.find((s) => s.path === f.path)!.content, f.content, f.path));
      if (moved) { fail("refused", `the resolution changes ${moved.path} outside its conflict sections or adds lines that are neither side`); return; }
      const changes = await git.rawChanges(merge.tree, tree);
      if (changes.some((ch) => !files.includes(ch[3]!) || ch[0] !== ch[1])) { fail("refused", "the resolution would change files or modes outside the conflicted files"); return; }
      resolved = resFiles.map((f) => ({ path: f.path, conflicted: shown.find((s) => s.path === f.path)!.content, resolved: f.content }));
      const tentative = await git.commitMerge(tree, [head, baseSha], mergeMessage(c.base, pr.headRefName), { name: who.login, email: who.email });
      diff = await git.diffText(head, tentative);
      if (diff.length > CHECK_PATCH_CAP) { fail("refused", `the merge is over the ${CHECK_PATCH_CAP} character limit for the check`); return; }
      const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
      const checkReply = await x.d.check(db, [{ ref, title: c.title, review_reason: c.reason, fixes: [], diff: prDiff.text.slice(0, CHECK_DIFF_CAP), patch: diff, conflict: { base: c.base, files: resolved.map((r) => ({ path: r.path, conflicted: r.conflicted.slice(0, 20_000), resolved: r.resolved.slice(0, 20_000) })) }, ...repoDir }], checkout);
      if (checkReply === null) { fail("failed", "the patch check gave no answer"); return; }
      const verdict = parseCheck(checkReply);
      if (!verdict.ok) { fail("failed", `the patch check gave no valid answer: ${verdict.error}`); return; }
      recordCheck(db, { kind: "fixup", repo: x.repo, number: c.number, subject: head, patch: diff, round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: x.at() });
      audit(db, "fixup", "fixup-check", ref, { run: x.runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons, conflict: true });
      if (verdict.check.verdict === "reject") { fail("rejected", `Opus rejected the resolution: ${checkLine(verdict.check)}`); return; }
      const again = await live(db, x, c);
      if (!again) return;
    }
    const commit = await git.commitMerge(tree, [head, baseSha], mergeMessage(c.base, pr.headRefName), { name: who.login, email: who.email });
    const push = await pushBranch(x.gw, git, "conflict-push", { repo: x.repo, number: c.number, remote: pr.headRepository.nameWithOwner, branch: pr.headRefName, sha: commit, expected: head }, { run: x.runId, from: head, to: commit, base: c.base, files });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) { held("push-denied", "the branch cannot be pushed to"); return; }
      if (/stale info|rejected|fetch first/i.test(err)) fail("refused", "the branch moved since the review");
      else fail("failed", `push failed: ${err}`);
      return;
    }
    record(db, x.at(), c, "merged", null, files, baseSha, commit);
    x.summary.pushed.push(ref);
    x.log(`  ${ref}: merged ${c.base} into the branch: ${short(commit)} on ${short(head)}${files.length ? `, resolved ${files.join(", ")}` : ""}`);
    const cm = await ghComment(x.gw, x.d.exec, "conflict-comment", { repo: x.repo, number: c.number, pr: true }, conflictCommentText(c.base), { run: x.runId });
    if (cm.code !== 0) x.log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
  } catch (e) {
    fail("failed", oneLine(String((e as Error).message ?? e)));
  } finally {
    if (gaveUp) await x.release(c);
  }
}
