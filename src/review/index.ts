// Stage 5, Review: Sonnet reviews the PRs we want in one repo and records a
// verdict per PR at its head commit. Reads GitHub (diffs, checks); never writes to it.
//
//   autocraft review --repo R [--limit N] [--dry-run]
//   autocraft checks --repo R
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../db.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { claudeRoom } from "../agents/call.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { DEFAULT_CAPS, makeBatches, type Caps } from "./batch.ts";
import { reviewCaps } from "./batch-size.ts";
import { selectCandidates, type Candidate } from "./candidates.ts";
import { checksOf, refreshChecks } from "./checks.ts";
import { MAX_RERUNS_PER_DAY, countRerun, discussionOf, ensurePipelineLogin, liveDiscussion, markReviewsStale, markedStaleSince, staleReviews, type Snapshot } from "./discussion.ts";
import { withdrawMergeQuestion } from "../merge/withdraw.ts";
import { areaOf, cachedDiff, codeDiff, ghDiff, type DiffFetcher } from "./diff.ts";
import { applyDuplicateRule, parseReviewReply, type DiscussionEntry, type Review, type ReviewPr } from "./parse.ts";

const PROMPT = CLAUDE_PROMPTS["review.sonnet"];
/** Code lines above which a PR is held as too large to review automatically. */
export const MAX_CODE_LINES = 1500;
export const TOO_LARGE = "too large to review automatically";

export type ReviewParams = {
  repo: string; limit?: number; dryRun?: boolean;
  /** Called with the running count of PRs sent to the model or held without a call. */
  onHandled?: (n: number) => void;
};
export type ReviewDeps = { querier: Querier; fetchDiff: DiffFetcher; caps: Caps; model: string };
export type ReviewSummary = {
  runId: string; repo: string; candidates: number; bySize: Record<string, number>;
  reviewed: number; verdicts: Record<string, number>; skipped: string[]; missing: string[];
};

const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const SIZE_ORDER = { S: 0, M: 1, L: 2 } as const;

export function defaultDeps(): ReviewDeps {
  return { querier: new Client(1000), fetchDiff: ghDiff, caps: DEFAULT_CAPS, model: PROMPT.models[0]! };
}

/**
 * Stores one review: a `reviews` row keyed to the head commit, then a
 * `reviewed` stages row and a take/hold/close stages row (take-fix counts as take).
 */
export function saveReview(db: DatabaseSync, runId: string, c: Candidate, model: string | null, r: Review, snap: Snapshot | null = null, callSize: number | null = null): void {
  const at = now();
  const again = db.prepare("SELECT at FROM reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(c.repo, c.number, c.head_oid) as { at: string } | undefined;
  if (again && !markedStaleSince(db, c.repo, c.number, again.at)) countRerun(db, c.repo, c.number);
  if (again) withdrawMergeQuestion(db, c.repo, c.number, c.head_oid, at);
  db.prepare(`INSERT OR REPLACE INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, fixes, duplicate_of, overlaps, risks, seen_at, disc_hash, call_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.repo, c.number, c.head_oid, runId, at, model, c.size, r.verdict, r.reason,
    r.fixes.length ? JSON.stringify(r.fixes) : null, r.duplicate_of, JSON.stringify(r.overlaps), JSON.stringify(r.risks), snap?.seen ?? at, snap?.hash ?? null, callSize);
  const stage = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)");
  stage.run(c.repo, c.number, "reviewed", at, "review", `${r.verdict} at ${c.head_oid.slice(0, 7)}: ${r.reason}`);
  stage.run(c.repo, c.number, r.verdict === "take-fix" ? "take" : r.verdict, at, "review", r.reason);
}

const tooLarge = (c: Candidate, why: string): Review =>
  ({ ref: refOf(c), verdict: "hold", reason: `${TOO_LARGE} (${why})`, fixes: [], duplicate_of: null, overlaps: [], risks: [] });

async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries) throw e; }
  }
}

export async function runReview(db: DatabaseSync, params: ReviewParams, log: (line: string) => void = console.log, deps: ReviewDeps = defaultDeps()): Promise<ReviewSummary> {
  const { repo } = params;
  const runId = `review-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  const count = (cs: Candidate[]) => Object.fromEntries((["S", "M", "L"] as const).map((s) => [s, cs.filter((c) => c.size === s).length]));
  let cands = selectCandidates(db, repo);
  const summary: ReviewSummary = { runId, repo, candidates: cands.length, bySize: count(cands), reviewed: 0, verdicts: {}, skipped: [], missing: [] };
  if (params.dryRun) {
    const byLabel = new Map<string, number>();
    for (const c of cands) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
    log(`review ${repo}: ${cands.length} candidates (${Object.entries(summary.bySize).map(([s, n]) => `${n} ${s}`).join(", ")}; ${[...byLabel].map(([l, n]) => `${n} ${l}`).join(", ")}); dry run, nothing fetched or asked`);
    return summary;
  }
  if (!cands.length) {
    log(`review ${repo}: no candidates`);
    return summary;
  }

  // Fresh head commits and CI first: a PR pushed, closed or turned draft since the last sync drops out here.
  await withRetry(() => refreshChecks(db, deps.querier, repo, cands.map((c) => c.number), log));
  await ensurePipelineLogin(db, deps.querier).catch((e) => log(`review ${repo}: could not read the pipeline login (${String((e as Error).message ?? e)})`));
  cands = selectCandidates(db, repo).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || SIZE_ORDER[a.size] - SIZE_ORDER[b.size] || a.number - b.number);
  const uncapped = staleReviews(db, repo, true);
  const capped = [...staleReviews(db, repo)].filter((k) => !uncapped.has(k));
  if (capped.length) log(`review ${repo}: ${capped.join(", ")} not reviewed again: already ${MAX_RERUNS_PER_DAY} re-reviews today after new discussion`);
  if (params.limit !== undefined) cands = cands.slice(0, params.limit);
  summary.candidates = cands.length;
  summary.bySize = count(cands);

  const tally = (r: Review) => { summary.verdicts[r.verdict] = (summary.verdicts[r.verdict] ?? 0) + 1; summary.reviewed++; };
  const inputs: (ReviewPr & { c: Candidate; area: string; diffChars: number; snap: Snapshot })[] = [];
  for (const c of cands) {
    const d = await cachedDiff(repo, c.number, c.head_oid, deps.fetchDiff);
    if (!d.ok) {
      if (d.tooLarge) {
        const r = tooLarge(c, "GitHub refuses the diff");
        saveReview(db, runId, c, null, r);
        tally(r);
      } else {
        log(`  ${refOf(c)}: no diff: ${d.error}`);
        summary.skipped.push(refOf(c));
      }
      continue;
    }
    let cd = codeDiff(d.text);
    // A tests-only PR has no code to read: show its tests instead.
    if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
    if (cd.codeLines > MAX_CODE_LINES || cd.text.length > deps.caps.charsPerCall) {
      const r = tooLarge(c, `${cd.codeLines} changed code lines`);
      saveReview(db, runId, c, null, r);
      tally(r);
      continue;
    }
    const ch = checksOf(db, repo, c.number);
    // The threads are where inline findings sit; without them the review would miss what a reviewer already found.
    let discussion: DiscussionEntry[];
    let snap: Snapshot;
    try {
      ({ entries: discussion, snap } = discussionOf(db, repo, c.number, await withRetry(() => liveDiscussion(deps.querier, db, repo, c.number))));
    } catch (e) {
      log(`  ${refOf(c)}: review threads unavailable (${String((e as Error).message ?? e)}); not reviewed this pass`);
      summary.skipped.push(refOf(c));
      continue;
    }
    inputs.push({
      c, area: areaOf(cd.files), diffChars: cd.text.length,
      ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size,
      lines_changed: c.lines_changed, ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null,
      files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted, same_files_as: [], diff: cd.text, discussion, snap,
    });
  }

  const merged = (ref: string) => {
    const [r, n] = ref.split("#");
    return (db.prepare("SELECT state FROM items WHERE repo = ? AND number = ?").get(r!, Number(n)) as { state: string } | undefined)?.state === "MERGED";
  };
  let handled = summary.reviewed;
  params.onHandled?.(handled);
  const batches = makeBatches(inputs, reviewCaps(db, repo, deps.caps));
  // Related PRs are named only within one call, so a duplicate verdict never points at a PR the model did not see.
  for (const b of batches) for (const p of b) p.same_files_as = b.filter((o) => o !== p && o.files.some((f) => p.files.includes(f))).map((o) => ({ ref: o.ref, title: o.title }));
  log(`review ${repo}: ${inputs.length} PRs to ask in ${batches.length} calls; ${summary.reviewed} held without a call; run ${runId}`);
  await pool(batches.map((batch, n) => async () => {
    const start = now();
    handled += batch.length;
    params.onHandled?.(handled);
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let todo = batch;
    for (let attempt = 0; attempt < PROMPT.limits.attempts && todo.length; attempt++) {
      const strip = todo.map(({ c: _c, area: _a, diffChars: _d, snap: _s, ...pr }) => pr);
      const reply = await askClaude("review.sonnet", deps.model, strip, db);
      if (!reply) continue;
      usage = add(usage, reply.usage);
      const { reviews, missing } = parseReviewReply(reply.text, todo.map((p) => p.ref));
      for (const r of reviews) {
        const p = todo.find((x) => x.ref === r.ref)!;
        const final = applyDuplicateRule(r, merged);
        saveReview(db, runId, p.c, deps.model, final, p.snap, batch.length);
        tally(final);
      }
      todo = todo.filter((p) => missing.includes(p.ref));
    }
    if (todo.length) {
      log(`  batch ${n}: no valid review for ${todo.map((p) => p.ref).join(", ")}`);
      summary.missing.push(...todo.map((p) => p.ref));
    }
    saveUsage(db, runId, `review-${String(n).padStart(2, "0")}`, "review", deps.model, batch.length - todo.length, usage, start, now());
  }), () => claudeRoom(db), { first: true });
  log(`review ${repo}: ${summary.reviewed} reviewed (${Object.entries(summary.verdicts).map(([v, k]) => `${k} ${v}`).join(", ")}); ${summary.skipped.length} skipped, ${summary.missing.length} without an answer`);
  return summary;
}

export type ChecksParams = { repo: string };

/** For the runner: refreshes CI and merge state of every open PR of the repo. */
export async function runChecks(db: DatabaseSync, params: ChecksParams, log: (line: string) => void = console.log, querier: Querier = new Client(1000)): Promise<{ prs: number }> {
  const rows = await withRetry(() => refreshChecks(db, querier, params.repo, undefined, log));
  return { prs: rows.length };
}

function parseArgs(args: string[], allowed: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const n = args[i]!.replace(/^--/, "");
    if (!allowed.includes(n)) throw new Error(`unknown option ${args[i]}; options: ${allowed.map((a) => "--" + a).join(" ")}`);
    if (n === "dry-run" || n === "single") out[n] = true;
    else {
      const v = args[++i];
      if (v === undefined) throw new Error(`--${n} needs a value`);
      out[n] = v;
    }
  }
  return out;
}

export const commands = {
  review: {
    summary: "review --repo R [--limit N] [--dry-run]: Sonnet code review of wanted PRs, one verdict per head commit; review again REPO#N [--by LOGIN]: review a PR again; review batch-size --repo R [--set N|default]: PRs per first-pass call; review crosscheck --repo R --sample N [--single] [--seed S] and review crosscheck-report [--run ID]: check Sonnet batch holds against Opus",
    async run(args: string[]): Promise<void> {
      if (args[0] === "again") {
        const m = /^([\w.-]+)#(\d+)$/.exec(args[1] ?? "");
        const by = args[2] === "--by" && args[3] ? args[3] : "cli";
        if (!m || args.length !== (args[2] ? 4 : 2)) throw new Error("usage: autocraft review again <repo>#<number> [--by <login>]");
        const db = connect();
        const open = db.prepare("SELECT 1 FROM items WHERE repo = ? AND number = ? AND kind = 'pr' AND state = 'OPEN'").get(m[1]!, Number(m[2]));
        if (!open) throw new Error(`${args[1]} is not an open pull request in the mirror`);
        markReviewsStale(db, by, m[1]!, Number(m[2]));
        console.log(`${args[1]}: its reviews are stale; Sonnet and then Opus review it again`);
        return;
      }
      if (args[0] === "crosscheck") {
        const f = parseArgs(args.slice(1), ["repo", "sample", "single", "seed"]);
        const sample = Number(f.sample);
        if (typeof f.repo !== "string" || !(Number.isInteger(sample) && sample > 0)) throw new Error("usage: autocraft review crosscheck --repo R --sample N [--single] [--seed S]");
        const { runCrosscheck } = await import("./crosscheck.ts");
        await runCrosscheck(connect(), { repo: f.repo, sample, single: f.single === true, seed: typeof f.seed === "string" ? f.seed : undefined });
        return;
      }
      if (args[0] === "crosscheck-report") {
        const f = parseArgs(args.slice(1), ["run"]);
        const { crosscheckReport } = await import("./crosscheck.ts");
        console.log(crosscheckReport(connect(), typeof f.run === "string" ? f.run : undefined));
        return;
      }
      if (args[0] === "batch-size") {
        const f = parseArgs(args.slice(1), ["repo", "set"]);
        if (typeof f.repo !== "string") throw new Error("usage: autocraft review batch-size --repo R [--set N|default]");
        const { batchSizeOf, setBatchSize } = await import("./batch-size.ts");
        const db = connect();
        if (typeof f.set === "string") setBatchSize(db, "cli", f.repo, f.set === "default" ? null : Number(f.set));
        const n = batchSizeOf(db, f.repo);
        console.log(`${f.repo}: first pass reviews ${n ?? `${DEFAULT_CAPS.perCall} (default)`} PRs per call`);
        return;
      }
      const f = parseArgs(args, ["repo", "limit", "dry-run"]);
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      await runReview(connect(), { repo: f.repo, limit, dryRun: f["dry-run"] === true });
    },
  },
  checks: {
    summary: "checks --repo R: refresh CI status and mergeability of the repo's open PRs",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args, ["repo"]);
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      await runChecks(connect(), { repo: f.repo });
    },
  },
};
