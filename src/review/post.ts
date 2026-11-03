// Stage 5, Review, last part: posts the final Opus review of a PR as one pull request
// review (event COMMENT: never an approval or a change request) in repos approved for
// comments. One review per PR: a later Opus review at a new head edits it.
//
//   craft-auto review-post --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only and lists what would be posted.
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { audit } from "../dash/audit.ts";
import { groupHeldSql, notOwnIntegrationSql } from "../dupes/held.ts";
import { Client, type Querier } from "../mirror.ts";
import { prInfo } from "../merge/index.ts";
import { pilotSql } from "../pilot.ts";
import { headOf } from "./candidates.ts";
import { parsePublic } from "./opus-parse.ts";
import { reviewBody, recommendation } from "./post-template.ts";
import { buildQueue } from "../merge/queue.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { pushApprovalOf } from "../fixup/approval.ts";

const ACTOR = "review-post";

export type PostCandidate = {
  repo: string; number: number; head_oid: string; body: string;
  /** The id of our earlier review of this PR (at another head), to edit; null for a first post. */
  editId: string | null;
};
export type PostSummary = { repo: string; dryRun: boolean; candidates: number; posted: string[]; edited: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[]; note: string | null };
export type PostParams = { repo: string; limit?: number; dryRun?: boolean; onHandled?: (n: number) => void };
export type PostDeps = { querier: Querier; now: () => Date };

export const defaultPostDeps = (): PostDeps => ({ querier: new Client(1000), now: () => new Date() });

type Row = {
  number: number; head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null;
  o_head: string; model: string | null; verdict: string; sure: number | null; public_review: string;
  p_id: string | null; p_head: string | null; can_modify: number | null;
};
const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * Open PRs of `repo` with an Opus review (a verdict, not a skip) at their current head that no review of ours
 * describes yet. Leaves out PRs by the pipeline's own account, integration batch PRs, held duplicates and items outside the pilot.
 */
export function postCandidates(db: DatabaseSync, repo: string): PostCandidate[] {
  const rows = db.prepare(`SELECT i.number, i.head_oid, i.updated_at, c.head_oid AS c_head, c.fetched_at AS c_at,
      o.head_oid AS o_head, o.model, o.verdict, o.sure, o.public_review, p.review_id AS p_id, p.head_oid AS p_head, i.maintainer_can_modify AS can_modify
    FROM items i JOIN opus_reviews o ON o.repo = i.repo AND o.number = i.number AND o.verdict IS NOT NULL AND o.public_review IS NOT NULL
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN review_posts p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")}
      AND NOT EXISTS (SELECT 1 FROM main.merge_batches mb WHERE mb.repo = i.repo AND mb.pr_number = i.number)
      AND COALESCE(i.author, '') <> COALESCE((SELECT value FROM main.settings WHERE key = 'pipeline_login'), '')
      AND NOT EXISTS (SELECT 1 FROM decisions dh WHERE dh.kind = 'duplicate' AND dh.id NOT LIKE '%:dupegroup:%' AND dh.repo = i.repo AND dh.number = i.number AND (dh.answer IS NULL OR dh.answer = 'close'))
      AND NOT ${groupHeldSql("i")}
    ORDER BY i.number`).all(repo) as Row[];
  const out: PostCandidate[] = [];
  const mergeApproved = !!mergeApprovalOf(db, repo), pushApproved = !!pushApprovalOf(db, repo);
  for (const r of rows) {
    const pub = parsePublic(safeJson(r.public_review));
    if (!pub) continue;
    const head = headOf(r);
    if (!head || head !== r.o_head || r.p_head === head) continue;
    const q = r.verdict === "take" ? buildQueue(db, { repo, refs: [`${repo}#${r.number}`], merged: "exclude" })[0] : undefined;
    out.push({
      repo, number: r.number, head_oid: head, editId: r.p_id,
      body: reviewBody({
        model: r.model, verdict: r.verdict, sure: r.sure !== 0, summary: pub.summary, points: pub.points, head,
        recommendation: recommendation({ verdict: r.verdict, queue: q ? { path: q.path, state: q.state } : null, mergeApproved, canPush: pushApproved && r.can_modify === 1 }),
      }),
    });
  }
  return out;
}

export const ADD_REVIEW = `mutation($pr: ID!, $oid: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $oid, body: $body, event: COMMENT }) { pullRequestReview { id } }
}`;
export const EDIT_REVIEW = `mutation($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } }
}`;

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
        await d.querier.query(EDIT_REVIEW, { id: c.editId, body: c.body });
        db.prepare("UPDATE review_posts SET head_oid = ?, edited_at = ? WHERE repo = ? AND number = ?").run(c.head_oid, at, repo, c.number);
        audit(db, ACTOR, "review-edit", refOf(c), { head: c.head_oid, review: c.editId });
        s.edited.push(refOf(c));
      } else {
        const r = await d.querier.query(ADD_REVIEW, { pr: live.id, oid: c.head_oid, body: c.body }) as { addPullRequestReview?: { pullRequestReview?: { id?: string } | null } | null };
        const id = r.addPullRequestReview?.pullRequestReview?.id;
        if (!id) throw new Error("GitHub returned no review");
        db.prepare("INSERT OR REPLACE INTO review_posts (repo, number, review_id, head_oid, posted_at) VALUES (?, ?, ?, ?, ?)").run(repo, c.number, id, c.head_oid, at);
        audit(db, ACTOR, "review-post", refOf(c), { head: c.head_oid, review: id });
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
