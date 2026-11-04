// The gates on writes: the repo approvals each action needs and the global pipeline switch. Pure. The planner and the
// guard (guard.ts) both use it; decide() does not (it shows what would run, approved or not).
import type { ActionKind, PrFacts } from "./plan.ts";

/** Who asks for a write: the pipeline itself (the autopilot), or an operator (a job they requested, or a command they ran). */
export type By = "pipeline" | { operator: string };

/** An action as the gates and the guard see it: its kind, and the bucket where the kind has several (fix-up: fix | ask, ...). */
export type Want = { kind: ActionKind; bucket?: string };

type Approval = "merge" | "push" | "comment" | "ci";

const WHAT: Record<Approval, string> = { merge: "merging", push: "pushing", comment: "commenting", ci: "approving CI runs" };

/** The approval an action's GitHub write needs, or null for an action that writes nothing there. */
export function approvalOf(f: Pick<PrFacts, "pushable">, a: Want): Approval | null {
  switch (a.kind) {
    case "merge": return "merge";
    case "post-review": return "comment";
    case "approve-ci": return "ci";
    case "fixup":
    case "conflict":
      return a.bucket === "fix" || a.bucket === "merge" ? "push" : a.bucket === "ask" ? "comment" : null;
    case "cifix":
      if (a.bucket === "rerun") return "ci";
      // A closed branch gets the patch as a comment instead of a push.
      return a.bucket === "work" || a.bucket === "collect" ? (f.pushable ? "push" : "comment") : null;
    default: return null;
  }
}

/** Why the write is refused, or null. */
export function gates(f: PrFacts, a: Want, by: By): string | null {
  if (by === "pipeline" && !f.pipelineOn) return "the pipeline is off";
  const need = approvalOf(f, a);
  if (!need) return null;
  const ok = { merge: f.repoFacts.mergeApproved, push: f.repoFacts.pushApproved, comment: f.repoFacts.commentApproved, ci: f.repoFacts.ciApproved }[need];
  return ok ? null : `${WHAT[need]} in ${f.repo} is not approved`;
}

/** Writes from the command line are an operator's. */
export const CLI_BY: By = { operator: "cli" };

/** The writer behind a job: the autopilot's own jobs are the pipeline's, every other requester is an operator. */
export const byOfJob = (requestedBy: string): By => (requestedBy === "pipeline" ? "pipeline" : { operator: requestedBy });
