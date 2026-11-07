// One status line per item: the phase, what it waits for and what happens next. Computed by the planner from the plan state and
// stored in the plan view, so every page draws the same line. No imports from outside src/core: the web build may use it.
import type { ItemState, PlanState } from "./plan.ts";

export type ItemPhase = "Triage" | "Waiting for a person" | "Review" | "Fixing" | "Verifying" | "In queue" | "Merged" | "Closed" | "Held" | "Out of scope";

export interface ItemStatus {
  phase: ItemPhase;
  /** What it waits for, in words; null when it does not wait. */
  waiting: string | null;
  /** What happens when the wait ends. */
  next: string | null;
  /** When the item entered this state. */
  since: string;
}

/** Phase of every PR plan state. A new plan state fails tsc here. */
const PR_PHASE = {
  ready: "In queue", "decision-answered-merge": "In queue", refused: "In queue", "waiting-ci": "In queue", "waiting-premerge": "In queue",
  "batch-checking": "In queue", "in-batch": "In queue", "ci-approval": "In queue", "waiting-main-ci": "In queue", integration: "In queue",
  "ci-failed": "Fixing", conflict: "Fixing", "needs-fix-up": "Fixing", "verify-failed": "Fixing", "batch-failed": "Fixing", pushed: "Fixing",
  "waiting-verify": "Verifying", "verify-error": "Verifying",
  "needs-decision": "Waiting for a person", "changes-requested": "Waiting for a person", scope: "Waiting for a person", "opus-hold": "Waiting for a person",
  declined: "Held", "held-duplicate": "Held", "held-backlog": "Held", backlog: "Held", duplicate: "Held", draft: "Held", "label-not-reviewed": "Held",
  "out-of-scope": "Out of scope", "opus-close": "Out of scope",
  "not-reviewed": "Review", "review-stale": "Review",
  merged: "Merged", closed: "Closed",
} as const satisfies Record<PlanState, ItemPhase>;

/** Phase of every triage state, used when the item has no PR plan. */
const ITEM_PHASE = {
  "held-duplicate": "Held", "held-backlog": "Held", "scope-open": "Waiting for a person",
  "referee-due": "Triage", unclassified: "Triage", "waiting-haiku": "Triage", "scope-due": "Triage", classified: "Triage",
} as const satisfies Record<ItemState, ItemPhase>;

/** Triage states that hold or park the item whatever its PR plan says. */
const TRIAGE_OVERRIDES: readonly ItemState[] = ["held-duplicate", "held-backlog", "scope-open"];

export type StatusInput = {
  /** GitHub state; wins over every plan state. */
  gh?: "OPEN" | "MERGED" | "CLOSED" | null;
  /** The PR's plan state, when the item is a PR with a plan. */
  state: PlanState | null;
  /** The item's triage state. */
  itemState: ItemState | null;
  wait: string | null;
  /** The Work page's next-step text. */
  next: string | null;
  /** A due review is held because another item blocks the PR (reviewHold kind "blocked"). */
  reviewBlocked?: boolean;
};

export function phaseOf(i: StatusInput): ItemPhase {
  if (i.gh === "MERGED" || i.state === "merged") return "Merged";
  if (i.gh === "CLOSED" || i.state === "closed") return "Closed";
  if (i.itemState && TRIAGE_OVERRIDES.includes(i.itemState)) return ITEM_PHASE[i.itemState];
  if (i.wait && /answer/i.test(i.wait)) return "Waiting for a person";
  if (i.state) return i.reviewBlocked && PR_PHASE[i.state] === "Review" ? "Held" : PR_PHASE[i.state];
  if (i.next?.startsWith("Fix:")) return "Fixing";
  return i.itemState ? ITEM_PHASE[i.itemState] : "Triage";
}

/** The status without its `since`. */
export function statusOf(i: StatusInput): Omit<ItemStatus, "since"> {
  return { phase: phaseOf(i), waiting: i.wait, next: i.next };
}

/** The status of an item with no plan row. */
export function statusFromItem(item: { merged_at?: string | null; closed_at?: string | null }, since: string): ItemStatus {
  const phase: ItemPhase = item.merged_at ? "Merged" : item.closed_at ? "Closed" : "Triage";
  return { phase, waiting: null, next: null, since };
}
