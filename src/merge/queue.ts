// The merge queue: every PR with a take or take-fix review at its current
// head commit, and what it waits on. The verdict is Opus's (see the `final_reviews` view); a PR whose
// review is out of date after new discussion is left out until it is reviewed again. Reads only local tables; no GitHub calls.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { actionable } from "../decisions.ts";
import { backlogHeld, duplicateHeld, notOwnIntegrationSql } from "../dupes/held.ts";
import { headOf, sizeOf } from "../review/candidates.ts";
import { changedSince, discussionState, staleReviews } from "../review/discussion.ts";
import { failureNote, GATE_FAILURES, gatesOf, reasonFor, refuseReviews, type ReviewFact } from "./changes-requested.ts";
import { batchStates } from "./batch-store.ts";
import { mergeHolds } from "./holds.ts";
import { NO_CI_SAMPLE, repoHasNoCi } from "./no-ci.ts";
import { ciApprovalOf, MAX_FAILURES } from "./ci-approval.ts";
import { getRule, STATS_SQL, tierOf, type Tier } from "../whitelist.ts";
import { pilotSql } from "../pilot.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { conflictBucket, conflictNote } from "../fixup/conflict-state.ts";
import { longLivedOf, pushable, type LongLived } from "../fixup/pushable.ts";

export const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "declined", "merged", "held-duplicate", "held-backlog",
  "batch-checking", "in-batch", "batch-failed", "ci-approval", "changes-requested",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** Type labels whose PRs may merge without asking. */
/** Why an unsure Opus take is asked about instead of merged by the rule. */
export const UNSURE_REASON = "Opus was unsure";

/** Returns a function that gives the head and the earlier heads AutoCraft itself pushed it from (conflict merges of the base, fix-up pushes, carry-over pushes), newest first. */
function pushChainOf(db: DatabaseSync): (repo: string, number: number, head: string) => string[] {
  const from = db.prepare(`SELECT from_head FROM conflict_merges WHERE repo = ?1 AND number = ?2 AND to_head = ?3 AND state = 'merged'
    UNION SELECT from_head FROM fixups WHERE repo = ?1 AND number = ?2 AND to_head = ?3 AND state = 'pushed'
    UNION SELECT from_head FROM dupe_carries WHERE repo = ?1 AND number = ?2 AND to_head = ?3 AND from_head IS NOT NULL`);
  return (repo, number, head) => {
    const chain = [head];
    for (let k = 0; k < chain.length; k++) for (const f of from.all(repo, number, chain[k]!) as { from_head: string }[]) if (!chain.includes(f.from_head)) chain.push(f.from_head);
    return chain;
  };
}

/** The PR has an unanswered Merge? question at any head. */
const OPEN_QUESTION_SQL = "SELECT 1 FROM decisions WHERE repo = ? AND number = ? AND kind = 'merge' AND answer IS NULL AND id NOT LIKE '%~replaced-%' LIMIT 1";

const UNSURE_AT_SQL = `SELECT 1 FROM opus_review_history WHERE repo = ?1 AND number = ?2 AND head_oid = ?3 AND verdict IN ('take', 'take-fix') AND sure = 0
  UNION ALL SELECT 1 FROM opus_reviews WHERE repo = ?1 AND number = ?2 AND head_oid = ?3 AND verdict IN ('take', 'take-fix') AND sure = 0 LIMIT 1`;

/** True when any stored Opus review at the head (the current row or an overwritten one in the history) was a take or take-fix with sure = 0. */
export function headWasUnsure(db: DatabaseSync, repo: string, number: number, head: string): boolean {
  return !!db.prepare(UNSURE_AT_SQL).get(repo, number, head);
}
export const RULE_LABELS = ["bugfix", "infra"];
/** Sizes that may merge without asking. */
export const RULE_SIZES = ["S", "M"];
/** Tiers that count as on the whitelist. */
export const RULE_TIERS: Tier[] = ["whitelisted", "allow"];

/** Option keys of a "Merge this PR?" decision. Only an operator's answer counts. */
export const MERGE_OPTIONS = {
  merge: { key: "merge", label: "Merge", hint: "Merge once CI is green at this head commit." },
  hold: { key: "hold", label: "Hold", hint: "Keep it open and out of the merge queue." },
  close: { key: "close", label: "Close", hint: "Not wanted as it is; post a short comment and close the PR." },
} as const;

/** One open decision per PR head: a push gets a new one. */
export const mergeDecisionId = (repo: string, number: number, head: string): string => `${repo}#${number}:merge@${head}`;
export const HEAD_FACT = "head commit ";

/** Verification states that let a PR merge. */
export const VERIFY_OK = ["passed", "ci-enough"];
export const verifyOk = (state: string | null | undefined): boolean => !!state && VERIFY_OK.includes(state);
/** A PR in a repo Verify cannot build is merged only on an operator's answer, which says "not verified". */
export const VERIFY_UNAVAILABLE = "unavailable";
/** What the merge step needs of the verification and CI at merge time: the rule needs a pass and green CI; an operator's answer also accepts an unbuildable repo and a repo with no CI. */
export const verifyAllows = (path: "rule" | "operator" | null, state: string | null | undefined): boolean =>
  verifyOk(state) || (path === "operator" && state === VERIFY_UNAVAILABLE);
export const ciAllows = (path: "rule" | "operator" | null, ci: string | null | undefined, noCi: boolean): boolean =>
  ci === "success" || (path === "operator" && ci === "none" && noCi);

export { NO_CI_SAMPLE, repoHasNoCi };

export type QueueEntry = {
  repo: string; number: number; title: string; author: string | null; tier: Tier;
  head: string; size: string; label: string | null; verdict: "take" | "take-fix";
  reason: string; fixes: number; ci: string; mergeable: string;
  state: QueueState;
  /** How the PR may merge: by the rule, by an operator's answer, or not yet. */
  path: "rule" | "operator" | null;
  /** Why the rule doesn't cover it; empty when it does. */
  outsideRule: string[];
  decisionId: string | null;
  /** Actions runs at the reviewed head that wait for a maintainer's approval (see ci-approval.ts); 0 when none or unknown. */
  runsWaiting: number;
  /** Why the pipeline does not approve them: the repo's CI approval is off, approving failed twice, or they are not runs it approves (not a fork's pull_request); null when it will. */
  runsBlocked: "off" | "failed" | "unsupported" | null;
  /** The repo has no CI at all (not just no checks on this PR yet). */
  noCi: boolean;
  /** The operator's answer to the Merge? decision at this head, when there is one. */
  answer: string | null;
  refusedReason: string | null;
  reviewedAt: string;
  /** An operator holds the PR's merge (src/merge/controls.ts): it is reviewed and fixed as usual but does not merge, alone or in a batch. */
  held: boolean;
  /** A line on the state: why a maintainer's review blocks it, or that its reviews cannot be read. */
  note: string | null;
  /** The block (state changes-requested) comes from a live read newer than the PR's last update, not from the mirrored reviews alone. */
  blockedLive: boolean;
  /** The verification of the PR's current head, or null when there is none. */
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  /** For a conflicting PR: what Fix-up does about it ("conflict: merging main", "conflict: asked the contributor", "conflict: held"), or null. */
  conflictNote?: string | null;
};

/** States a PR leaves for its batch's state while it is in a batch. */
const BATCHABLE: QueueState[] = ["ready", "decision-answered-merge", "refused", "waiting-ci"];

/** PRs the integration batches leave to the single-PR merge: the sandbox cannot build the repo, or the repo has no CI for the batch PR to wait on. */
export const singleMergeOnly = (e: QueueEntry): boolean => e.verify?.state === VERIFY_UNAVAILABLE || e.noCi;

/** True when the PR may be merged now (ready, approved, or retried after a refusal). */
export const eligible = (e: QueueEntry): boolean =>
  !e.held && e.path !== null && verifyAllows(e.path, e.verify?.state) && ciAllows(e.path, e.ci, e.noCi) && e.mergeable === "MERGEABLE" && (e.state === "ready" || e.state === "decision-answered-merge" || e.state === "refused");

type Row = {
  repo: string; number: number; title: string | null; author: string | null; state: string; review_decision: string | null; head_oid: string | null; updated_at: string | null;
  c_head: string | null; c_at: string | null; overall: string | null; c_mergeable: string | null; i_mergeable: string | null;
  r_head: string; r_seen: string | null; r_hash: string | null; sure: number | null; mode: string | null; verdict: "take" | "take-fix"; reason: string; fixes: string | null; lines: number; r_at: string;
  head_repo: string | null; head_ref: string | null; base_ref: string | null; i_can: number | null; c_can: number | null;
};

/** Tiers of the given logins, from one stats query. */
function tiersOf(db: DatabaseSync, logins: string[]): Map<string, Tier> {
  const out = new Map<string, Tier>();
  if (!logins.length) return out;
  const rule = getRule(db);
  const marks = logins.map(() => "?").join(",");
  const stats = new Map((db.prepare(`${STATS_SQL} AND author IN (${marks}) GROUP BY author`).all(...logins) as { login: string; merged: number; closed: number }[]).map((r) => [r.login, r]));
  const over = new Map((db.prepare(`SELECT login, status FROM whitelist_overrides WHERE login IN (${marks})`).all(...logins) as { login: string; status: string }[]).map((r) => [r.login, r.status]));
  for (const l of logins) {
    const s = stats.get(l);
    out.set(l, tierOf(s?.merged ?? 0, s?.closed ?? 0, over.get(l) ?? null, rule));
  }
  return out;
}

/** Setting that holds the pipeline account's login, recorded wherever the pipeline pushes as that account. */
export const PIPELINE_LOGIN_KEY = "pipeline_login";

/** PRs the pipeline opened itself from a Fix issues attempt, as `repo#number`, when authored by its own account. */
function ownFixPrs(db: DatabaseSync, repo?: string): { login: string | null; prs: Set<string> } {
  const login = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(PIPELINE_LOGIN_KEY) as { value: string } | undefined)?.value ?? null;
  const prs = new Set<string>();
  if (!login) return { login, prs };
  for (const r of db.prepare("SELECT repo, pr_url FROM main.fix_attempts WHERE pr_url IS NOT NULL" + (repo ? " AND repo = ?" : "")).all(...(repo ? [repo] : [])) as { repo: string; pr_url: string }[]) {
    const m = r.pr_url.match(/\/pull\/(\d+)$/);
    if (m) prs.add(`${r.repo}#${m[1]}`);
  }
  return { login, prs };
}

export type QueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  /** Repos left out. */
  exclude?: string[];
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The classification run for labels, resolved once by the caller (default: latestRun). */
  run?: string | null;
};

export function buildQueue(db: DatabaseSync, opts: QueueOptions = {}): QueueEntry[] {
  const states = { exclude: "'OPEN'", only: "'MERGED'", all: "'OPEN', 'MERGED'" }[opts.merged ?? "all"];
  const params: Record<string, string | number> = {};
  const where: string[] = [];
  if (opts.repo) { where.push("i.repo = :repo"); params.repo = opts.repo; }
  opts.exclude?.forEach((r, k) => { where.push(`i.repo <> :ex${k}`); params[`ex${k}`] = r; });
  if (opts.refs) { where.push("i.repo || '#' || i.number IN (SELECT value FROM json_each(:refs))"); params.refs = JSON.stringify([...opts.refs]); }
  if (opts.after) {
    where.push("(i.repo > :ar OR (i.repo = :ar AND i.number > :an))");
    params.ar = opts.after.repo;
    params.an = opts.after.number;
  }
  // Latest review per PR (newest `at`, then rowid); only take and take-fix verdicts enter the queue.
  const rows = db.prepare(`
    SELECT i.repo, i.number, i.title, i.author, i.state, i.review_decision, i.head_oid, i.updated_at, i.mergeable AS i_mergeable,
      c.head_oid AS c_head, c.fetched_at AS c_at, c.overall, c.mergeable AS c_mergeable,
      l.head_oid AS r_head, l.seen_at AS r_seen, l.disc_hash AS r_hash, l.sure, l.mode, l.verdict, l.reason, l.fixes, COALESCE(i.additions, 0) + COALESCE(i.deletions, 0) AS lines, l.at AS r_at,
      i.head_repo, i.head_ref, i.base_ref, i.maintainer_can_modify AS i_can, c.maintainer_can_modify AS c_can
    FROM items i
    JOIN final_reviews l ON l.repo = i.repo AND l.number = i.number AND l.head_oid = (
      SELECT r.head_oid FROM opus_reviews r WHERE r.repo = i.repo AND r.number = i.number AND r.verdict IS NOT NULL ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    LEFT JOIN pr_checks c ON c.repo = l.repo AND c.number = l.number
    WHERE l.verdict IN ('take', 'take-fix') AND i.kind = 'pr' AND i.state IN (${states}) AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} ${where.map((w) => `AND ${w}`).join(" ")}
    ORDER BY i.repo, i.number ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ""}`).all(params) as Row[];

  const merges = db.prepare("SELECT outcome, reason FROM merges WHERE repo = ? AND number = ? AND head_oid = ? ORDER BY at DESC, rowid DESC LIMIT 1");
  const waiting = db.prepare("SELECT runs, approved, reread, failed, cross_repo FROM ci_run_approvals WHERE repo = ? AND number = ? AND head_oid = ?");
  const verifs = db.prepare("SELECT state, kind, summary, note FROM verifications WHERE repo = ? AND number = ? AND head_sha = ?");
  const decision = db.prepare("SELECT id, answer FROM decisions WHERE id = ?");
  const pushChain = pushChainOf(db);
  const unsureAt = db.prepare(UNSURE_AT_SQL);
  const openQuestion = db.prepare(OPEN_QUESTION_SQL);
  const answeredAfter = db.prepare("SELECT 1 FROM decisions WHERE id = ? AND kind = 'merge' AND answer = 'merge' AND answered_at > ? AND answered_by IN (SELECT login FROM access WHERE role = 'operator')");
  const answers = new Map(actionable(db).filter((a) => a.kind === "merge").map((a) => [a.id, a.answer]));
  const tiers = tiersOf(db, [...new Set(rows.map((r) => r.author).filter((a): a is string => !!a))]);
  const inBatch = batchStates(db, opts.repo);
  const own = ownFixPrs(db, opts.repo);
  const stale = staleReviews(db, opts.repo);
  const state = discussionState(db, opts.repo);
  const settled = settledLookup(db, opts.run !== undefined ? opts.run : latestRun(db));

  // The mirror keeps the latest 10 reviews of a PR; GitHub's review decision covers an older block that fell out of them.
  const reviewRows = db.prepare("SELECT author, author_association AS association, review_state AS state, created_at AS at FROM comments WHERE repo = ? AND number = ? AND kind = 'review'");
  const gates = gatesOf(db, opts.repo);
  const holds = mergeHolds(db, opts.repo);
  const noCiMemo = new Map<string, boolean>();
  const noCi = (repo: string) => noCiMemo.get(repo) ?? (noCiMemo.set(repo, repoHasNoCi(db, repo)), noCiMemo.get(repo)!);
  const approvals = new Map<string, { push: boolean; comment: boolean }>();
  const longLivedBy = new Map<string, LongLived>();
  const out: QueueEntry[] = [];
  for (const r of rows) {
    const last = merges.get(r.repo, r.number, r.r_head) as { outcome: string; reason: string | null } | undefined;
    const mergedByUs = last?.outcome === "merged";
    // A review older than a comment or review by someone else waits for the review again: the PR has no review until then.
    if (r.state === "OPEN" && !mergedByUs && (stale.has(`${r.repo}#${r.number}@${r.r_head}`) || changedSince(state.get(`${r.repo}#${r.number}`), r.r_seen ?? r.r_at, r.r_hash))) continue;
    // A merged PR keeps the review of the head it merged at; an open one must be reviewed at its current head.
    if (r.state === "OPEN" && !mergedByUs && headOf(r) !== r.r_head) continue;
    // Checks describe the reviewed head only when they were fetched for it.
    const checksHere = r.c_head === r.r_head;
    const wait = waiting.get(r.repo, r.number, r.r_head) as { runs: string; approved: string; reread: number; failed: string; cross_repo: number } | undefined;
    const waitRuns = JSON.parse(wait?.runs ?? "[]") as { id: number; event?: string }[];
    const runsWaiting = waitRuns.length + (wait?.reread ? 1 : 0);
    // The rollup does not list runs that waited for approval: CI is not known to be green until the runs we approved have finished.
    const approvedPending = (JSON.parse(wait?.approved ?? "[]") as unknown[]).length > 0;
    const ci = checksHere ? (approvedPending ? "pending" : (r.overall ?? "none")) : "unknown";
    const failedRuns = JSON.parse(wait?.failed ?? "{}") as Record<string, number>;
    const runsBlocked: QueueEntry["runsBlocked"] = !runsWaiting ? null : !ciApprovalOf(db, r.repo) ? "off" : waitRuns.some((x) => (failedRuns[x.id] ?? 0) >= MAX_FAILURES) ? "failed"
      : !wait?.reread && (!wait?.cross_repo || !waitRuns.some((x) => x.event === "pull_request")) ? "unsupported" : null;
    const mergeable = (checksHere ? r.c_mergeable : r.i_mergeable) ?? "UNKNOWN";
    let tier = r.author ? tiers.get(r.author)! : "not";
    // The pipeline's own Fix PRs count as whitelisted; an operator's deny still wins.
    if (tier === "not" && r.author && r.author === own.login && own.prs.has(`${r.repo}#${r.number}`)) tier = "whitelisted";
    const label = settled(r.repo, r.number).label;
    const size = sizeOf(r.lines);
    let fixes = 0;
    try { fixes = (JSON.parse(r.fixes ?? "[]") as unknown[]).length; } catch { /* none */ }

    const outsideRule: string[] = [];
    if (r.verdict !== "take") outsideRule.push("review asks for fixes");
    // An unsure review at this head sticks until a person answers its Merge? question, whatever a later review of the head says.
    // An unsure review anywhere in the chain of heads (the head and the heads AutoCraft pushed it from) needs a person's merge answer
    // at this head, given after its latest review.
    const unsure = r.sure === 0 || pushChain(r.repo, r.number, r.r_head).some((h) => unsureAt.get(r.repo, r.number, h));
    if (unsure) outsideRule.push(UNSURE_REASON);
    if (r.state === "OPEN" && openQuestion.get(r.repo, r.number)) outsideRule.push("a Merge? question is still open");
    // No stage writes mode 'skipped' today; a review row with it never merges by rule.
    if (r.mode === "skipped") outsideRule.push("the review was skipped");
    if (!RULE_SIZES.includes(size)) outsideRule.push(`size ${size}`);
    if (!label || !RULE_LABELS.includes(label)) outsideRule.push(label ? `label ${label}` : "no settled label");
    if (!RULE_TIERS.includes(tier)) outsideRule.push(r.author ? "author not on the whitelist" : "author unknown");

    const verify = (verifs.get(r.repo, r.number, r.r_head) as QueueEntry["verify"] | undefined) ?? null;
    if (verify?.state === VERIFY_UNAVAILABLE) outsideRule.push(`not verified: ${verify.summary ?? "Verify cannot build this repo"}`);
    if (ci === "none" && noCi(r.repo)) outsideRule.push("the repo has no CI checks");
    const id = mergeDecisionId(r.repo, r.number, r.r_head);
    const asked = decision.get(id) as { id: string; answer: string | null } | undefined;
    // Only a merge answer is set aside at an unsure head; a hold or close still counts.
    const given = (answers.get(id) as string | undefined) ?? null;
    const answer = given === "merge" && unsure && !answeredAfter.get(id, r.r_at) ? null : given;
    const e: QueueEntry = {
      repo: r.repo, number: r.number, title: r.title ?? "", author: r.author, tier, head: r.r_head, size, label,
      verdict: r.verdict, reason: r.reason, fixes, ci, mergeable, state: "needs-decision", path: null, outsideRule, runsWaiting, runsBlocked,
      decisionId: asked ? id : null, noCi: ci === "none" && noCi(r.repo), answer, refusedReason: null, reviewedAt: r.r_at, verify, held: holds.has(`${r.repo}#${r.number}`), note: null, blockedLive: false,
    };
    const open = r.state === "OPEN" && !mergedByUs;
    // A maintainer's formal block comes before everything else: the PR is never asked about, batched or merged while it stands.
    // A live read newer than the PR's last change decides; otherwise the mirrored reviews do.
    const gate = gates.get(`${r.repo}#${r.number}`);
    const live = gate && gate.readAt > (r.updated_at ?? "") ? gate : null;
    const why = live ? (live.blocked ? reasonFor(live.by) : null) : refuseReviews(reviewRows.all(r.repo, r.number) as ReviewFact[], r.review_decision);
    if (open && gate && gate.failures >= GATE_FAILURES) e.note = failureNote(gate.failures);
    if (open && why) { e.state = "changes-requested"; e.note = why; e.blockedLive = !!live; out.push(e); continue; }
    e.state = stateOf(e, r.state === "MERGED" || mergedByUs, last, open && (backlogHeld(db, r.repo, r.number) ? "backlog" : duplicateHeld(db, r.repo, r.number) ? "duplicate" : null));
    if (open && mergeable === "CONFLICTING" && r.base_ref) {
      const ap = approvals.get(r.repo) ?? (approvals.set(r.repo, { push: pushApprovalOf(db, r.repo) !== null, comment: commentApprovalOf(db, r.repo) !== null }), approvals.get(r.repo)!);
      e.conflictNote = conflictNote(conflictBucket(db, { repo: r.repo, number: r.number, head: r.r_head, pushable: pushable(r.head_repo, r.repo, checksHere ? r.c_can : r.i_can, r.head_ref, (longLivedBy.get(r.repo) ?? (longLivedBy.set(r.repo, longLivedOf(db, r.repo)), longLivedBy.get(r.repo)!))) }, ap), r.base_ref);
    }
    const batch = inBatch.get(`${r.repo}#${r.number}@${r.r_head}`);
    if (batch && BATCHABLE.includes(e.state)) e.state = batch;
    out.push(e);
  }
  return out;
}

/** The queue state a PR is in until its verification passed (or said CI is enough); null once it did. */
function verifyState(e: QueueEntry): QueueState | null {
  const s = e.verify?.state;
  if (verifyOk(s) || s === VERIFY_UNAVAILABLE) return null;
  return s === "failed" ? "verify-failed" : s === "error" ? "verify-error" : "waiting-verify";
}

function stateOf(e: QueueEntry, merged: boolean, last: { outcome: string; reason: string | null } | undefined, held: "backlog" | "duplicate" | null | false = null): QueueState {
  if (merged) return "merged";
  // A Backlog answer, an open Duplicate? decision or a duplicate close keeps the item out of every later stage.
  if (held === "backlog") return "held-backlog";
  if (held) return "held-duplicate";
  if (e.verdict === "take-fix") return "needs-fix-up";
  if (!e.outsideRule.length) e.path = "rule";
  else if (e.answer === "merge") e.path = "operator";
  else if (e.answer) return "declined";
  if (e.mergeable === "CONFLICTING") return "conflict";
  if (e.ci === "failure") return "ci-failed";
  if (e.runsWaiting > 0) return "ci-approval";
  // A Merge? question is asked only once the operator can see the verification result.
  if (!e.path) return verifyState(e) ?? "needs-decision";
  if (!ciAllows(e.path, e.ci, e.noCi) || e.mergeable !== "MERGEABLE") return "waiting-ci";
  const v = verifyState(e);
  if (v) return v;
  if (last?.outcome === "refused") {
    e.refusedReason = last.reason;
    return "refused";
  }
  return e.path === "rule" ? "ready" : "decision-answered-merge";
}

/** Merge? questions still to ask: take PRs outside the rule with no decision at their head. A member of an open duplicate group is asked after the group is answered: an item has one open decision. */
export const toAsk = (db: DatabaseSync, queue: QueueEntry[]): QueueEntry[] => {
  const grouped = new Set((db.prepare(`SELECT gi.repo || '#' || gi.number AS ref FROM dupe_group_items gi JOIN decisions g ON g.id = gi.decision_id
    WHERE ${OPEN_GROUP_SQL} AND gi.role <> 'stay'`).all() as { ref: string }[]).map((r) => r.ref));
  return queue.filter((e) => e.state === "needs-decision" && !e.decisionId && !grouped.has(`${e.repo}#${e.number}`));
};

/** SQL condition on `g` (a decisions row): a duplicate group decision that is unanswered or answered "keep #N instead" with the new roles not applied yet. */
export const OPEN_GROUP_SQL = `(g.kind = 'duplicate' AND g.id LIKE '%:dupegroup:%' AND (g.answer IS NULL
  OR (g.answer LIKE 'keep:%' AND COALESCE((SELECT dg.applied_answer FROM dupe_groups dg WHERE dg.decision_id = g.id), '') <> g.answer)))`;

export function countStates(entries: QueueEntry[]): Record<QueueState, number> {
  const c = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<QueueState, number>;
  for (const e of entries) c[e.state]++;
  return c;
}

/** How many merged PRs have a take or take-fix final review as their latest. */
export function countMerged(db: DatabaseSync, repo?: string, exclude: string[] = []): number {
  const params: Record<string, string> = repo ? { repo } : {};
  exclude.forEach((r, k) => { params[`ex${k}`] = r; });
  return (db.prepare(`SELECT COUNT(*) AS n FROM items i
    JOIN final_reviews l ON l.repo = i.repo AND l.number = i.number AND l.head_oid = (
      SELECT r.head_oid FROM opus_reviews r WHERE r.repo = i.repo AND r.number = i.number AND r.verdict IS NOT NULL ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    WHERE l.verdict IN ('take', 'take-fix') AND i.kind = 'pr' AND i.state = 'MERGED' ${repo ? "AND i.repo = :repo" : ""}${exclude.map((_, k) => ` AND i.repo <> :ex${k}`).join("")}`)
    .get(params) as { n: number }).n;
}

/** A PR refused at its current head waits for its CI or mergeable state to differ from what GitHub reported at the refusal. */
export function refusedAsBefore(db: DatabaseSync, e: { repo: string; number: number; head: string; state: string; ci: string; mergeable: string }): boolean {
  if (e.state !== "refused") return false;
  const r = db.prepare("SELECT outcome, ci, mergeable, at FROM merges WHERE repo = ? AND number = ? AND head_oid = ? ORDER BY at DESC, rowid DESC LIMIT 1")
    .get(e.repo, e.number, e.head) as { outcome: string; ci: string | null; mergeable: string | null; at: string } | undefined;
  if (r?.outcome !== "refused") return false;
  // Runs approved after the refusal may have changed what it was about, though ci and mergeable read the same.
  const approved = db.prepare("SELECT approved_at FROM ci_run_approvals WHERE repo = ? AND number = ? AND head_oid = ?").get(e.repo, e.number, e.head) as { approved_at: string | null } | undefined;
  if (approved?.approved_at && approved.approved_at > r.at) return false;
  return r.ci === null || r.mergeable === null || (r.ci === e.ci && r.mergeable === e.mergeable);
}
