// Stage 6, Integrate (batches): lands the merge-eligible PRs of a repo together. A batch is built from the
// default branch by merging each PR head with a merge commit (so GitHub marks every contributor PR merged when
// the batch lands), checked in the sandbox as one tree, pushed to the pipeline account's fork, opened as a PR
// and merged through the merge command once upstream CI is green.
//
//   craft-auto merge-batches --repo R [--limit N]    (the runner's merge step calls runBatches)
//
// One run advances every batch of the repo in flight, then starts the next batch when none is left. A failed
// batch is split in half and each half retried; a single PR that fails goes on hold. When the default branch
// moves, the batch is rebuilt on the new head. Every GitHub write goes through `exec` / `run`.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createTask, getTask, MAX_PATCH_BYTES, TERMINAL, warmKeyOf } from "../build/tasks.ts";
import { cloneTask } from "../verify/tasks.ts";
import { audit } from "../dash/audit.ts";
import { type Exec, exec, fixupDir } from "../fixup/git.ts";
import { whoAmI } from "../fixup/index.ts";
import { branchOf, forkOf } from "../fixissue/index.ts";
import type { Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { type Verdict, outcomeOf, summariseFailure } from "../verify/results.ts";
import { rustPlan } from "../worker/rust.ts";
import { BatchGit } from "./batch-git.ts";
import { ACTIVE_BATCH, activeBatches, admits, batchSizeOf, getBatch, growBatchSize, insertBatch, membersOf, nextBranch, shrinkBatchSize, updateBatch, type BatchMember, type BatchRow } from "./batch-store.ts";
import { mergeApprovalOf } from "./approval.ts";
import { ASSIGN, ORG, prInfo, viewerOf, spawnRun, type CommandResult } from "./index.ts";
import { PIPELINE_LOGIN_KEY, VERIFY_UNAVAILABLE, buildQueue, eligible, type QueueEntry } from "./queue.ts";

const ACTOR = "batch";
const PR_URL = new RegExp(`^https://github\\.com/${ORG}/[A-Za-z0-9._-]+/pull/(\\d+)$`);
const MAX_RETRIES = 1;

export type BatchDeps = {
  /** Every git and gh command. */
  exec: Exec;
  querier: Querier;
  /** Runs the merge command (`$CRAFT_AUTO_MERGE_CMD`, default safe-merge). */
  run: (cmd: string, args: string[]) => Promise<CommandResult>;
  mergeCommand: string;
  /** The head commit of the repo's default branch, or null. */
  mainHead: (repo: string, branch: string) => Promise<string | null>;
  /** Haiku's account of a failed step, scrubbed. */
  summarise: (db: DatabaseSync, v: { repo: string; number: number }, taskId: number, f: NonNullable<Verdict["failed"]>, runId: string) => Promise<string>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
};

export type BatchParams = {
  repo: string;
  /** Most PRs this run may start or land (the stage's daily limit left). */
  limit?: number;
  /** Called with the running count of PRs merged. */
  onMerged?: (merged: number) => void;
};

export type BatchSummary = { runId: string; repo: string; started: string[]; published: string[]; merged: number[]; failed: number[]; split: string[]; superseded: string[]; waiting: string[] };

const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);

type Cand = { number: number; head: string; size: string; lines: number };

export async function defaultBatchDeps(): Promise<BatchDeps> {
  const { Client } = await import("../mirror.ts");
  const { defaultDeps } = await import("../fixissue/index.ts");
  const { CLAUDE_PROMPTS } = await import("../prompts/index.ts");
  const model = CLAUDE_PROMPTS["verify.summary"].models[0]!;
  return {
    exec, querier: new Client(1000), run: spawnRun, mergeCommand: process.env.CRAFT_AUTO_MERGE_CMD || "safe-merge",
    mainHead: defaultDeps().mainHead, now: () => new Date(), root: fixupDir(),
    summarise: (db, v, taskId, f, runId) => summariseFailure(db, v, taskId, f, { model }, runId),
  };
}

export async function runBatches(db: DatabaseSync, params: BatchParams, log: (line: string) => void = console.log, deps?: BatchDeps): Promise<BatchSummary> {
  const d = deps ?? await defaultBatchDeps();
  const { repo } = params;
  if (!mergeApprovalOf(db, repo)) throw new Error(`merging in ${repo} is not approved`);
  const at = () => d.now().toISOString();
  const runId = `batch-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: BatchSummary = { runId, repo, started: [], published: [], merged: [], failed: [], split: [], superseded: [], waiting: [] };
  mkdirSync(d.root, { recursive: true });
  const git = new BatchGit(d.exec, d.root, repo);
  const stage = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)");
  let landed = 0;

  const refOf = (n: number) => `${repo}#${n}`;
  const branch = branchOf(db, repo);
  const closePr = async (b: BatchRow, why: string) => {
    if (b.pr_number === null) return;
    const r = await d.exec("gh", ["pr", "close", String(b.pr_number), "--repo", `${ORG}/${repo}`, "--comment", why]);
    if (r.code !== 0) log(`  ${b.branch}: could not close the batch PR: ${oneLine(r.stderr)}`);
  };

  /** Builds a batch of the candidates, in order, from the current head of the default branch; null when no PR could be merged. */
  async function startBatch(cands: Cand[], max: number, parentId: number | null): Promise<number | null> {
    const base = await git.fetchMain(ORG, repo, branch);
    const who = await whoAmI(d.exec);
    db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(PIPELINE_LOGIN_KEY, who.login);
    const chain: { cand: Cand; commit: string }[] = [];
    let cur = base;
    for (const c of cands) {
      if (chain.length && !admits(chain.map((x) => x.cand), c, max)) continue;
      const sha = await git.fetchPr(ORG, repo, c.number);
      if (sha !== c.head) { log(`  ${refOf(c.number)}: head moved to ${short(sha)}; left out`); continue; }
      const tree = await git.mergeTree(cur, sha);
      if (!tree) { log(`  ${refOf(c.number)}: conflicts with the batch so far; waits for the next one`); continue; }
      cur = await git.mergeCommit(tree, [cur, sha], `Merge pull request #${c.number}`, { name: who.login, email: who.email });
      chain.push({ cand: c, commit: cur });
    }
    // The sandbox applies the combined change as a text diff of at most MAX_PATCH_BYTES.
    let patch = "";
    while (chain.length) {
      patch = await git.diff(base, chain[chain.length - 1]!.commit);
      const bad = Buffer.byteLength(patch) > MAX_PATCH_BYTES ? "larger than the task limit" : /^Binary files /m.test(patch) ? "binary content" : "";
      if (!bad) break;
      log(`  ${refOf(chain[chain.length - 1]!.cand.number)}: the combined diff is ${bad}; left out`);
      chain.pop();
    }
    if (!chain.length || !patch) return null;
    const tip = chain[chain.length - 1]!.commit;
    const taskId = createTask(db, {
      step: "merge-batch", repo, headSha: base, baseSha: base, requires: { os: "linux", toolchains: ["rust-stable"] },
      plan: rustPlan({ cargoArgs: ["--workspace"] }), patch, warm: { key: warmKeyOf(repo), role: "use" },
    });
    const name = nextBranch(db, repo, d.now());
    const members: BatchMember[] = chain.map((x) => ({ number: x.cand.number, head_oid: x.cand.head }));
    const id = insertBatch(db, { repo, branch: name, baseSha: base, commitSha: tip, parentId, taskId, members, at: at() });
    audit(db, ACTOR, "batch-start", `${repo}:${name}`, { run: runId, base, prs: members.map((m) => m.number) });
    s.started.push(name);
    log(`  ${name}: ${members.length} PR${members.length === 1 ? "" : "s"} (${members.map((m) => `#${m.number}`).join(", ")}) on ${short(base)}; checking in the sandbox`);
    return id;
  }

  const asCands = (ms: BatchMember[]): Cand[] => ms.map((m) => ({ number: m.number, head: m.head_oid, size: "S", lines: 0 }));

  /** The batch's PRs are rebuilt on the current default branch head, leaving out `members` that changed. */
  async function supersede(b: BatchRow, keep: BatchMember[], why: string): Promise<void> {
    updateBatch(db, b.id, at(), { state: "superseded", summary: why });
    await closePr(b, `Closing: ${why}. The PRs are rebuilt in a new batch.`);
    s.superseded.push(b.branch);
    log(`  ${b.branch}: ${why}`);
    if (keep.length) await startBatch(asCands(keep), Infinity, b.id);
  }

  /** A failed batch: several PRs split in half and each half retried; one PR goes on hold. */
  async function fail(b: BatchRow, why: string, ctx?: { taskId: number; failed: NonNullable<Verdict["failed"]> }): Promise<void> {
    const members = membersOf(db, b.id);
    shrinkBatchSize(db, repo);
    await closePr(b, "Closing: the batch failed. Its PRs are retried in smaller batches or held.");
    if (members.length === 1) {
      const m = members[0]!;
      let summary = why;
      if (ctx) summary = await d.summarise(db, { repo, number: m.number }, ctx.taskId, ctx.failed, runId).catch(() => why);
      updateBatch(db, b.id, at(), { state: "failed", summary: oneLine(summary, 400) });
      stage.run(repo, m.number, "hold", at(), ACTOR, `batch failed at ${short(m.head_oid)}: ${oneLine(summary, 200)}`);
      audit(db, ACTOR, "batch-hold", refOf(m.number), { run: runId, batch: b.branch, summary: oneLine(summary, 200) });
      s.failed.push(m.number);
      log(`  ${b.branch}: ${refOf(m.number)} failed alone; on hold: ${oneLine(summary, 120)}`);
      return;
    }
    updateBatch(db, b.id, at(), { state: "split", summary: oneLine(why, 400) });
    s.split.push(b.branch);
    log(`  ${b.branch}: ${why}; splitting ${members.length} PRs in half`);
    const mid = Math.ceil(members.length / 2);
    for (const half of [members.slice(0, mid), members.slice(mid)]) {
      if (activeBatches(db, repo).length >= 8) break;
      await startBatch(asCands(half), Infinity, b.id);
    }
  }

  async function publish(b: BatchRow, members: BatchMember[]): Promise<void> {
    const head = await d.mainHead(repo, branch);
    if (head && head !== b.base_sha) return supersede(b, members, `${branch} moved to ${short(head)}`);
    const who = await whoAmI(d.exec);
    const fork = await forkOf(d.exec, who.login, repo);
    const push = await git.pushNew(fork, b.branch, b.commit_sha);
    if (push.code !== 0) { log(`  ${b.branch}: push failed: ${oneLine(push.stderr)}`); s.waiting.push(b.branch); return; }
    audit(db, ACTOR, "batch-push", `${repo}:${b.branch}`, { run: runId, commit: b.commit_sha, fork });
    const links = members.map((m) => `- [${repo}#${m.number}](https://github.com/${ORG}/${repo}/pull/${m.number})`).join("\n");
    const body = `Lands ${members.length} reviewed and verified pull request${members.length === 1 ? "" : "s"} together. Each one is merged with its own commits.\n\n${links}\n`;
    const pr = await d.exec("gh", ["pr", "create", "--repo", `${ORG}/${repo}`, "--base", branch, "--head", `${fork.split("/")[0]}:${b.branch}`, "--title", `Integration batch ${b.branch}`, "--body-file", "-"], { input: body });
    const url = pr.stdout.trim().split("\n").pop() ?? "";
    const m = url.match(PR_URL);
    if (pr.code !== 0 || !m) { log(`  ${b.branch}: batch PR not opened: ${oneLine(pr.stderr || pr.stdout)}`); s.waiting.push(b.branch); return; }
    updateBatch(db, b.id, at(), { state: "open", pr_number: Number(m[1]), pr_url: url });
    audit(db, ACTOR, "batch-pr", `${repo}:${b.branch}`, { run: runId, url });
    s.published.push(b.branch);
    log(`  ${b.branch}: opened ${url}`);
  }

  async function land(b: BatchRow, members: BatchMember[], q: QueueEntry[]): Promise<void> {
    const head = await d.mainHead(repo, branch);
    if (head && head !== b.base_sha) return supersede(b, members, `${branch} moved to ${short(head)}`);
    const [ch] = await refreshChecks(db, d.querier, repo, [b.pr_number!]);
    if (!ch) { s.waiting.push(b.branch); return; }
    if (ch.state === "CLOSED") { updateBatch(db, b.id, at(), { state: "failed", summary: "the batch PR was closed" }); s.failed.push(...members.map((m) => m.number)); return; }
    if (ch.overall === "failure") return fail(b, "upstream CI failed on the batch PR");
    if (ch.overall !== "success" || ch.mergeable !== "MERGEABLE") { s.waiting.push(b.branch); return; }
    const info = await prInfo(d.querier, repo, b.pr_number!);
    if (!info) { s.waiting.push(b.branch); return; }
    if (info.head !== b.commit_sha) { log(`  ${b.branch}: the batch branch moved from ${short(b.commit_sha)} to ${short(info.head)}; not merged`); s.waiting.push(b.branch); return; }
    if (!info.assignees.length) {
      const me = await viewerOf(d.querier);
      await d.querier.query(ASSIGN, { id: info.id, user: me.id });
    }
    const r = await d.run(d.mergeCommand, [`${ORG}/${repo}`, String(b.pr_number), "--merge"]);
    if (r.code !== 0) {
      const why = oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`;
      updateBatch(db, b.id, at(), { summary: `${d.mergeCommand}: ${why}`.slice(0, 400) });
      log(`  ${b.branch}: refused: ${why}`);
      s.waiting.push(b.branch);
      return;
    }
    updateBatch(db, b.id, at(), { state: "merged", summary: null });
    for (const m of members) {
      const e = q.find((x) => x.number === m.number);
      db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome, reason, ci, mergeable) VALUES (?, ?, ?, ?, ?, ?, 'merge', 'merged', NULL, ?, ?)")
        .run(repo, m.number, m.head_oid, runId, at(), e?.path ?? "rule", e?.ci ?? "success", e?.mergeable ?? "MERGEABLE");
      stage.run(repo, m.number, "merged", at(), ACTOR, `merge in ${b.branch} at ${short(m.head_oid)}`);
      audit(db, ACTOR, "merge", refOf(m.number), { run: runId, head: m.head_oid, method: "merge", batch: b.branch });
      if (e?.path === "operator" && e.decisionId) db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(at(), e.decisionId);
      s.merged.push(m.number);
    }
    growBatchSize(db, repo);
    landed += members.length;
    params.onMerged?.(landed);
    log(`  ${b.branch}: merged ${members.length} PR${members.length === 1 ? "" : "s"}`);
  }

  async function advance(id: number): Promise<void> {
    const b = getBatch(db, id);
    if (!ACTIVE_BATCH.includes(b.state)) return;
    const members = membersOf(db, b.id);
    const q = buildQueue(db, { repo, merged: "exclude" });
    const keep = members.filter((m) => q.some((e) => e.number === m.number && e.head === m.head_oid && (e.state === "batch-checking" || e.state === "in-batch")));
    if (keep.length < members.length) return supersede(b, keep, "a PR in the batch changed or is no longer ready");
    if (b.state === "open") return land(b, members, q);
    const task = b.task_id === null ? null : getTask(db, b.task_id);
    if (!task || !TERMINAL.includes(task.state)) { s.waiting.push(b.branch); return; }
    const out = outcomeOf(task);
    if (out.kind === "pass") return publish(b, members);
    if (out.kind === "fail") {
      const failed = { role: "head" as const, step: out.step, exitCode: out.exitCode, timedOut: out.timedOut };
      return fail(b, `the combined tree failed at ${out.step}`, { taskId: task.id, failed });
    }
    if (b.retries < MAX_RETRIES) {
      updateBatch(db, b.id, at(), { task_id: cloneTask(db, task.id), retries: b.retries + 1 });
      log(`  ${b.branch}: ${out.reason}; queued the sandbox task again`);
      return;
    }
    return fail(b, `the sandbox could not check the batch: ${out.reason}`);
  }

  for (const b of activeBatches(db, repo)) await advance(b.id);

  if (!activeBatches(db, repo).length && (params.limit === undefined || params.limit > 0)) {
    const q = buildQueue(db, { repo, merged: "exclude" });
    const scores = new Map((db.prepare("SELECT number, score FROM item_rank WHERE repo = ?").all(repo) as { number: number; score: number }[]).map((r) => [r.number, r.score]));
    const lines = db.prepare("SELECT COALESCE(additions, 0) + COALESCE(deletions, 0) AS n FROM items WHERE repo = ? AND number = ?");
    // Verify-unavailable repos cannot be built in the sandbox: the single-PR merge handles those.
    const ranked = q.filter((e) => eligible(e) && e.verify?.state !== VERIFY_UNAVAILABLE)
      .sort((a, b) => (scores.get(b.number) ?? -1) - (scores.get(a.number) ?? -1) || a.number - b.number)
      .map((e): Cand => ({ number: e.number, head: e.head, size: e.size, lines: (lines.get(repo, e.number) as { n: number } | undefined)?.n ?? 0 }));
    if (ranked.length) {
      const max = Math.min(batchSizeOf(db, repo), params.limit ?? Infinity);
      log(`merge ${repo}: ${ranked.length} PRs may merge; batch of up to ${max}`);
      await startBatch(ranked, max, null);
    }
  }
  log(`merge ${repo}: ${s.merged.length} merged, ${s.started.length} batches started, ${s.published.length} opened, ${s.split.length} split, ${s.superseded.length} rebuilt, ${s.waiting.length} waiting; run ${runId}`);
  return s;
}

export const commands = {
  "merge-batches": {
    summary: "merge-batches --repo R [--limit N]: advance the repo's integration batches and start the next one (needs merge approval)",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo"), l = args.indexOf("--limit");
      if (i < 0 || !args[i + 1]) throw new Error("missing --repo");
      const { connect } = await import("../db.ts");
      await runBatches(connect(), { repo: args[i + 1]!, ...(l >= 0 ? { limit: Number(args[l + 1]) } : {}) });
    },
  },
};
