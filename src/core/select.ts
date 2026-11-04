// Executors take their work from Plans: the PRs whose Plan holds an action of their kind.
import type { DatabaseSync } from "node:sqlite";
import { decidePr } from "./decide.ts";
import { loadPrFacts } from "./facts.ts";
import type { Action, ActionKind, Plan, PrFacts } from "./plan.ts";

export type Planned = { facts: PrFacts; plan: Plan; action: Action };

export type PlannedOptions = {
  repo?: string;
  /** Only actions with this bucket parameter (verify: plan | unavailable; fix-up: fix | ask, ...). */
  bucket?: string;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The classification run for labels (default: the latest). */
  run?: string | null;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** Called with every PR decided, due or not (the autopilot reads wake times from them). */
  onPlan?: (facts: PrFacts, plan: Plan) => void;
};

/**
 * The PRs with an action of `kind` due, in selection order: fast-track or rank score descending (unranked last), then repo and number.
 * Facts are loaded once for all of them.
 */
export function planned(db: DatabaseSync, kind: ActionKind, opts: PlannedOptions = {}): Planned[] {
  const { bucket, onPlan, ...load } = opts;
  const out: Planned[] = [];
  for (const facts of loadPrFacts(db, load)) {
    const plan = decidePr(facts);
    onPlan?.(facts, plan);
    for (const action of plan.actions) {
      if (action.kind === kind && (bucket === undefined || action.params?.bucket === bucket)) out.push({ facts, plan, action });
    }
  }
  return out.sort((a, b) => (a.facts.score === null ? 1 : 0) - (b.facts.score === null ? 1 : 0) || (b.facts.score ?? 0) - (a.facts.score ?? 0)
    || (a.facts.repo < b.facts.repo ? -1 : a.facts.repo > b.facts.repo ? 1 : 0) || a.facts.number - b.facts.number);
}
