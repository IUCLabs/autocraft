// decidePr: the review-to-merge rules for one open PR, in one place. Pure: no database, no clock (facts carry `now`).
// The merge queue's rules (src/merge/queue.ts buildQueue, stateOf, eligible, toAsk) are ported rule by rule, in the same order and with the same reason wording.
import {
  BATCHABLE, MAIN_RED_HELD, PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, PREMERGE_MAX_TRIES, RETRY_AFTER_MS, REVIEW_LABELS, KEEP_IN_CORE,
  RULE_LABELS, RULE_SIZES, RULE_TIERS, UNSURE_REASON, VERIFY_UNAVAILABLE, ciAllows, conflictNote, verifyAllows, verifyOk,
} from "./rules.ts";
import type { Action, Plan, PlanState, PrFacts, QueueState } from "./plan.ts";

type PremergeState = "none" | "clean" | "fix" | "defect" | "failed" | "retry";
type Entry = { state: QueueState; path: "rule" | "operator" | null; reasons: string[]; note: string | null; premerge: PremergeState | null; premergeDefects: number; answer: string | null; noCi: boolean };

const verifyState = (f: PrFacts): QueueState | null => {
  const s = f.verification?.state;
  if (verifyOk(s) || s === VERIFY_UNAVAILABLE) return null;
  return s === "failed" ? "verify-failed" : s === "error" ? "verify-error" : "waiting-verify";
};

/** The queue entry of a PR that has a take or take-fix review at its head (or merged at the reviewed head). */
function queueEntry(f: PrFacts, merged: boolean, open: boolean): Entry {
  const r = f.review!;
  const noCi = f.ci === "none" && f.repoFacts.noCi;
  const reasons: string[] = [];
  if (r.verdict !== "take") reasons.push("review asks for fixes");
  if (r.unsure) reasons.push(UNSURE_REASON);
  if (f.ghState === "OPEN" && f.decision.openQuestion) reasons.push("a Merge? question is still open");
  if (r.mode === "skipped") reasons.push("the review was skipped");
  if (!RULE_SIZES.includes(f.size)) reasons.push(`size ${f.size}`);
  if (!f.label || !RULE_LABELS.includes(f.label)) reasons.push(f.label ? `label ${f.label}` : "no settled label");
  if (!RULE_TIERS.includes(f.tier)) reasons.push(f.author ? "author not on the whitelist" : "author unknown");
  if (f.verification?.state === VERIFY_UNAVAILABLE) reasons.push(`not verified: ${f.verification.summary ?? "Verify cannot build this repo"}`);
  if (f.ci === "none" && f.repoFacts.noCi) reasons.push("the repo has no CI checks");
  // Only a merge answer is set aside at an unsure head; a hold or close still counts.
  const given = f.decision.answer;
  const answer = given === "merge" && r.unsure && !f.decision.mergeAnswerAfterReview ? null : given;

  // The pre-merge review gates what the rule would merge; its blocking reasons count before the path is decided.
  let premerge: PremergeState | null = null;
  let defects = 0;
  if (open && !reasons.length) {
    const row = f.premerge;
    defects = row?.defects ?? 0;
    if (!row) premerge = "none";
    else if (!row.hasFindings) premerge = row.tries >= PREMERGE_MAX_TRIES ? "failed" : "retry";
    else if (!row.defects) premerge = "clean";
    else {
      // A Merge? decision at this head (a Hold, say) is never replaced by a fix-up.
      const fixable = !f.decision.asked && row.defectsAllFixable && !f.premergeFixUsed && f.repoFacts.pushApproved && f.pushable;
      premerge = fixable ? "fix" : "defect";
    }
    if (premerge === "defect") reasons.push(PREMERGE_DEFECT_REASON);
    else if (premerge === "failed") reasons.push(PREMERGE_FAILED_REASON);
  }
  const e: Entry = { state: "needs-decision", path: null, reasons, note: null, premerge, premergeDefects: defects, answer, noCi };

  if (open && f.gateFailureNote) e.note = f.gateFailureNote;
  // A maintainer's formal block comes before everything else.
  if (open && f.changesRequested) { e.state = "changes-requested"; e.note = f.changesRequested.why; return e; }

  e.state = stateOf(f, e, merged, open && (f.heldBacklog ? "backlog" : f.heldDuplicate ? "duplicate" : null));
  if (open && f.mergeable === "CONFLICTING" && f.conflict && e.note === null) e.note = conflictNote(f.conflict.bucket, f.conflict.base);
  // A rule-path PR without a clean pre-merge review keeps its own state: a batch must not land it.
  if (f.batch && BATCHABLE.includes(e.state) && (e.path !== "rule" || e.premerge === "clean")) e.state = f.batch;
  // A red main fails every PR's CI: ready PRs wait for it, except the PRs AutoCraft opened to fix it.
  else if (open && f.repoFacts.mainRed && MAIN_RED_HELD.includes(e.state) && !f.mainFix) e.state = "waiting-main-ci";
  return e;
}

function stateOf(f: PrFacts, e: Entry, merged: boolean, held: "backlog" | "duplicate" | null | false): QueueState {
  if (merged) return "merged";
  if (held === "backlog") return "held-backlog";
  if (held) return "held-duplicate";
  if (f.review!.verdict === "take-fix") return "needs-fix-up";
  if (!e.reasons.length) e.path = "rule";
  else if (e.answer === "merge") e.path = "operator";
  else if (e.answer) return "declined";
  if (f.mergeable === "CONFLICTING") return "conflict";
  if (f.ci === "failure") return "ci-failed";
  if ((f.runs?.waiting ?? 0) > 0) return "ci-approval";
  // A Merge? question is asked only once the operator can see the verification result.
  if (!e.path) return verifyState(f) ?? "needs-decision";
  if (!ciAllows(e.path, f.ci, e.noCi) || f.mergeable !== "MERGEABLE") return "waiting-ci";
  const v = verifyState(f);
  if (v) return v;
  if (e.path === "rule" && e.premerge) {
    if (e.premerge === "none" || e.premerge === "retry") return "waiting-premerge";
    if (e.premerge === "fix") {
      const n = e.premergeDefects;
      e.note = `pre-merge review: ${n} defect${n === 1 ? "" : "s"} to fix`;
      return "needs-fix-up";
    }
  }
  if (f.lastMerge?.outcome === "refused") return "refused";
  return e.path === "rule" ? "ready" : "decision-answered-merge";
}

/** True when the PR may be merged now (ready, approved, or retried after a refusal). */
const eligible = (f: PrFacts, e: Entry): boolean =>
  !f.mergeHeld && e.path !== null && verifyAllows(e.path, f.verification?.state) && ciAllows(e.path, f.ci, e.noCi) && f.mergeable === "MERGEABLE"
  && (e.state === "ready" || e.state === "decision-answered-merge" || e.state === "refused");

/** A PR refused at its current head waits until its CI or mergeable state differs from what GitHub reported at the refusal. */
const refusedAsBefore = (f: PrFacts, e: Entry): boolean => {
  const m = f.lastMerge;
  if (e.state !== "refused" || m?.outcome !== "refused") return false;
  if (f.runsApprovedAfterMerge) return false;
  return m.ci === null || m.mergeable === null || (m.ci === f.ci && m.mergeable === f.mergeable);
};

const premergeRetryDue = (f: PrFacts): boolean => {
  const row = f.premerge;
  if (!row) return true;
  if (row.hasFindings) return false;
  return row.tries < PREMERGE_MAX_TRIES && f.now - Date.parse(row.at) >= RETRY_AFTER_MS;
};

const WAITS: Partial<Record<QueueState, string>> = {
  "waiting-ci": "CI or GitHub's mergeable state", "waiting-premerge": "the pre-merge review", "waiting-verify": "verification",
  "needs-decision": "an operator's Merge? answer", "ci-approval": "approval of CI runs", "waiting-main-ci": "a green main", "in-batch": "its batch",
  "batch-checking": "its batch", "batch-failed": "its batch", "changes-requested": "the maintainer's review", refused: "a change in CI or mergeable state",
};

export function decidePr(f: PrFacts): Plan {
  const plan = (state: PlanState, p: Partial<Plan> = {}): Plan => ({ repo: f.repo, number: f.number, head: f.head, state, path: null, reasons: [], note: null, actions: [], wait: null, eligible: false, ...p });
  const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });
  const r = f.review;
  const open = f.ghState === "OPEN";

  // Our own integration PRs only carry reviewed PRs: their runs wait for approval like a member's.
  if (f.integration) {
    const approve = f.runs && !f.mergeHeld && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0));
    return plan("integration", { actions: approve ? [act("approve-ci", f.head)] : [] });
  }
  if (!f.inScope) return plan("out-of-scope");
  const held = f.heldBacklog || f.heldDuplicate;

  const mergedByUs = f.lastMerge?.outcome === "merged";
  const takeReview = !!r && (r.verdict === "take" || r.verdict === "take-fix");
  const merged = f.ghState === "MERGED" || mergedByUs;
  // A review older than a comment or review by someone else, or at another head, leaves the PR out of the queue until it is reviewed again.
  const inQueue = takeReview && (merged || (open && !r.stale && r.head === f.head));
  const reviewable = !f.draft && !!f.head && !!f.label && REVIEW_LABELS.includes(f.label)
    && (f.scopeAnswer !== null ? KEEP_IN_CORE.includes(f.scopeAnswer) : !f.needsDecisionFlag);

  const actions: Action[] = [];
  let e: Entry | null = null;
  let state: PlanState;
  if (inQueue) {
    e = queueEntry(f, merged, !merged);
    state = e.state;
  } else if (f.heldBacklog) state = "backlog";
  else if (f.heldDuplicate) state = "duplicate";
  else if (f.draft) state = "draft";
  else if (r && r.head === f.head && !r.stale && r.verdict === "hold") state = "opus-hold";
  else if (r && r.head === f.head && !r.stale && r.verdict === "close") state = "opus-close";
  else if (!f.label || !REVIEW_LABELS.includes(f.label)) state = "label-not-reviewed";
  else if (!reviewable) state = "scope";
  else state = r ? "review-stale" : "not-reviewed";

  // Merged PRs have no actions in this part.
  if (merged) return plan(state, e ? { path: e.path, reasons: e.reasons, note: e.note, eligible: eligible(f, e) } : {});

  // Review: no review at the head, or one made stale (a PR at its re-review cap waits).
  if (!held && reviewable && !(r && r.head === f.head && !r.staleActionable)) actions.push(act("review", f.head));

  // Post the review.
  if (!held && !f.authorIsPipeline && !f.batchPr && r && f.post.postable && r.head === f.head) {
    const p = f.post.posted;
    if (!(p && p.head === f.head && r.at <= (p.opusAt ?? p.at ?? ""))) actions.push(act("post-review", f.head));
  }

  // Verify: a take at the head, CI not failing, not verified yet (a stale verification does not count).
  if (!held && !f.draft && r && r.head === f.head && r.verdict === "take" && !r.stale && f.ci !== "failure" && (!f.verification || f.verification.state === "stale")) {
    actions.push(act("verify", f.head, { bucket: f.verifyUnavailable ? "unavailable" : "plan" }));
  }

  // Approve the CI runs GitHub holds for a fork PR's reviewed head.
  if (!held && r && takeReview && f.checksHere && f.checksOpen && f.runs && !f.mergeHeld && !(f.decision.answer && f.decision.answer !== "merge")
    && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0))) actions.push(act("approve-ci", r.head));

  if (e) {
    if (e.state === "waiting-premerge" && f.repoFacts.mergeApproved && premergeRetryDue(f)) actions.push(act("premerge", r!.head));
    if (e.state === "needs-decision" && !f.decision.asked && !f.decision.inOpenGroup) actions.push(act("ask-merge", r!.head));
    if (eligible(f, e) && !refusedAsBefore(f, e)) {
      const singleOnly = f.verification?.state === VERIFY_UNAVAILABLE || e.noCi || f.mainFix;
      actions.push(act("merge", r!.head, { singleOnly, batchable: !singleOnly }));
    }
  }

  const main = actions.some((a) => ["review", "premerge", "ask-merge", "merge", "verify"].includes(a.kind));
  const wait = main ? null : e ? (f.mergeHeld && e.state !== "merged" && e.path ? "merge held by an operator" : WAITS[e.state] ?? null) : null;
  return plan(state, { ...(e ? { path: e.path, reasons: e.reasons, note: e.note, eligible: eligible(f, e) } : {}), actions, wait });
}
