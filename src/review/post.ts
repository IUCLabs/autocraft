// Stage 5, Review, last part: posts the final Opus review of a PR as one pull request
// review (event COMMENT: never an approval or a change request) in repos approved for
// comments. One review per PR: a later Opus review at a new head edits it.
//
//   autocraft review-post --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only and lists what would be posted.
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { editReview, postReview, type Writer } from "../github/write.ts";
import { backlogHeldSql, groupHeldSql, notOwnIntegrationSql } from "../dupes/held.ts";
import { Client, type Querier } from "../mirror.ts";
import { prInfo } from "../merge/index.ts";
import { pilotSql } from "../pilot.ts";
import { headOf } from "./candidates.ts";
import { parsePublic } from "./opus-parse.ts";
import { reviewBody, recommendation } from "./post-template.ts";
import { buildQueue } from "../merge/queue.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";

const ACTOR = "review-post";

export type PostCandidate = {
  repo: string; number: number; head_oid: string; body: string;
  /** The id of our earlier review of this PR (at another head), to edit; null for a first post. */
  editId: string | null;
  /** The `at` of the Opus review the body describes. */
  opusAt: string;
};
export type PostSummary = { repo: string; dryRun: boolean; candidates: number; posted: string[]; edited: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[]; note: string | null };
export type PostParams = { repo: string; limit?: number; dryRun?: boolean; onHandled?: (n: number) => void };
export type PostDeps = { querier: Querier; now: () => Date };

export const defaultPostDeps = (): PostDeps => ({ querier: new Client(1000), now: () => new Date() });

type Row = {
  number: number; head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null;
  o_head: string; o_at: string; p_opus_at: string | null; p_at: string | null; model: string | null; verdict: string; sure: number | null; public_review: string | null;
  p_id: string | null; p_head: string | null; can_modify: number | null; head_repo: string | null; head_ref: string | null;
};
const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * Open PRs of `repo` with an Opus review (a verdict, not a skip; with public text unless it edits an earlier post) at their current head that no review of ours
 * describes yet. Leaves out PRs by the pipeline's own account, integration batch PRs, held duplicates and items outside the pilot.
 */
export function postCandidates(db: DatabaseSync, repo: string): PostCandidate[] {
  const longLived = longLivedOf(db, repo);
  const rows = db.prepare(`SELECT i.number, i.head_oid, i.updated_at, c.head_oid AS c_head, c.fetched_at AS c_at,
      o.head_oid AS o_head, o.at AS o_at, p.opus_at AS p_opus_at, p.posted_at AS p_at, o.model, o.verdict, o.sure, o.public_review, p.review_id AS p_id, p.head_oid AS p_head, i.maintainer_can_modify AS can_modify, i.head_repo, i.head_ref
    FROM items i JOIN opus_reviews o ON o.repo = i.repo AND o.number = i.number AND o.verdict IS NOT NULL
    AND o.at >= COALESCE((SELECT r.at FROM reviews r WHERE r.repo = o.repo AND r.number = o.number AND r.head_oid = o.head_oid), '')
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN review_posts p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND (o.public_review IS NOT NULL OR p.review_id IS NOT NULL) AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")}
      AND NOT EXISTS (SELECT 1 FROM main.merge_batches mb WHERE mb.repo = i.repo AND mb.pr_number = i.number)
      AND COALESCE(i.author, '') <> COALESCE((SELECT value FROM main.settings WHERE key = 'pipeline_login'), '')
      AND NOT EXISTS (SELECT 1 FROM decisions dh WHERE dh.kind = 'duplicate' AND dh.id NOT LIKE '%:dupegroup:%' AND dh.repo = i.repo AND dh.number = i.number AND (dh.answer IS NULL OR dh.answer = 'close'))
      AND NOT ${groupHeldSql("i")} AND NOT ${backlogHeldSql("i")}
    ORDER BY i.number`).all(repo) as Row[];
  const out: PostCandidate[] = [];
  const mergeApproved = !!mergeApprovalOf(db, repo), pushApproved = !!pushApprovalOf(db, repo);
  for (const r of rows) {
    // A newer review with no public text still edits an earlier post, so the verdict line stays current.
    const pub = r.public_review === null ? { summary: "", points: [] as string[] } : parsePublic(safeJson(r.public_review));
    if (!pub) continue;
    const head = headOf(r);
    // Posted for this head already, unless a newer Opus review of the same head exists: then the posted review is edited.
    if (!head || head !== r.o_head || (r.p_head === head && r.o_at <= (r.p_opus_at ?? r.p_at ?? ""))) continue;
    const q = r.verdict === "take" ? buildQueue(db, { repo, refs: [`${repo}#${r.number}`], merged: "exclude" })[0] : undefined;
    out.push({
      repo, number: r.number, head_oid: head, editId: r.p_id, opusAt: r.o_at,
      body: reviewBody({
        model: r.model, verdict: r.verdict, sure: r.sure !== 0, summary: pub.summary, points: pub.points, head,
        recommendation: recommendation({ verdict: r.verdict, queue: q ? { path: q.path, state: q.state } : null, mergeApproved, canPush: pushApproved && pushable(r.head_repo, repo, r.can_modify === 1, r.head_ref, longLived) }),
      }),
    });
  }
  return out;
}

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export async function runReviewPost(db: DatabaseSync, params: PostParams, log: (line: string) => void = console.log, deps?: PostDeps): Promise<PostSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const s: PostSummary = { repo, dryRun, candidates: 0, posted: [], edited: [], skipped: [], failed: [], note: null };
  if (!commentApprovalOf(db, repo)) {
    s.note = `commenting in ${repo} is not approved`;
    log(`review-post ${repo}: ${s.note}; nothing done`);
    return s;
  }
  let todo = postCandidates(db, repo);
  s.candidates = todo.length;
  if (params.limit !== undefined) todo = todo.slice(0, params.limit);
  if (dryRun) {
    for (const c of todo) log(`  would ${c.editId ? "edit the review of" : "review"} ${refOf(c)} at ${c.head_oid.slice(0, 7)}:\n${c.body.replace(/^/gm, "    ")}`);
    log(`review-post ${repo}: dry run, ${todo.length} of ${s.candidates} candidates, nothing called or written`);
    return s;
  }
  const d = deps ?? defaultPostDeps();
  const w: Writer = { db, login: ACTOR };
  let handled = 0;
  for (const c of todo) {
    const skip = (reason: string) => { s.skipped.push({ ref: refOf(c), reason }); log(`  ${refOf(c)}: skipped: ${reason}`); };
    try {
      const live = await prInfo(d.querier, repo, c.number);
      if (!live) { skip("not found on GitHub"); continue; }
      if (live.state !== "OPEN") { skip(`now ${live.state}`); continue; }
      if (live.head !== c.head_oid) { skip(`head moved to ${live.head.slice(0, 7)}`); continue; }
      const at = d.now().toISOString();
      if (c.editId) {
        await editReview(w, d.querier, repo, c.number, c.editId, c.head_oid, c.body);
        db.prepare("UPDATE review_posts SET head_oid = ?, edited_at = ?, opus_at = ? WHERE repo = ? AND number = ?").run(c.head_oid, at, c.opusAt, repo, c.number);
        s.edited.push(refOf(c));
      } else {
        const id = await postReview(w, d.querier, { repo, number: c.number, id: live.id }, c.head_oid, c.body);
        if (!id) throw new Error("GitHub returned no review");
        db.prepare("INSERT OR REPLACE INTO review_posts (repo, number, review_id, head_oid, posted_at, opus_at) VALUES (?, ?, ?, ?, ?, ?)").run(repo, c.number, id, c.head_oid, at, c.opusAt);
        s.posted.push(refOf(c));
      }
      log(`  ${refOf(c)}: ${c.editId ? "edited" : "posted"} at ${c.head_oid.slice(0, 7)}`);
      params.onHandled?.(++handled);
    } catch (e) {
      const reason = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
      s.failed.push({ ref: refOf(c), reason });
      log(`  ${refOf(c)}: failed: ${reason}`);
    }
  }
  log(`review-post ${repo}: ${s.posted.length} posted, ${s.edited.length} edited, ${s.skipped.length} skipped, ${s.failed.length} failed`);
  return s;
}

export const commands = {
  "review-post": {
    summary: "review-post --repo R [--limit N] [--apply]: post the final Opus reviews as PR reviews (dry run without --apply)",
    async run(args: string[]): Promise<void> {
      let repo: string | undefined, limit: number | undefined, apply = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--apply") apply = true;
        else if (a === "--dry-run") apply = false;
        else if (a === "--repo") repo = args[++i];
        else if (a === "--limit") limit = Number(args[++i]);
        else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
      }
      if (!repo) throw new Error("missing --repo");
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      const { connect } = await import("../db.ts");
      await runReviewPost(connect(), { repo, limit, dryRun: !apply });
    },
  },
};
