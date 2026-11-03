// Stage 5, Review, second pass: Opus reviews every PR Sonnet rated take or take-fix,
// one PR per call, and its verdict replaces Sonnet's (the `final_reviews` view). Diffs
// on the skip list get no call. After a new push Opus reads only the delta since the
// head it reviewed before. Reads GitHub (diffs); never writes to it.
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { claudeRoom } from "../agents/call.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { DEFAULT_CAPS } from "./batch.ts";
import { Client, type Querier } from "../mirror.ts";
import { checksOf, refreshChecks } from "./checks.ts";
import { discussionOf, ensurePipelineLogin, liveDiscussion, withRetry, type Snapshot } from "./discussion.ts";
import { withdrawMergeQuestion } from "../merge/withdraw.ts";
import type { DiscussionEntry } from "./parse.ts";
import { cachedDiff, codeDiff, ghDelta, ghDiff, type DeltaFetcher, type DiffFetcher } from "./diff.ts";
import { selectOpusCandidates, type OpusCandidate } from "./opus-candidates.ts";
import { parseOpusReply, type EarlierOpus, type OpusPr, type OpusReview } from "./opus-parse.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { skipReason } from "./skip.ts";

const PROMPT = CLAUDE_PROMPTS["review.opus"];

export type OpusParams = {
  repo: string; limit?: number; dryRun?: boolean;
  /** Called with the running count of PRs handled (asked or skip-listed). */
  onHandled?: (n: number) => void;
};
export type OpusDeps = {
  /** Reads the live head and state of the candidates just before the model calls; absent: the mirror's view stands. */
  querier?: Querier;
  fetchDiff: DiffFetcher; fetchDelta: DeltaFetcher; model: string; maxChars: number;
  /** Host directory with a read-only checkout of the PR head for a sandboxed call, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
};
export type OpusSummary = {
  runId: string; repo: string; candidates: number; reviewed: number; skipListed: number; dropped: number;
  verdicts: Record<string, number>; missing: string[]; skipped: string[];
};

const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export function defaultOpusDeps(): OpusDeps {
  return { querier: new Client(500), fetchDiff: ghDiff, fetchDelta: ghDelta, model: PROMPT.models[0]!, maxChars: DEFAULT_CAPS.charsPerCall, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log) };
}

type Saved = { snap?: Snapshot; mode: "full" | "delta" | "skipped"; base: string | null; model: string | null; review: OpusReview | null; skip: string | null };

/**
 * Stores the Opus row of a head commit, then (for a verdict) a `reviewed` stages row and a
 * take/hold/close stages row for the final verdict, which can differ from Opus's own when
 * Opus is unsure and disagrees with Sonnet.
 */
export function saveOpus(db: DatabaseSync, runId: string | null, c: { repo: string; number: number; head_oid: string }, s: Saved): void {
  const at = now(), r = s.review;
  if (db.prepare("SELECT 1 FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(c.repo, c.number, c.head_oid)) withdrawMergeQuestion(db, c.repo, c.number, c.head_oid, at);
  db.prepare(`INSERT OR REPLACE INTO opus_reviews (repo, number, head_oid, run_id, at, model, mode, base_head, verdict, sure, reason, fixes, risks, skip_reason, public_review, seen_at, disc_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.repo, c.number, c.head_oid, runId, at, s.model, s.mode, s.base, r?.verdict ?? null,
    r ? (r.sure ? 1 : 0) : null, r?.reason ?? null, r?.fixes.length ? JSON.stringify(r.fixes) : null, r ? JSON.stringify(r.risks) : null, s.skip, r?.public ? JSON.stringify(r.public) : null, s.snap?.seen ?? at, s.snap?.hash ?? null);
  if (!r) return;
  const final = db.prepare("SELECT verdict, reason FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(c.repo, c.number, c.head_oid) as { verdict: string; reason: string } | undefined;
  const stage = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)");
  stage.run(c.repo, c.number, "reviewed", at, "opus-review", `opus ${r.verdict}${r.sure ? "" : " (unsure)"} at ${c.head_oid.slice(0, 7)}: ${r.reason}`);
  if (final) stage.run(c.repo, c.number, final.verdict === "take-fix" ? "take" : final.verdict, at, "opus-review", final.reason);
}

/** The Opus review of the PR's latest earlier head that has a verdict, for the delta. */
function earlierOpus(db: DatabaseSync, c: OpusCandidate): EarlierOpus | null {
  const o = db.prepare(`SELECT head_oid, verdict, sure, reason, fixes FROM opus_reviews
    WHERE repo = ? AND number = ? AND head_oid <> ? AND verdict IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1`).get(c.repo, c.number, c.head_oid) as
    { head_oid: string; verdict: string; sure: number; reason: string; fixes: string | null } | undefined;
  if (!o) return null;
  let fixes: EarlierOpus["fixes"] = [];
  try { fixes = JSON.parse(o.fixes ?? "[]") as EarlierOpus["fixes"]; } catch { /* none */ }
  return { head: o.head_oid, verdict: o.verdict, sure: o.sure === 1, reason: o.reason, fixes };
}

export type PreparedOpus =
  | { kind: "no-diff"; error: string }
  | { kind: "skip"; why: string }
  | { kind: "large"; mode: "full" | "delta"; base: string | null }
  | { kind: "no-threads"; error: string }
  | { kind: "ready"; input: OpusPr; snap: Snapshot; mode: "full" | "delta"; base: string | null };

/**
 * Builds the Opus prompt input of a candidate: diff (full, or the delta since the last Opus review),
 * skip list, size cap and discussion. Shared with the review cross-check so both ask the same question.
 */
export async function prepareOpusInput(db: DatabaseSync, repo: string, c: OpusCandidate, deps: OpusDeps, log: (line: string) => void): Promise<PreparedOpus> {
  const d = await cachedDiff(repo, c.number, c.head_oid, deps.fetchDiff);
  if (!d.ok) return { kind: "no-diff", error: d.error };
  const ch = checksOf(db, repo, c.number);
  const why = skipReason(d.text, ch?.head_oid === c.head_oid ? ch.overall : null);
  if (why) return { kind: "skip", why };
  let cd = codeDiff(d.text);
  if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
  let mode: "full" | "delta" = "full", diff = cd.text, base: string | null = null;
  const earlier = earlierOpus(db, c);
  if (earlier) {
    const delta = await deps.fetchDelta(repo, earlier.head, c.head_oid);
    if (delta.ok) {
      let dd = codeDiff(delta.text);
      if (!dd.files.length && dd.testsOmitted.length) dd = codeDiff(delta.text, true);
      mode = "delta"; diff = dd.text; base = earlier.head;
    } else log(`  ${refOf(c)}: delta since ${earlier.head.slice(0, 7)} unavailable (${delta.error}); full diff`);
  }
  if (diff.length > deps.maxChars) return { kind: "large", mode, base };
  let discussion: DiscussionEntry[], snap: Snapshot;
  try {
    ({ entries: discussion, snap } = discussionOf(db, repo, c.number, deps.querier ? await withRetry(() => liveDiscussion(deps.querier!, db, repo, c.number)) : undefined));
  } catch (e) {
    return { kind: "no-threads", error: String((e as Error).message ?? e) };
  }
  const input: OpusPr = {
    ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
    ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    sonnet: c.sonnet, mode, earlier_opus: mode === "delta" ? earlier : null, diff, discussion,
  };
  return { kind: "ready", input, snap, mode, base };
}

export async function runOpusReview(db: DatabaseSync, params: OpusParams, log: (line: string) => void = console.log, deps: OpusDeps = defaultOpusDeps()): Promise<OpusSummary> {
  const { repo } = params;
  const runId = `opus-review-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = selectOpusCandidates(db, repo);
  const summary: OpusSummary = { runId, repo, candidates: cands.length, reviewed: 0, skipListed: 0, dropped: 0, verdicts: {}, missing: [], skipped: [] };
  if (params.limit !== undefined) cands = cands.slice(0, params.limit);
  if (params.dryRun || !cands.length) {
    log(`opus-review ${repo}: ${summary.candidates} candidates${params.dryRun ? "; dry run, nothing fetched or asked" : ""}`);
    return summary;
  }
  if (deps.querier) {
    // The mirror can be minutes behind: a PR closed, turned draft or pushed since selection returns as a candidate at its new head on a later pass.
    let live;
    try {
      live = await refreshChecks(db, deps.querier, repo, cands.map((c) => c.number), log);
    } catch (e) {
      log(`opus-review ${repo}: live state unavailable (${String((e as Error).message ?? e)}); nothing asked`);
      return summary;
    }
    const asked = cands.length;
    const byNumber = new Map(live.map((l) => [l.number, l]));
    cands = cands.filter((c) => {
      const l = byNumber.get(c.number);
      const ok = !!l && l.state === "OPEN" && !l.is_draft && l.head_oid === c.head_oid;
      if (!ok) log(`  ${refOf(c)}: dropped, ${l ? `now ${l.state}${l.is_draft ? " draft" : ""} at ${l.head_oid.slice(0, 7)}` : "not found on GitHub"}`);
      return ok;
    });
    summary.dropped = asked - cands.length;
    await ensurePipelineLogin(db, deps.querier).catch(() => {});
    if (!cands.length) return summary;
  }
  let handled = 0;
  const tally = (r: OpusReview) => { summary.verdicts[r.verdict] = (summary.verdicts[r.verdict] ?? 0) + 1; summary.reviewed++; };
  await pool(cands.map((c) => async () => {
    const start = now();
    const p = await prepareOpusInput(db, repo, c, deps, log);
    if (p.kind === "no-diff") {
      log(`  ${refOf(c)}: no diff: ${p.error}`);
      summary.skipped.push(refOf(c));
      return;
    }
    if (p.kind === "skip") {
      saveOpus(db, runId, c, { mode: "skipped", base: null, model: null, review: null, skip: p.why });
      summary.skipListed++;
      params.onHandled?.(++handled);
      return;
    }
    if (p.kind === "large") {
      const r: OpusReview = { ref: refOf(c), verdict: "hold", sure: true, reason: "too large for the final review", fixes: [], risks: [], public: null };
      saveOpus(db, runId, c, { mode: p.mode, base: p.base, model: null, review: r, skip: null });
      tally(r);
      params.onHandled?.(++handled);
      return;
    }
    if (p.kind === "no-threads") {
      log(`  ${refOf(c)}: review threads unavailable (${p.error}); not reviewed this pass`);
      summary.skipped.push(refOf(c));
      return;
    }
    const { input, snap, mode, base } = p;
    const checkout = (await deps.checkout?.(repo, c.number, c.head_oid)) ?? undefined;
    if (checkout) input.repo_dir = REPO_PATH;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let got: OpusReview | null = null;
    for (let attempt = 0; attempt < PROMPT.limits.attempts && !got; attempt++) {
      const reply = await askClaude("review.opus", deps.model, [input], db, { checkout });
      if (!reply) continue;
      usage = add(usage, reply.usage);
      got = parseOpusReply(reply.text, input.ref);
    }
    if (got) {
      saveOpus(db, runId, c, { mode, base, model: deps.model, review: got, skip: null, snap });
      tally(got);
    } else {
      log(`  ${refOf(c)}: no valid Opus review`);
      summary.missing.push(refOf(c));
    }
    params.onHandled?.(++handled);
    saveUsage(db, runId, `opus-${refOf(c).replace("#", "-")}`, "review", deps.model, got ? 1 : 0, usage, start, now());
  }), () => claudeRoom(db));
  log(`opus-review ${repo}: ${summary.reviewed} reviewed (${Object.entries(summary.verdicts).map(([v, k]) => `${k} ${v}`).join(", ")}); ${summary.skipListed} skip-listed; ${summary.skipped.length} without a diff, ${summary.missing.length} without an answer`);
  return summary;
}


export const commands = {
  "opus-review": {
    summary: "opus-review --repo R [--limit N] [--dry-run]: final Opus review of PRs Sonnet rated take or take-fix",
    async run(args: string[]): Promise<void> {
      const f: Record<string, string | true> = {};
      for (let i = 0; i < args.length; i++) {
        const n = args[i]!.replace(/^--/, "");
        if (!["repo", "limit", "dry-run"].includes(n)) throw new Error(`unknown option ${args[i]}; options: --repo --limit --dry-run`);
        if (n === "dry-run") f[n] = true;
        else {
          const v = args[++i];
          if (v === undefined) throw new Error(`--${n} needs a value`);
          f[n] = v;
        }
      }
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      const { connect } = await import("../db.ts");
      await runOpusReview(connect(), { repo: f.repo, limit, dryRun: f["dry-run"] === true });
    },
  },
};
