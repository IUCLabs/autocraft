// decideItem: the triage rules of one open item (issue or PR) in one place: classify, referee, prioritize, embed, duplicates,
// scope decision, label. Pure: no database, no clock (facts carry `now`). The rules are ported from the step selectors named at each rule.
// decideAll adds a PR's review-to-merge Plan (decide.ts) and derives the Work page's next-step text.
import { decidePr } from "./decide.ts";
import { RECOMMEND_MAX_FAILURES, RECOMMEND_RETRY_MS, alreadyLabeled, isScope, labelsToAdd } from "./item-rules.ts";
import type { Action, ItemFacts, ItemPlan, ItemState, ItemView, PrFacts } from "./plan.ts";

const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });

/** Why the item would become a scope decision, or null (decide/select.ts reasonOf). */
export function scopeReason(f: ItemFacts): "needs-decision" | "scope-disagreement" | null {
  const c = f.classification;
  if (c.status === "settled" && c.flags.includes("needs decision")) return "needs-decision";
  if (c.status === "disagree" && isScope(c.jevLabel) && isScope(c.haikuLabel)) return "scope-disagreement";
  return null;
}

/** Jev and Haiku chose different labels and it is not a scope call: Sonnet refereed it, or still has to. */
const labelDisagreement = (f: ItemFacts): boolean => f.classification.status === "disagree" && scopeReason(f) !== "scope-disagreement";

/** A scope decision should be asked: the reason holds and no decision or later stage covers the item (decide/select.ts selectCandidates, without its scope filters). */
const scopeNeeded = (f: ItemFacts): boolean => scopeReason(f) !== null && !f.scope.covered && !f.scope.pastClassified;

export function itemState(f: ItemFacts): ItemState {
  if (f.held) return f.held === "backlog" ? "held-backlog" : "held-duplicate";
  const c = f.classification;
  if (labelDisagreement(f)) return c.referee ? "models-disagree" : "referee-due";
  if (c.status === "unclassified") return "unclassified";
  if (c.status === "waiting") return "waiting-haiku";
  if (f.scope.open) return "scope-open";
  return scopeNeeded(f) ? "scope-due" : "classified";
}

const WAITS: Partial<Record<ItemState, string>> = {
  "held-duplicate": "a Duplicate? answer", "held-backlog": "a Backlog hold", "models-disagree": "a person to set the label",
  "waiting-haiku": "Haiku's second opinion", "scope-open": "a scope answer",
};

export function decideItem(f: ItemFacts): ItemPlan {
  const state = itemState(f);
  const c = f.classification;
  const live = f.inScope && !f.integration;
  const actions: Action[] = [];

  // classify-new: Jev for items without a verdict or whose classifier input changed (unless Haiku classified the item alone at this input);
  // Haiku for items Jev is unsure of that have no Haiku verdict as new as Jev's. runner/classify.ts dueItems, haikuDue.
  if (f.run && live) {
    const jevDue = !c.haiku?.aloneCurrent && (!c.jev || c.jev.changed);
    const haikuDue = !!c.jev && c.jev.unsure && (!c.haiku || c.haiku.at < c.jev.at);
    if (jevDue || haikuDue) actions.push(act("classify", null, { source: jevDue ? "jev" : "haiku" }));
  }
  // referee: classify/referee.ts refereeCandidates (open, not a draft, not held, in scope).
  if (f.run && live && !f.draft && state === "referee-due") actions.push(act("referee", null));
  // prioritize: priority/index.ts DUE_WHERE.
  if (live && f.priorityHash !== f.embedHash) actions.push(act("prioritize", null));
  // embed: embed/store.ts pending (every tracked item; no scope test).
  if (f.embeddedHash !== f.embedHash) actions.push(act("embed", null));
  // dupes: items to scan (dupes/scan.ts scanPending), pairs to check (check.ts uncheckedPairs), groups to ask (decide.ts groupsToAsk).
  const scan = live && f.embeddedHash === f.embedHash && f.scannedHash !== f.embedHash;
  if (scan || f.pairsToCheck > 0 || f.inGroupToAsk) actions.push(act("dupes", null, { scan, pairs: f.pairsToCheck, group: f.inGroupToAsk }));
  if (f.inCompareSet) actions.push(act("dupes-compare", null));
  // decide: a new scope decision (decide/select.ts selectCandidates), or Opus's recommendation for an open one (recommend.ts backfillIds).
  if (f.run && live && !f.draft && state === "scope-due") actions.push(act("decide", null, { source: "new" }));
  else if (live && !f.held && f.scope.recommend && f.scope.recommend.failures < RECOMMEND_MAX_FAILURES
    && (f.scope.recommend.failedAt === null || Date.parse(f.scope.recommend.failedAt) < f.now - RECOMMEND_RETRY_MS)) actions.push(act("decide", null, { source: "recommend" }));
  // label: labels/plan.ts planLabels and github.ts labelsToApply; the lane runs it for repos approved for labelling.
  if (f.run && live && f.held !== "backlog" && f.repoFacts.labelsApproved) {
    const settled = c.status === "settled" && c.label ? { type: c.label, security: c.flags.includes("security"), needsDecision: c.flags.includes("needs decision") } : null;
    const add = labelsToAdd(settled, f.labels.pluginAnswer, f.labels.existing);
    if (add && add.length && !alreadyLabeled(f.labels.labeledNote, add)) actions.push(act("label", null, { add }));
  }

  return { repo: f.repo, number: f.number, kind: f.kind, state, actions, wait: actions.length ? null : !f.inScope ? "not in scope" : WAITS[state] ?? null };
}

/** The Work page's next-step text (rank/next.ts nextStepOf), from the item's state and, for a PR, the facts of its review-to-merge path. */
export function nextStep(item: ItemPlan, f: ItemFacts, pr: PrFacts | null): string {
  switch (item.state) {
    case "held-duplicate": case "held-backlog": return "Held: waiting for a Duplicate? answer";
    case "models-disagree": return "Models disagree: needs a label";
    case "referee-due": return "Referee: waiting for Sonnet";
    case "unclassified": case "waiting-haiku": return "Classify";
    case "scope-open": return "Decide: waiting for a scope answer";
    default:
  }
  const c = f.classification;
  if (item.state === "scope-due" && c.status === "disagree") return "Decide";
  const needsDecision = c.flags.includes("needs decision");
  if (f.kind === "issue") {
    switch (f.fixAttempt) {
      case "retry": case "testing": return "Fix: in progress";
      case "passed": case "pr-opened": return "Fix: pull request opened";
      case "skipped": case "failed": return "Needs a person";
      default: return c.label === "bugfix" && !needsDecision ? "Fix" : needsDecision ? "Decide" : "Triage by a person";
    }
  }
  const r = pr?.review && pr.review.head === pr.head && !pr.review.stale ? pr.review.verdict : null;
  if (needsDecision && !r) return "Decide";
  switch (r) {
    case null: return "Review";
    case "take-fix": return "Fix-up";
    case "hold": return "Needs a person";
    case "close": return "Close";
    default: {
      const v = pr?.verification?.state ?? null;
      if (v === "unavailable") return "Merge? decision: not verified (Verify cannot build this repo)";
      if (pr?.ci === "none" && pr.repoFacts.noCi) return "Merge? decision: the repo has no CI";
      if (v === "passed" || v === "ci-enough") return "Merge queue";
      if (v === "failed" || v === "error") return "Needs a person: verification failed";
      return v ? "Verify: running" : "Verify";
    }
  }
}

/** Every plan of an item together. A PR's triage actions (classify, label, ...) and its review-to-merge actions can both be due: triage actions come first. */
export function decideAll(item: ItemFacts, pr: PrFacts | null = null): ItemView {
  const plan = decideItem(item);
  const prPlan = pr ? decidePr(pr) : null;
  return {
    repo: item.repo, number: item.number, kind: item.kind, head: pr?.head ?? null, item: plan, pr: prPlan,
    actions: [...plan.actions, ...(prPlan?.actions ?? [])], next: nextStep(plan, item, pr),
  };
}
