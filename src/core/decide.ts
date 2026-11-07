// decidePr: the review-to-merge rules for one open PR, in one place. Pure: no database, no clock (facts carry `now`).
// The merge queue's rules (src/merge/queue.ts buildQueue, stateOf, eligible, toAsk) are ported rule by rule, in the same order and with the same reason wording.
import {
  BATCHABLE, MAIN_RED_HELD, PREMERGE_DEFECT_REASON, PREMERGE_UNSURE_REASON, PREMERGE_FAILED_REASON, PREMERGE_MAX_TRIES, RETRY_AFTER_MS, REVIEW_LABELS, KEEP_IN_CORE,
  RULE_LABELS, RULE_SIZES, RULE_TIERS, UNSURE_REASON, VERIFY_UNAVAILABLE, ciAllows, conflictNote, verifyAllows, verifyOk,
  FIXUP_MAX_ATTEMPTS, CIFIX_FINAL_STATES, CIFIX_MAX_PUSHES_PER_PR, CIFIX_MAX_TRIES, CIFIX_MAX_TRIES_PER_PR,
} from "./rules.ts";
import { UNCHECKED_REASON } from "./sensitive.ts";
import { inFlightNow, unassignActions } from "./assignment.ts";
import type { Action, Plan, PlanState, PrFacts, QueueState } from "./plan.ts";

/** The start of a statement for a reason line: one line, at most 80 characters. */
const excerpt = (t: string): string => { const s = t.replace(/\s+/g, " ").trim(); return s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s; };

type PremergeState = "none" | "clean" | "fix" | "defect" | "unsure" | "failed" | "retry";
export type Entry = { state: QueueState; path: "rule" | "operator" | null; reasons: string[]; note: string | null; conflictNote: string | null; premerge: PremergeState | null; premergeDefects: number; answer: string | null; noCi: boolean; refusedReason: string | null };

const verifyState = (f: PrFacts): QueueState | null => {
  const s = f.verification?.state;
  if (verifyOk(s) || s === VERIFY_UNAVAILABLE) return null;
  return s === "failed" ? "verify-failed" : s === "error" ? "verify-error" : "waiting-verify";
};

/** The queue entry of a PR that has a take or take-fix review at its head (or merged at the reviewed head). */
export function queueEntry(f: PrFacts, merged: boolean, open: boolean): Entry {
  const r = f.review!;
  const noCi = f.ci === "none" && f.repoFacts.noCi;
  const reasons: string[] = [];
  if (r.verdict !== "take") reasons.push("review asks for fixes");
  if (r.unsure) reasons.push(UNSURE_REASON);
  if (f.ghState === "OPEN" && f.decision.openQuestion) reasons.push("a Merge? question is still open");
  if (r.mode === "skipped") reasons.push("the review was skipped");
  if (!RULE_SIZES.includes(f.size)) reasons.push(`size ${f.size}`);
  if (!f.label || !RULE_LABELS.includes(f.label)) reasons.push(f.label ? `label ${f.label}` : "no settled label");
  else if (f.labelUnsure) reasons.push("label settled by an unsure referee");
  if (!RULE_TIERS.includes(f.tier)) reasons.push(f.author ? "author not on the whitelist" : "author unknown");
  reasons.push(...(f.sensitive ?? []));
  for (const c of f.statementConflicts) reasons.push(`conflicts with ${c.where}: "${excerpt(c.text)}" (${c.reason})`);
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
    else if (!row.defects) premerge = row.unsure ? "unsure" : "clean";
    else {
      // A Merge? decision at this head (a Hold, say) is never replaced by a fix-up.
      const fixable = !f.decision.asked && row.defectsAllFixable && !f.premergeFixUsed && f.repoFacts.pushApproved && f.pushable;
      premerge = fixable ? "fix" : "defect";
    }
    if (premerge === "defect") reasons.push(PREMERGE_DEFECT_REASON);
    else if (premerge === "unsure") reasons.push(PREMERGE_UNSURE_REASON);
    else if (premerge === "failed") reasons.push(PREMERGE_FAILED_REASON);
    // The pre-merge review caches the diff, so a diff still unchecked after it is a reason; before it the PR waits for it.
    else if (premerge === "clean" && f.sensitive === null) reasons.push(UNCHECKED_REASON);
  }
  const e: Entry = { state: "needs-decision", path: null, reasons, note: null, conflictNote: null, premerge, premergeDefects: defects, answer, noCi, refusedReason: null };

  if (open && f.gateFailureNote) e.note = f.gateFailureNote;
  // A maintainer's formal block comes before everything else.
  if (open && f.changesRequested) { e.state = "changes-requested"; e.note = f.changesRequested.why; return e; }

  e.state = stateOf(f, e, merged, open && (f.heldBacklog ? "backlog" : f.heldDuplicate ? "duplicate" : null));
  if (open && f.mergeable === "CONFLICTING" && f.conflict) e.conflictNote = conflictNote(f.conflict.bucket, f.conflict.base);
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
  // An operator's Hold or Close answer declines the PR on every path, also when the rule would merge it.
  if (e.answer && e.answer !== "merge") return "declined";
  if (!e.reasons.length) e.path = "rule";
  else if (e.answer === "merge") e.path = "operator";
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
  if (f.lastMerge?.outcome === "refused") {
    e.refusedReason = f.lastMerge.reason;
    return "refused";
  }
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

/** An operator's Hold or Close answer at the head: nothing is pushed or asked of the contributor, whatever the source. */
const declinedBy = (f: PrFacts): boolean => f.decision.answer !== null && f.decision.answer !== "merge";

export type FixupBucket = "fix" | "unapproved" | "cannot-push" | "ask" | "asked" | "hold";
const notHeld = (f: PrFacts): boolean => f.inScope && !f.integration && !f.heldBacklog && !f.heldDuplicate;

/** Where a take-fix review at the current head stands with the fix-up: the bucket and whether the step has recorded a final row for the head. */
export function fixupOf(f: PrFacts): { bucket: FixupBucket; done: boolean } | null {
  const r = f.review, x = f.fixup;
  if (declinedBy(f) || !r || !x || r.verdict !== "take-fix" || r.head !== f.head || r.stale || f.draft || !notHeld(f) || f.ghState !== "OPEN" || f.mergeHeld) return null;
  // A maintainer's changes-requested review is the person's to resolve first.
  if (f.mergeable === "CONFLICTING" || x.fixes === 0 || f.changesRequested) return null;
  const has = (s: string) => x.recorded.includes(s);
  const commenting = f.repoFacts.commentApproved;
  // Heads held before the repo got comment approval are asked once it has it.
  const ask = (held: boolean): { bucket: FixupBucket; done: boolean } => (f.quiet ? { bucket: "cannot-push", done: true } : commenting ? { bucket: "ask", done: false } : { bucket: "cannot-push", done: held });
  if (has("asked") && !f.pushable) return { bucket: "asked", done: true };
  if (has("comment-failed")) return { bucket: "cannot-push", done: true };
  // A stored patch waits for its lint task: no new try, no ask.
  if (has("pushed") || has("push-denied") || has("linting")) return { bucket: "hold", done: true };
  if (has("cannot-push") && !f.pushable) return ask(true);
  // A fix-up we cannot make (too large, or the tries are used) goes to the contributor as the review's fix list, once per head.
  const askOnce = (held: boolean): { bucket: FixupBucket; done: boolean } => (has("asked") ? { bucket: "asked", done: true } : ask(held));
  if (has("too-large")) return askOnce(true);
  if (!f.pushable) return ask(false);
  if (x.attempts + 1 > FIXUP_MAX_ATTEMPTS) return commenting ? askOnce(false) : { bucket: "hold", done: false };
  return { bucket: f.repoFacts.pushApproved ? "fix" : "unapproved", done: false };
}

export type CifixBucket = "work" | "unapproved" | "cannot-push" | "formatting" | "linting" | "collect" | "rerun" | "rerun-wait" | "failed" | "capped" | "done";

/** Where the CI fix step stands for a PR whose CI fails at the reviewed head, or null when it is no candidate. */
export function cifixBucket(f: PrFacts): CifixBucket | null {
  const r = f.review, c = f.cifix;
  // Our own push that turned the checks red is repaired against the pushed head, whose review is still the one of the head before.
  const broke = !!f.brokeByUs;
  if (declinedBy(f) || !r || !c || (r.verdict !== "take" && r.verdict !== "take-fix") || (r.head !== f.head && !broke) || f.ghState !== "OPEN" || (f.ci !== "failure" && !broke) || f.draft || !notHeld(f)) return null;
  if (f.mergeable === "CONFLICTING" || (r.stale && !broke) || f.changesRequested || f.mergeHeld) return null;
  if (r.verdict === "take-fix") {
    const fx = fixupOf(f);
    if (fx && ["fix", "unapproved", "ask"].includes(fx.bucket)) return null;
  }
  const has = (s: string) => c.states.includes(s);
  if (CIFIX_FINAL_STATES.some(has)) return "done";
  if (has("linting")) return "linting";
  if (c.formattingTask !== null || has("formatting")) return c.formattingTask !== null && c.formatterEnded ? "collect" : "formatting";
  if (has("capped")) return "failed";
  if (c.totalPushes >= CIFIX_MAX_PUSHES_PER_PR || c.totalTries >= CIFIX_MAX_TRIES_PER_PR) return "capped";
  if (c.tries >= CIFIX_MAX_TRIES) return "failed";
  if (c.infraRuns && c.rerunAt === null) return "rerun";
  if (c.rerunAt !== null && !(c.checksAt && c.checksAt > c.rerunAt)) return "rerun-wait";
  if (!f.pushable && !f.repoFacts.commentApproved) return "cannot-push";
  if (f.pushable && !f.repoFacts.pushApproved) return "unapproved";
  return "work";
}

/** The CI fix step's action bucket: what it does next, or null when it does nothing. */
function cifixOf(f: PrFacts): "work" | "collect" | "rerun" | "capped" | "ask" | "other" | null {
  const b = cifixBucket(f);
  if (b === null) return null;
  // A fix given up or capped at this head: the contributor is asked once.
  // Not for our own breakage, and not when the fix-up already asked at this head: one comment per head.
  if ((b === "failed" || b === "capped") && f.repoFacts.commentApproved && !f.brokeByUs && fixupOf(f)?.bucket !== "asked") return "ask";
  if (b === "rerun") return f.repoFacts.ciApproved ? "rerun" : "other";
  return b === "work" || b === "collect" || b === "capped" ? b : "other";
}

/** What a PR waits on when its conflict or CI fix is left to the contributor. */
const stuckWait = (f: PrFacts): string | null => {
  const approval = "comment approval for the repo";
  if (f.mergeable === "CONFLICTING" && f.conflict && ["ask", "asked", "held"].includes(f.conflict.bucket)) return f.conflict.bucket === "held" ? (f.repoFacts.commentApproved ? "a person to resolve the conflict" : approval) : "the contributor to resolve the conflict";
  const cf = cifixBucket(f);
  if (cf === "done" && f.cifix?.states.includes("asked")) return "the contributor to fix CI";
  if (cf === "failed" || cf === "capped") return f.brokeByUs ? "a person to fix CI our push broke" : f.repoFacts.commentApproved ? "the contributor to fix CI" : approval;
  return cf === "cannot-push" ? approval : null;
};

/** Actions that work the PR towards merge (a push, a base merge, a review of a new head, a pre-merge review, the merge), as against comment-only asks. */
const worksOn = (a: Action): boolean => {
  const b = a.params?.bucket;
  switch (a.kind) {
    // A contributor's push during our work leaves a new head to review: the PR is still ours to carry on.
    case "review": case "carry": return true;
    case "fixup": return b === "fix" && a.params?.source !== "carry";
    case "conflict": return b === "merge";
    case "cifix": return b === "work" || b === "collect" || b === "rerun";
    case "merge": case "premerge": case "lint": return true;
    default: return false;
  }
};

/** Queue states on the path to merge: the PR stays assigned in them unless a stage gave it up. */
const PROGRESS_STATES: ReadonlySet<string> = new Set(["ready", "waiting-ci", "waiting-premerge", "waiting-verify", "ci-approval", "waiting-main-ci", "decision-answered-merge", "needs-fix-up", "ci-failed", "refused"]);

/** The unassign action of an open PR: kept while it is on the path to merge (in flight, in a batch, work due, a progress state), released in every other state and when a stage gave it up. */
function unassignOf(f: PrFacts, state: PlanState, actions: Action[]): Action[] {
  const fx = fixupOf(f), cf = cifixBucket(f);
  const inBatch = state === "in-batch" || state === "batch-checking" || f.inActiveBatch;
  const flying = inFlightNow(f, state);
  const waitingToReview = f.reviewHold?.kind === "ci" || f.reviewHold?.kind === "interval";
  const working = actions.some(worksOn) || inBatch || flying || waitingToReview;
  // A conflicting PR whose conflict step has nothing to do (asked, held, not approved, done) waits on its author, whatever the queue state says.
  const conflictStuck = f.mergeable === "CONFLICTING" && !!f.conflict && f.conflict.bucket !== "merge" && f.conflict.bucket !== "linting";
  const gaveUp = state === "opus-close" || state === "verify-failed" || state === "verify-error" || state === "batch-failed" || conflictStuck
    || (!!fx && (fx.bucket === "cannot-push" || fx.bucket === "asked" || (fx.bucket === "hold" && !fx.done))) || cf === "failed" || cf === "capped" || cf === "cannot-push" || cf === "done"
    || f.mergeHeld || (state === "ci-approval" && !f.repoFacts.ciApproved);
  const keep = working || (!gaveUp && PROGRESS_STATES.has(state));
  return unassignActions(f.assignment, f.ghState === "OPEN", !keep);
}

/** Who a PR in needs-fix-up waits on. Null while a fix-up, conflict, CI-fix or lint action of the PR is due (the action is the next step). */
function fixupWait(f: PrFacts, fx: { bucket: FixupBucket; done: boolean } | null, actions: Action[]): string | null {
  if (actions.some((a) => ["fixup", "conflict", "cifix", "lint"].includes(a.kind))) return null;
  if (f.mergeable === "CONFLICTING") return f.conflict?.bucket === "unapproved" ? "push approval for the repo" : "the contributor's merge of the base branch";
  switch (fx?.bucket) {
    case "asked": return "the contributor's fixes";
    case "cannot-push": return f.fixup?.recorded.includes("comment-failed") ? "a person: the ask comment failed" : f.repoFacts.commentApproved ? "the contributor's fixes" : "comment approval for the repo";
    case "hold": return fx.done ? "the new review of our pushed fix-up" : "comment approval for the repo";
    case "unapproved": return "push approval for the repo";
    case "ask": case "fix": return null;
    default: return "the review's fixes to be applied";
  }
}

export function decidePr(f: PrFacts): Plan {
  const plan = (state: PlanState, p: Partial<Plan> = {}): Plan => ({ repo: f.repo, number: f.number, head: f.head, state, path: null, reasons: [], note: null, actions: [], wait: null, eligible: false, conflictNote: null, ...p });
  const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });
  const r = f.review;
  const open = f.ghState === "OPEN";

  if (!f.inScope) return plan("out-of-scope", { actions: unassignActions(f.assignment, open, true) });
  // Our own integration PRs only carry reviewed PRs: their runs wait for approval like a member's.
  if (f.integration) {
    const approve = f.runs && !f.mergeHeld && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0));
    return plan("integration", { actions: approve ? [act("approve-ci", f.head)] : [] });
  }
  // The mirror shows a head we already pushed off: anything planned or asked here would be about a commit that is gone, and the PR is still ours, so the assignment stays.
  if (open && f.pushedOff) return plan("pushed", { wait: "the mirror to show our push" });
  const held = f.heldBacklog || f.heldDuplicate;

  // Actions that do not depend on the PR's place in the queue.
  const extra: Action[] = [];
  const pm = f.postmerge;
  if (pm && pm.mergedAt >= pm.since) {
    const retryAfter = new Date(f.now - RETRY_AFTER_MS).toISOString();
    const reviewed = pm.review && (pm.review.error === null || !pm.review.error.startsWith("retry:") || pm.review.at > retryAfter);
    if (!reviewed) extra.push(act("postmerge", pm.head));
  }
  if (f.ghState === "OPEN" && !f.heldBacklog && f.head && !f.draft && f.mergeable !== "CONFLICTING") {
    for (const c of declinedBy(f) || f.lint.some((l) => l.source === "carry") ? [] : f.carry) {
      if (f.pushable && f.repoFacts.pushApproved && c.attempts + 1 <= FIXUP_MAX_ATTEMPTS) extra.push(act("fixup", f.head, { bucket: "fix", source: "carry" }));
      else if (f.repoFacts.commentApproved && !f.quiet) extra.push(act("fixup", f.head, { bucket: "ask", source: "carry" }));
    }
  }

  // An operator's fix-up of this head (a resolution card's step, or the first part of a pre-approved merge); it needs no review verdict.
  const opFix = f.operator?.fix;
  if (opFix && f.ghState === "OPEN" && !f.heldBacklog && f.head && !f.draft && f.mergeable !== "CONFLICTING" && !f.lint.some((l) => l.source === "operator")
    && f.pushable && f.repoFacts.pushApproved && opFix.attempts + 1 <= FIXUP_MAX_ATTEMPTS) extra.push(act("fixup", f.head, { bucket: "fix", source: "operator" }));

  const mergedByUs = f.lastMerge?.outcome === "merged";
  const takeReview = !!r && (r.verdict === "take" || r.verdict === "take-fix");
  const merged = f.ghState === "MERGED" || mergedByUs;
  // A review older than a comment or review by someone else, or at another head, leaves the PR out of the queue until it is reviewed again.
  const inQueue = takeReview && (merged || (open && !r.stale && r.head === f.head));
  const reviewable = !f.draft && !!f.head && !!f.label && REVIEW_LABELS.includes(f.label)
    && (f.scopeAnswer !== null ? KEEP_IN_CORE.includes(f.scopeAnswer) : !f.needsDecisionFlag);

  const actions: Action[] = [...extra];
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

  if (!open && !inQueue) return plan("closed", { actions: extra });
  // A merged PR has only its post-merge review to do.
  if (merged) return plan(state, { ...(e ? { path: e.path, reasons: e.reasons, note: e.note, eligible: eligible(f, e) } : {}), actions: extra });

  // Review: no review at the head, or one made stale (a PR at its re-review cap waits).
  // A head whose earlier review carries over our checked fix-up is carried, not reviewed.
  // A due review waits while another item blocks the PR, CI at the head has not passed, or the day's review cap is used (src/review/gate.ts); a carry only waits for CI.
  let reviewWait: string | null = null;
  if (!held && reviewable && f.carriable) {
    if (f.reviewHold?.kind === "ci") reviewWait = f.reviewHold.wait;
    else actions.push(act("carry", f.head));
  } else if (!held && reviewable && !(r && r.head === f.head && !r.staleActionable)) {
    if (f.reviewHold) reviewWait = f.reviewHold.wait;
    else actions.push(act("review", f.head));
  }

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
  if (!held && r && takeReview && r.head === f.head && f.checksHere && f.checksOpen && f.runs && !f.mergeHeld && !declinedBy(f)
    && (f.runs.reread || (f.runs.crossRepo && f.runs.approvable > 0))) actions.push(act("approve-ci", r.head));

  // Fix-up of a take-fix review's fixes, or of the pre-merge review's defect fixes.
  const fx = fixupOf(f);
  // The review's own fix-up waits while an operator's fix-up of the head is queued: two pushes would move the head under each other.
  if (f.operator?.fix) { /* the operator's fix-up above */ }
  else if (fx) {
    if (fx.bucket === "ask" || (!fx.done && (fx.bucket === "cannot-push" || fx.bucket === "fix"))) actions.push(act("fixup", f.head, { bucket: fx.bucket, source: "review" }));
  } else if (e && e.state === "needs-fix-up" && e.premerge === "fix" && f.premerge?.fixesSafe && f.mergeable !== "CONFLICTING" && !f.mergeHeld && !f.draft && !f.lint.some((l) => l.source === "premerge")) {
    actions.push(act("fixup", f.head, { bucket: "fix", source: "premerge" }));
  }

  // Merge the base branch into a conflicting PR, or ask the contributor.
  if (f.conflict && f.conflict.baseOk && f.mergeable === "CONFLICTING" && r && takeReview && r.head === f.head && !r.stale && !f.draft && !held && !f.mergeHeld && !f.inActiveBatch && !declinedBy(f)) {
    if (f.conflict.bucket === "merge" || f.conflict.bucket === "ask") actions.push(act("conflict", f.head, { bucket: f.conflict.bucket }));
  }

  const cf = cifixOf(f);
  if (cf && cf !== "other") {
    // Repairing our own breakage comes before every other action of the PR.
    if (f.brokeByUs && (cf === "work" || cf === "collect")) actions.unshift(act("cifix", f.head, { bucket: cf }));
    else actions.push(act("cifix", f.head, { bucket: cf }));
  }

  // Stored model patches whose lint task ended: the collect step folds the format changes and pushes, or sends the findings back to the model.
  for (const l of f.lint) {
    // A conflict resolution is collected while the PR still conflicts; every other patch needs it not to.
    const conflicted = l.step === "conflict";
    const basic = l.ended && open && !f.draft && !declinedBy(f) && (conflicted ? f.mergeable === "CONFLICTING" && !!f.conflict?.baseOk && !f.inActiveBatch : f.mergeable !== "CONFLICTING") && !f.mergeHeld && !f.heldBacklog && !!f.head;
    // A carry-over needs no review at the head; every other patch needs a take review there that is not stale.
    // A CI fix of our own breakage is reviewed against the head before the push.
    const reviewed = l.source === "carry" || l.source === "operator" || (l.step === "cifix" && !!f.brokeByUs && !!r && takeReview && notHeld(f)) || (!!r && takeReview && r.head === f.head && !r.stale && notHeld(f));
    const approved = f.pushable ? f.repoFacts.pushApproved : l.step === "cifix" && f.repoFacts.commentApproved;
    if (basic && reviewed && approved) actions.push(act("lint", f.head, { bucket: l.step, source: l.source }));
  }

  if (e) {
    if (e.state === "waiting-premerge" && f.repoFacts.mergeApproved && premergeRetryDue(f)) actions.push(act("premerge", r!.head));
    if (e.state === "needs-decision" && !f.decision.asked && !f.decision.inOpenGroup) actions.push(act("ask-merge", r!.head));
    if (eligible(f, e) && !refusedAsBefore(f, e)) {
      const singleOnly = f.verification?.state === VERIFY_UNAVAILABLE || e.noCi || f.mainFix;
      actions.push(act("merge", r!.head, { singleOnly, batchable: !singleOnly }));
    }
  }

  // A pre-approved merge before its merge answer: the PR is not merged, batched or asked about meanwhile (src/preapproval).
  if (f.operator?.hold) for (let i = actions.length - 1; i >= 0; i--) if (["merge", "ask-merge", "premerge"].includes(actions[i]!.kind)) actions.splice(i, 1);
  // Its pre-merge review is the one thing it still needs from the queue: the merge answer is handed over only after a clean one at the head.
  if (f.operator?.premerge && e && r && inQueue && f.repoFacts.mergeApproved && !f.draft && !f.mergeHeld && ciAllows("operator", f.ci, e.noCi) && f.mergeable === "MERGEABLE" && premergeRetryDue(f)) actions.push(act("premerge", r.head));

  actions.push(...unassignOf(f, state, actions));

  const main = actions.some((a) => ["review", "carry", "premerge", "ask-merge", "merge", "verify"].includes(a.kind));
  const wait = main ? null : e ? (f.mergeHeld && e.state !== "merged" ? "merge held by an operator" : stuckWait(f) ?? (e.state === "needs-fix-up" ? fixupWait(f, fx, actions) : WAITS[e.state] ?? null)) : null;
  return plan(state, { ...(e ? { path: e.path, reasons: e.reasons, note: e.note, conflictNote: e.conflictNote, eligible: eligible(f, e) } : {}), actions, wait: wait ?? (f.operator?.hold && !main ? "its pre-approved merge" : null) ?? (!main ? reviewWait : null) });
}
