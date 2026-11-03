// Review quality cross-check, run by an operator and never by the autopilot: how often does a Sonnet
// `hold` from a batch call hold up? For a random sample of PRs whose final review at the head is such
// a hold, Opus reviews the PR exactly as in the second pass and, with --single, Sonnet reviews it alone
// in its call. Results go to `review_crosschecks` only: no review row, post, queue entry or merge changes.
// The only other write is the refresh of `pr_checks` (CI and head state) that every review step does.
// Reads GitHub (diffs, discussion); never writes to it.
//
//   autocraft review crosscheck --repo R --sample N [--single] [--seed S]
//   autocraft review crosscheck-report [--run ID]
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { claudeRoom } from "../agents/call.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { cachedDiff, codeDiff } from "./diff.ts";
import { headOf, sizeOf } from "./candidates.ts";
import { checksOf, refreshChecks } from "./checks.ts";
import { notHeldSql } from "../dupes/held.ts";
import { discussionOf, ensurePipelineLogin, liveDiscussion, staleReviews, withRetry } from "./discussion.ts";
import { defaultOpusDeps, prepareOpusInput, type OpusDeps } from "./opus.ts";
import type { OpusCandidate } from "./opus-candidates.ts";
import { parseOpusReply } from "./opus-parse.ts";
import { parseReviewReply, type ReviewPr } from "./parse.ts";
import { MAX_CODE_LINES } from "./index.ts";

const OPUS = CLAUDE_PROMPTS["review.opus"];
const SONNET = CLAUDE_PROMPTS["review.sonnet"];

export type CrosscheckParams = { repo: string; sample: number; single?: boolean; seed?: string; onHandled?: (n: number) => void };
export type CrosscheckDeps = OpusDeps & { sonnetModel: string };
export type CrosscheckSummary = { runId: string; repo: string; seed: string; eligible: number; picked: string[]; stored: number; skipped: string[]; missing: string[] };

const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export function defaultCrosscheckDeps(): CrosscheckDeps {
  return { ...defaultOpusDeps(), sonnetModel: SONNET.models[0]! };
}

function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = {
  number: number; title: string | null; body: string | null; author_association: string | null; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  additions: number | null; deletions: number | null; c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null;
  r_head: string; verdict: string; reason: string; fixes: string | null; risks: string | null;
};
const list = <T>(s: string | null): T[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
};

/**
 * Open, non-draft PRs of `repo` whose final review at the current head is a Sonnet hold from a call with
 * more than one PR (or from before call sizes were recorded) (not "too large", not a duplicate hold, not an Opus or skip-list result), not held
 * for duplicates or the backlog, not stale after new discussion, and not covered by an earlier cross-check at that head.
 */
export function crosscheckEligible(db: DatabaseSync, repo: string): OpusCandidate[] {
  const rows = db.prepare(`SELECT i.number, i.title, i.body, i.author_association, i.head_oid, i.updated_at, i.is_draft, i.additions, i.deletions,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at,
      f.head_oid AS r_head, f.sonnet_verdict AS verdict, f.sonnet_reason AS reason, f.sonnet_fixes AS fixes, f.risks AS risks
    FROM items i JOIN final_reviews f ON f.repo = i.repo AND f.number = i.number
    JOIN reviews rv ON rv.repo = f.repo AND rv.number = f.number AND rv.head_oid = f.head_oid
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND f.source = 'sonnet' AND f.sonnet_verdict = 'hold' AND f.final = 1 AND f.model IS NOT NULL
      AND (rv.call_size IS NULL OR rv.call_size > 1) AND f.duplicate_of IS NULL AND f.sonnet_reason NOT LIKE 'duplicate of %' AND ${notHeldSql("i")}
      AND NOT EXISTS (SELECT 1 FROM review_crosschecks x WHERE x.repo = f.repo AND x.number = f.number AND x.head_oid = f.head_oid)
    ORDER BY i.number`).all(repo) as Row[];
  const stale = staleReviews(db, repo);
  const out: OpusCandidate[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || head !== r.r_head || stale.has(`${repo}#${r.number}@${head}`)) continue;
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    out.push({
      repo, number: r.number, title: r.title ?? "", body: r.body ?? "", author_association: r.author_association, head_oid: head,
      lines_changed: lines, size: sizeOf(lines), score: null,
      sonnet: { verdict: r.verdict, reason: r.reason, fixes: list(r.fixes), risks: list(r.risks) },
    });
  }
  return out;
}

/** A seeded random sample of `n`, in the order drawn. */
export function sampleOf<T>(items: T[], n: number, seed: string): T[] {
  const rand = rng(seed), pool = [...items], out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return out;
}

const store = (db: DatabaseSync, runId: string, seed: string, c: OpusCandidate, o: { verdict: string; sure: boolean; reason: string } | null, s: { verdict: string; reason: string } | null) =>
  db.prepare(`INSERT OR REPLACE INTO review_crosschecks (run_id, repo, number, head_oid, seed, batch_verdict, batch_reason, opus_verdict, opus_sure, opus_reason, single_verdict, single_reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, c.repo, c.number, c.head_oid, seed, c.sonnet.verdict, c.sonnet.reason,
    o?.verdict ?? null, o ? (o.sure ? 1 : 0) : null, o?.reason ?? null, s?.verdict ?? null, s?.reason ?? null, now());

/** The first-pass input of one PR alone in its call, or null when it has no usable full diff. */
async function singleInput(db: DatabaseSync, c: OpusCandidate, deps: CrosscheckDeps): Promise<ReviewPr | null> {
  const d = await cachedDiff(c.repo, c.number, c.head_oid, deps.fetchDiff);
  if (!d.ok) return null;
  let cd = codeDiff(d.text);
  if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
  if (cd.codeLines > MAX_CODE_LINES || cd.text.length > deps.maxChars) return null;
  const ch = checksOf(db, c.repo, c.number);
  const { entries } = discussionOf(db, c.repo, c.number, deps.querier ? await withRetry(() => liveDiscussion(deps.querier!, db, c.repo, c.number)) : undefined);
  return {
    ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
    ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    same_files_as: [], diff: cd.text, discussion: entries,
  };
}

export async function runCrosscheck(db: DatabaseSync, params: CrosscheckParams, log: (line: string) => void = console.log, deps: CrosscheckDeps = defaultCrosscheckDeps()): Promise<CrosscheckSummary> {
  const { repo } = params;
  const stamp = now().replace(/[-:]/g, "").slice(0, 15);
  const runId = `review-crosscheck-${repo}-${stamp}`;
  const seed = params.seed ?? Math.random().toString(36).slice(2, 10);
  const eligible = crosscheckEligible(db, repo);
  // The draw is a seeded shuffle; PRs that changed on GitHub since the review are replaced by the next in the order.
  const order = sampleOf(eligible, eligible.length, seed);
  let picked: OpusCandidate[] = [];
  const summary: CrosscheckSummary = { runId, repo, seed, eligible: eligible.length, picked: [], stored: 0, skipped: [], missing: [] };
  if (!deps.querier) picked = order.slice(0, params.sample);
  else {
    try {
      for (let at = 0; picked.length < params.sample && at < order.length;) {
        const chunk = order.slice(at, at + params.sample - picked.length);
        at += chunk.length;
        const live = new Map((await refreshChecks(db, deps.querier, repo, chunk.map((c) => c.number), log)).map((l) => [l.number, l]));
        for (const c of chunk) {
          const l = live.get(c.number);
          if (l && l.state === "OPEN" && !l.is_draft && l.head_oid === c.head_oid) picked.push(c);
          else log(`  ${refOf(c)}: dropped, changed on GitHub since the review`);
        }
      }
      await ensurePipelineLogin(db, deps.querier).catch(() => {});
    } catch (e) {
      log(`crosscheck ${repo}: live state unavailable (${String((e as Error).message ?? e)}); nothing asked`);
      return summary;
    }
  }
  summary.picked = picked.map(refOf);
  log(`crosscheck ${repo}: ${eligible.length} eligible batch holds, sample ${picked.length}, seed ${seed}; run ${runId}`);
  let handled = 0;
  await pool(picked.map((c) => async () => {
    const ref = refOf(c);
    const start = now();
    const p = await prepareOpusInput(db, repo, c, deps, log);
    if (p.kind !== "ready") {
      log(`  ${ref}: ${p.kind === "skip" ? `skip list (${p.why})` : p.kind === "large" ? "too large" : "no input: " + (p as { error: string }).error}; left out`);
      summary.skipped.push(ref);
      params.onHandled?.(++handled);
      return;
    }
    const checkout = (await deps.checkout?.(repo, c.number, c.head_oid)) ?? undefined;
    p.input.first_review_note = "The first review rated this PR hold, in a call with other PRs. Review it on its merits.";
    if (checkout) p.input.repo_dir = REPO_PATH;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let opus: { verdict: string; sure: boolean; reason: string } | null = null;
    for (let attempt = 0; attempt < OPUS.limits.attempts && !opus; attempt++) {
      const reply = await askClaude("review.opus", deps.model, [p.input], db, { checkout });
      if (!reply) continue;
      usage = add(usage, reply.usage);
      opus = parseOpusReply(reply.text, ref);
    }
    saveUsage(db, runId, `opus-${ref.replace("#", "-")}`, "review", deps.model, opus ? 1 : 0, usage, start, now());
    let single: { verdict: string; reason: string } | null = null;
    if (params.single) {
      const input = await singleInput(db, c, deps).catch(() => null);
      let u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
      const t0 = now();
      for (let attempt = 0; input && attempt < SONNET.limits.attempts && !single; attempt++) {
        const reply = await askClaude("review.sonnet", deps.sonnetModel, [input], db);
        if (!reply) continue;
        u = add(u, reply.usage);
        single = parseReviewReply(reply.text, [ref]).reviews[0] ?? null;
      }
      saveUsage(db, runId, `single-${ref.replace("#", "-")}`, "review", deps.sonnetModel, single ? 1 : 0, u, t0, now());
    }
    if (!opus && !single) {
      log(`  ${ref}: no valid review`);
      summary.missing.push(ref);
    } else {
      store(db, runId, seed, c, opus, single);
      summary.stored++;
    }
    params.onHandled?.(++handled);
  }), () => claudeRoom(db));
  log(`crosscheck ${repo}: ${summary.stored} stored, ${summary.skipped.length} left out, ${summary.missing.length} without an answer`);
  return summary;
}

const one = (s: string | null, n = 200) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Plain-text report of one run (default: the latest). */
export function crosscheckReport(db: DatabaseSync, runId?: string): string {
  const id = runId ?? (db.prepare("SELECT run_id FROM review_crosschecks ORDER BY at DESC, rowid DESC LIMIT 1").get() as { run_id: string } | undefined)?.run_id;
  if (!id) return "No cross-check runs yet.";
  const rows = db.prepare("SELECT * FROM review_crosschecks WHERE run_id = ? ORDER BY number").all(id) as {
    repo: string; number: number; seed: string | null; opus_verdict: string | null; opus_sure: number | null; opus_reason: string | null;
    single_verdict: string | null; single_reason: string | null; batch_reason: string | null;
  }[];
  if (!rows.length) return `No results for run ${id}.`;
  const out = [`Run ${id}: ${rows.length} PRs, each a Sonnet hold from a first-pass call with more than one PR or an older review (seed ${rows[0]!.seed ?? "?"}); Opus was told the first review rated it hold`];
  const tally = (label: string, pick: (r: (typeof rows)[number]) => string | null) => {
    const asked = rows.filter((r) => pick(r) !== null);
    if (!asked.length) return;
    out.push("", `Batch hold vs ${label} (${asked.length} reviewed):`);
    for (const v of ["take", "take-fix", "hold", "close"]) out.push(`  ${v.padEnd(9)} ${asked.filter((r) => pick(r) === v).length}`);
  };
  tally("Opus", (r) => r.opus_verdict);
  tally("single-PR Sonnet", (r) => r.single_verdict);
  const differ = rows.filter((r) => (r.opus_verdict && r.opus_verdict !== "hold") || (r.single_verdict && r.single_verdict !== "hold"));
  out.push("", differ.length ? "Where they differ from the batch hold:" : "No differences from the batch hold.");
  for (const r of differ) {
    out.push(`  ${r.repo}#${r.number}`, `    batch hold: ${one(r.batch_reason)}`);
    if (r.opus_verdict) out.push(`    opus ${r.opus_verdict}${r.opus_sure ? "" : " (unsure)"}: ${one(r.opus_reason)}`);
    if (r.single_verdict) out.push(`    single ${r.single_verdict}: ${one(r.single_reason)}`);
  }
  return out.join("\n");
}
