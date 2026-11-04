// The one assignment rule: AutoCraft's account is assigned to an item while AutoCraft works it through to merge, and takes the
// assignment back when the item waits on a person or the stage gave up, so someone else may pick it up. Pure.
import type { Action, AssignFacts } from "./plan.ts";

/** Plan states that wait on a person: work of ours in them is no longer in flight. */
export const WAITS_ON_PERSON: ReadonlySet<string> = new Set(["needs-decision", "declined", "changes-requested", "held-duplicate", "held-backlog", "backlog", "duplicate", "opus-hold"]);

/** AutoCraft's own work on the item that is still moving: not closed, not held, not waiting on a person's answer. */
export const inFlightNow = (f: { inFlight?: boolean; mergeHeld?: boolean }, state: string): boolean => !!f.inFlight && !f.mergeHeld && !WAITS_ON_PERSON.has(state);

/** True for an action that is neither assign nor unassign: those are bookkeeping, not work due, and leave a plan's wait text and "has work" tests as they are. */
export const isWork = (a: Action): boolean => a.kind !== "assign" && a.kind !== "unassign";

/** The assign or unassign action for an open item, or none. Assigns only when nobody is: not over another person, not again after we took it back or someone removed us. Unassigns only our own assignment while we are the sole assignee. */
export function assignmentActions(a: AssignFacts, open: boolean, verdict: "work" | "release" | null): Action[] {
  if (!open) return [];
  if (verdict === "work" && !a.assignees.length && !a.ours) return [{ kind: "assign", head: null }];
  if (verdict === "release" && a.ours && a.login !== null && a.assignees.length === 1 && a.assignees[0] === a.login) return [{ kind: "unassign", head: null }];
  return [];
}
