// Which PRs the CI fix step works on, from the local tables only. A candidate is an open PR whose current head has a
// final take or take-fix review and whose checks (read at that head) fail.
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { notHeldSql } from "../dupes/held.ts";
import { fastScoreSql } from "../fasttrack.ts";
import { classifyFixups } from "../fixup/candidates.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { changesRequestedWhy, gatesOf, mirroredReviews } from "../merge/changes-requested.ts";
import { ciApprovalOf, overallAt } from "../merge/ci-approval.ts";
import { mergeHeld } from "../merge/holds.ts";
import { headOf } from "../review/candidates.ts";
import { staleReviews } from "../review/discussion.ts";
import { CIFIX_FINAL_STATES, CIFIX_MAX_PUSHES_PER_PR, CIFIX_MAX_TRIES, CIFIX_MAX_TRIES_PER_PR, CIFIX_PUSH_STATES, CIFIX_TRY_STATES } from "../core/rules.ts";
import { TERMINAL, getTask } from "../build/tasks.ts";

/** Tries per head (a formatter run, a pushed or rejected patch) before the step leaves the PR to a person. */
export const MAX_TRIES = CIFIX_MAX_TRIES;
/** Pushed CI fixes and tries in all, over every head of a PR: our own pushes make new heads, so a per-head limit alone never ends. */
export const MAX_PUSHES_PER_PR = CIFIX_MAX_PUSHES_PER_PR;
export const MAX_TRIES_PER_PR = CIFIX_MAX_TRIES_PER_PR;
const TRY_STATES = CIFIX_TRY_STATES;
const PUSH_STATES = CIFIX_PUSH_STATES;
/** States that end the step's work at a head. */
const FINAL_STATES = CIFIX_FINAL_STATES;

export type CifixCandidate = {
  repo: string; number: number; head: string; verdict: "take" | "take-fix"; reason: string;
  /** This try's number at the head. */
  attempt: number;
  /** branch: the branch accepts our push. comment: it does not, and the repo allows comments. */
  route: "branch" | "comment";
  /** The one rerun of this head was done; the failure is read again as something to fix. */
  rerun: boolean;
  /** When the rerun was requested (ISO), else null. */
  rerunAt: string | null;
};

export type CifixBucket =
  | "work"        // the step reads the log and fixes or triages
  | "unapproved"  // pushable, but the repo has no push approval
  | "cannot-push" // not pushable and the repo has no comment approval
  | "formatting"  // a formatter task is running or its result waits to be collected
  | "rerun"       // infra failure; the one rerun is due
  | "rerun-wait"  // rerun done, the checks have not been read since
  | "failed"      // two tries used at this head
  | "capped"      // the PR's push or try limit is used and no note says so yet
  | "done";       // a push or a comment at this head
export type Classified = { c: CifixCandidate; bucket: CifixBucket; /** Formatter task awaiting collection. */ task: number | null; runs: number[] };

type Row = {
  repo: string; number: number; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null; overall: string;
  mergeable: string | null; review_decision: string | null; can_modify: number | null; head_repo: string | null; head_ref: string | null;
  r_head: string; verdict: "take" | "take-fix"; reason: string;
};
type FixRow = { state: string; created_at: string; task_id: number | null; runs: string | null };

export function classifyCifix(db: DatabaseSync, repo: string): Classified[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.overall, c.mergeable, i.review_decision, c.maintainer_can_modify AS can_modify, i.head_repo, i.head_ref,
      l.head_oid AS r_head, l.verdict, l.reason
    FROM items i JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    JOIN final_reviews l ON l.repo = i.repo AND l.number = i.number AND l.head_oid = (
      SELECT r.head_oid FROM opus_reviews r WHERE r.repo = i.repo AND r.number = i.number AND r.verdict IS NOT NULL ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND l.verdict IN ('take', 'take-fix') AND ${notHeldSql("i")}
    ORDER BY ${fastScoreSql("i.repo", "i.number", "p.score")} IS NULL, ${fastScoreSql("i.repo", "i.number", "p.score")} DESC, i.number`).all(repo) as Row[];
  const at = db.prepare("SELECT state, created_at, task_id, runs FROM ci_fixes WHERE repo = ? AND number = ? AND head = ? ORDER BY created_at, rowid");
  const overall = db.prepare(`SELECT COALESCE(SUM(state IN (${PUSH_STATES.map(() => "?").join(",")})), 0) AS pushes, COALESCE(SUM(state IN (${TRY_STATES.map(() => "?").join(",")})), 0) AS tries FROM ci_fixes WHERE repo = ? AND number = ?`);
  const commenting = commentApprovalOf(db, repo) !== null;
  const approved = pushApprovalOf(db, repo) !== null;
  const stale = staleReviews(db, repo);
  const gates = gatesOf(db, repo);
  const longLived = longLivedOf(db, repo);
  // A take-fix PR whose listed fixes are still to be pushed or posted goes through the fix-up first.
  const fixupFirst = new Set(classifyFixups(db, repo).filter((x) => ["fix", "unapproved", "ask"].includes(x.bucket)).map((x) => `${x.c.number}@${x.c.head}`));
  const out: Classified[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    // The review and the checks both describe the current head.
    if (!head || head !== r.r_head || r.c_head !== head) continue;
    if (overallAt(db, repo, r.number, head, r.overall) !== "failure") continue;
    if (r.mergeable === "CONFLICTING" || stale.has(`${repo}#${r.number}@${head}`) || changesRequestedWhy(gates.get(`${repo}#${r.number}`), r.updated_at, mirroredReviews(db, repo, r.number), r.review_decision).why || mergeHeld(db, repo, r.number)) continue;
    if (r.verdict === "take-fix" && fixupFirst.has(`${r.number}@${head}`)) continue;
    const prior = at.all(repo, r.number, head) as FixRow[];
    const has = (s: string) => prior.some((x) => x.state === s);
    const tries = prior.filter((x) => TRY_STATES.includes(x.state)).length;
    const rerunRow = prior.find((x) => x.state === "rerun" || x.state === "rerunning");
    const total = overall.get(...PUSH_STATES, ...TRY_STATES, repo, r.number) as { pushes: number; tries: number };
    const canPush = pushable(r.head_repo, repo, r.can_modify, r.head_ref, longLived);
    const c: CifixCandidate = { repo, number: r.number, head, verdict: r.verdict, reason: r.reason, attempt: tries + 1, route: canPush ? "branch" : "comment", rerun: !!rerunRow, rerunAt: rerunRow?.created_at ?? null };
    const mk = (bucket: CifixBucket, extra: Partial<Classified> = {}) => out.push({ c, bucket, task: null, runs: [], ...extra });
    const infra = prior.find((x) => x.state === "infra");
    const formatting = prior.find((x) => x.state === "formatting");
    if (FINAL_STATES.some(has)) mk("done");
    else if (formatting) mk("formatting", { task: formatting.task_id });
    else if (has("capped")) mk("failed");
    else if (total.pushes >= MAX_PUSHES_PER_PR || total.tries >= MAX_TRIES_PER_PR) mk("capped");
    else if (tries >= MAX_TRIES) mk("failed");
    else if (infra && !rerunRow) mk("rerun", { runs: JSON.parse(infra.runs ?? "[]") as number[] });
    else if (rerunRow && !(r.c_at && r.c_at > rerunRow.created_at)) mk("rerun-wait");
    else if (!canPush && !commenting) mk("cannot-push");
    else if (canPush && !approved) mk("unapproved");
    else mk("work");
  }
  return out;
}

export type CifixSelection = {
  /** PRs the step reads, triages and fixes. */
  work: CifixCandidate[];
  /** Formatter tasks that ended: their results are applied. */
  collect: { c: CifixCandidate; task: number }[];
  /** PRs at their push or try limit: a final `capped` row with a note on the item is written once. */
  capped: CifixCandidate[];
  /** Infra failures due their one rerun, with the run ids to rerun. */
  rerun: { c: CifixCandidate; runs: number[] }[];
};

export function selectCifix(db: DatabaseSync, repo: string): CifixSelection {
  const out: CifixSelection = { work: [], collect: [], rerun: [], capped: [] };
  for (const x of classifyCifix(db, repo)) {
    if (x.bucket === "work") out.work.push(x.c);
    else if (x.bucket === "capped") out.capped.push(x.c);
    else if (x.bucket === "rerun" && ciApprovalOf(db, repo)) out.rerun.push({ c: x.c, runs: x.runs });
    else if (x.bucket === "formatting" && x.task !== null) {
      const t = getTask(db, x.task);
      if (!t || TERMINAL.includes(t.state)) out.collect.push({ c: x.c, task: x.task });
    }
  }
  return out;
}
