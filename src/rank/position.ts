// Queue position: the place of an open item among the items whose next step is the same queued stage.
// Items are those in the pipeline's scope (repo switch on or fast-tracked, the pilot, not our own integration PRs),
// ordered by the work rank with fast-tracked items first (src/fasttrack.ts); the Merge stage follows the Merge tab's order.
// Items whose next step is not a queued stage (a person's answer, a running job, held, done) have none.
// The place is current, not an estimate.
import type { DatabaseSync } from "node:sqlite";
import type { QueueSlot } from "../../web/src/api/types.ts";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { workScores } from "../fasttrack.ts";
import { buildQueue, type QueueEntry } from "../merge/queue.ts";
import { pilotSql } from "../pilot.ts";
import { factsOf, memoNoCi, nextStepOf } from "./next.ts";

/** Next step text → queued stage and the Queue tab that lists it. Steps not listed here are not queued. */
const QUEUED: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

const BATCHED = new Set(["batch-checking", "in-batch"]);

type Entry = { repo: string; number: number; score: number } & Pick<QueueSlot, "stage" | "tab">;
export type Candidate = { repo: string; number: number; kind: string; head_oid: string | null };
export type NextOf = (c: Candidate) => string;
export type Stages = Map<string, Entry[]>;

/** Open items in the pipeline's scope as `repo#number`: the SQL the candidate queries use. */
export function scopedKeys(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT i.repo, i.number FROM items i WHERE i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")}`).all() as { repo: string; number: number }[];
  return new Set(rows.map((r) => `${r.repo}#${r.number}`));
}

/** Work score of an item with fast-tracked ones raised, one lookup per repo. */
export function scoreLookup(db: DatabaseSync): (repo: string, number: number) => number | undefined {
  const by = new Map<string, Map<number, number>>();
  return (repo, number) => {
    let m = by.get(repo);
    if (!m) by.set(repo, (m = workScores(db, repo)));
    return m.get(number);
  };
}

/** The Merge tab's order, the same as every other stage's: fast-tracked first, then the work rank, then repo and number. Batched PRs are listed under their batch, not here. */
export function mergeOrder<T extends { repo: string; number: number; state?: string }>(db: DatabaseSync, entries: T[]): T[] {
  const score = scoreLookup(db);
  const s = (e: T): number => score(e.repo, e.number) ?? 0;
  return entries.filter((e) => !BATCHED.has(e.state ?? "")).sort((a, b) => s(b) - s(a) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

/** Orders items by stage: best first by score. */
export function orderStages(items: { repo: string; number: number; score: number; next: string }[]): Stages {
  const by: Stages = new Map();
  for (const i of items) {
    const q = QUEUED[i.next];
    if (!q) continue;
    const list = by.get(q.stage) ?? [];
    list.push({ repo: i.repo, number: i.number, score: i.score, ...q });
    by.set(q.stage, list);
  }
  for (const list of by.values()) list.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.number - b.number);
  return by;
}

export type StageInputs = {
  /** The next step of an item; default reads the stored tables. */
  nextOf?: NextOf;
  /** The merge queue's entries (src/merge/queue.ts), all repos; default builds them. */
  entries?: QueueEntry[];
};

/** Orders the pipeline's open ranked items by stage. */
export function computeStages(db: DatabaseSync, inputs: StageInputs = {}): Stages {
  const held = new Set((db.prepare("SELECT repo, number FROM main.merge_holds").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
  const rows = db.prepare(`SELECT i.repo, i.number, i.kind, i.head_oid FROM items i JOIN item_rank r ON r.repo = i.repo AND r.number = i.number
    WHERE i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")}`).all() as Candidate[];
  const settled = settledLookup(db, latestRun(db));
  const noCi = memoNoCi(db);
  const next: NextOf = inputs.nextOf ?? ((r) => nextStepOf(factsOf(db, r.repo, r.number, r.kind, r.head_oid, settled(r.repo, r.number), noCi)));
  const score = scoreLookup(db);
  const out: { repo: string; number: number; score: number; next: string }[] = [];
  const merge: typeof out = [];
  for (const r of rows) {
    const step = next(r);
    if (!QUEUED[step] || (step === "Merge queue" && held.has(`${r.repo}#${r.number}`))) continue;
    (step === "Merge queue" ? merge : out).push({ repo: r.repo, number: r.number, score: score(r.repo, r.number) ?? 0, next: step });
  }
  if (merge.length) {
    // Batched PRs are listed under their batch on the Merge tab, not in its place order.
    const batched = new Set((inputs.entries ?? buildQueue(db, { merged: "exclude" })).filter((e) => BATCHED.has(e.state)).map((e) => `${e.repo}#${e.number}`));
    for (const m of merge) if (!batched.has(`${m.repo}#${m.number}`)) out.push(m);
  }
  return orderStages(out);
}

const cache = new WeakMap<DatabaseSync, { sig: string; stages: Stages }>();

// No time floor: the `steps` topic moves only for writes that change a next step, and a floor without a trailing
// recompute would leave a badge stale until some later event. A caller that passes its own next steps (the Queue
// page) always recomputes, so its rows and badges agree.
function stages(db: DatabaseSync, inputs?: StageInputs): Stages {
  const sig = JSON.stringify(db.prepare("SELECT seq FROM change_seq WHERE topic = 'steps'").get() ?? null);
  const hit = cache.get(db);
  if (hit && hit.sig === sig && !inputs?.nextOf) return hit.stages;
  const fresh = computeStages(db, inputs);
  cache.set(db, { sig, stages: fresh });
  return fresh;
}

/** Slots of `repo#number` for the items in `visible` repos; places count only visible items. Pure over the ordered stages. */
export function slotsOf(byStage: Stages, visible: Iterable<string>): Map<string, QueueSlot> {
  const seen = new Set(visible);
  const out = new Map<string, QueueSlot>();
  for (const list of byStage.values()) {
    let place = 0;
    for (const e of list) {
      if (!seen.has(e.repo)) continue;
      out.set(`${e.repo}#${e.number}`, { stage: e.stage, tab: e.tab, place: ++place });
    }
  }
  return out;
}

/** One pass for all items: call it once per request, not per item. `inputs` lets a caller that already visited the items share its work. */
export const queueSlots = (db: DatabaseSync, visible: Iterable<string>, inputs?: StageInputs): Map<string, QueueSlot> => slotsOf(stages(db, inputs), visible);
