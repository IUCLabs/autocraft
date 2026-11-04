// The PRs the CI fix step works on: those whose Plan holds a `cifix` action.
import type { DatabaseSync } from "node:sqlite";
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { CifixCandidate, CifixSelection } from "./candidates.ts";

export function selectCifix(db: DatabaseSync, repo: string, run?: string | null, plans?: PlanSet): CifixSelection {
  const out: CifixSelection = { work: [], collect: [], rerun: [], capped: [] };
  for (const { facts: f, action } of planned(db, "cifix", { repo, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) })) {
    const x = f.cifix!, r = f.review!;
    const c: CifixCandidate = {
      repo, number: f.number, head: action.head!, verdict: r.verdict as "take" | "take-fix", reason: r.reason, attempt: x.tries + 1,
      route: f.pushable ? "branch" : "comment", rerun: x.rerunAt !== null, rerunAt: x.rerunAt,
    };
    const bucket = action.params?.bucket;
    if (bucket === "work") out.work.push(c);
    else if (bucket === "capped") out.capped.push(c);
    else if (bucket === "rerun") out.rerun.push({ c, runs: x.infraRuns ?? [] });
    else if (bucket === "collect") out.collect.push({ c, task: x.formattingTask! });
  }
  return out;
}
