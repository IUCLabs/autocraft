// A complete default PrFacts for decision tests: an open take PR on the rule path with everything green (state ready, due: merge).
import type { PrFacts } from "../src/core/plan.ts";

export const NOW = Date.parse("2026-11-04T12:00:00Z");
export const HEAD = "h1";
export const REVIEW_AT = "2026-11-04T10:00:00.000Z";

type Override = { [K in keyof PrFacts]?: PrFacts[K] extends object | null ? Partial<NonNullable<PrFacts[K]>> | null : PrFacts[K] };

const base = (): PrFacts => ({
  repo: "app", number: 1, now: NOW, ghState: "OPEN", head: HEAD, draft: false,
  author: "dev", authorIsPipeline: false, tier: "whitelisted", lines: 20, size: "S", label: "bugfix", needsDecisionFlag: false, scopeAnswer: null,
  inScope: true, integration: false, batchPr: false, heldBacklog: false, heldDuplicate: false, mergeHeld: false, fast: false, score: 100,
  repoFacts: { mergeApproved: true, pushApproved: true, commentApproved: true, ciApproved: true, noCi: false, mainRed: false },
  review: { head: HEAD, at: REVIEW_AT, verdict: "take", unsure: false, mode: "full", reason: "ok", fixes: 0, stale: false, staleActionable: false },
  post: { postable: true, posted: { head: HEAD, at: "2026-11-04T10:01:00.000Z", opusAt: REVIEW_AT } },
  checksHere: true, checksOpen: true, ci: "success", mergeable: "MERGEABLE", runs: null,
  lastMerge: null, runsApprovedAfterMerge: false,
  verification: { state: "passed", kind: "build", summary: null, note: null }, verifyUnavailable: null,
  decision: { asked: false, openQuestion: false, answer: null, mergeAnswerAfterReview: false, inOpenGroup: false },
  premerge: { at: "2026-11-04T10:30:00.000Z", tries: 0, hasFindings: true, defects: 0, defectsAllFixable: true, minor: 0, error: null },
  premergeFixUsed: false, pushable: true, pushChain: [HEAD], conflict: null, batch: null, mainFix: false, changesRequested: null, gateFailureNote: null,
});

/** The default facts with the given fields replaced. Object fields (review, repoFacts, decision, ...) are merged one level deep; null replaces the whole object. */
export function prFacts(over: Override = {}): PrFacts {
  const f = base() as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = f[k];
    f[k] = v !== null && typeof v === "object" && !Array.isArray(v) && cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...cur, ...v } : v;
  }
  return f as PrFacts;
}
