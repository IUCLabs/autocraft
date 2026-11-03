// Queue position: the place of an open item among the items whose next step is the same queued stage,
// in work-rank order with fast-tracked items first (src/fasttrack.ts). Items whose next step is not a queued
// stage (a person's answer, a running job, held, done) have none. The place is current, not an estimate.
import type { DatabaseSync } from "node:sqlite";
import type { QueueSlot } from "../../web/src/api/types.ts";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { workScores } from "../fasttrack.ts";
import { pipelineRepos } from "../pilot.ts";
import { factsOf, nextStepOf } from "./next.ts";

/** Next step text → queued stage and the Queue tab that lists it. Steps not listed here are not queued. */
const QUEUED: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  "Opus review": { stage: "Opus review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

type Entry = { repo: string; number: number; score: number } & Pick<QueueSlot, "stage" | "tab">;

/** Ordered candidates per stage for the given items, best first. */
export function orderStages(items: { repo: string; number: number; score: number; next: string }[]): Map<string, Entry[]> {
  const by = new Map<string, Entry[]>();
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

const cache = new WeakMap<DatabaseSync, { sig: string; stages: Map<string, Entry[]> }>();
const SEQ_TOPICS = ["items", "ranks", "classify", "decisions", "reviews", "verify", "fixes", "checks", "fasttrack", "queue", "repos", "settings"];

type NextOf = (db: DatabaseSync, r: { repo: string; number: number; kind: string; head_oid: string | null }) => string;

/** Orders every open ranked item of the pipeline repos (and fast-tracked ones) by stage. `nextOf` is injectable for tests. */
export function computeStages(db: DatabaseSync, nextOf?: NextOf): Map<string, Entry[]> {
  const on = pipelineRepos(db);
  const fast = new Set((db.prepare("SELECT repo, number FROM main.fast_track").all() as { repo: string; number: number }[]).map((f) => `${f.repo}#${f.number}`));
  const held = new Set((db.prepare("SELECT repo, number FROM main.merge_holds").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
  const rows = db.prepare(`SELECT i.repo, i.number, i.kind, i.head_oid FROM items i JOIN item_rank r ON r.repo = i.repo AND r.number = i.number WHERE i.state = 'OPEN'`)
    .all() as { repo: string; number: number; kind: string; head_oid: string | null }[];
  const settled = settledLookup(db, latestRun(db));
  const next = nextOf ?? ((d, r) => nextStepOf(factsOf(d, r.repo, r.number, r.kind, r.head_oid, settled(r.repo, r.number))));
  const scores = new Map<string, Map<number, number>>();
  const out: { repo: string; number: number; score: number; next: string }[] = [];
  for (const r of rows) {
    const key = `${r.repo}#${r.number}`;
    // A fast-tracked item runs whatever its repo's pipeline switch says.
    if (!on.has(r.repo) && !fast.has(key)) continue;
    const step = next(db, r);
    if (!QUEUED[step] || (step === "Merge queue" && held.has(key))) continue;
    let s = scores.get(r.repo);
    if (!s) scores.set(r.repo, (s = workScores(db, r.repo)));
    out.push({ repo: r.repo, number: r.number, score: s.get(r.number) ?? 0, next: step });
  }
  return orderStages(out);
}

function stages(db: DatabaseSync): Map<string, Entry[]> {
  const seqs = db.prepare(`SELECT topic, seq FROM change_seq WHERE topic IN (${SEQ_TOPICS.map(() => "?").join(",")}) ORDER BY topic`).all(...SEQ_TOPICS) as { topic: string; seq: number }[];
  const sig = seqs.map((s) => `${s.topic}${s.seq}`).join(",");
  const hit = cache.get(db);
  if (hit && sig && hit.sig === sig) return hit.stages;
  const fresh = computeStages(db);
  cache.set(db, { sig, stages: fresh });
  return fresh;
}

/**
 * `repo#number` → slot, for the items in `visible` repos; places count only visible items. One pass for all items:
 * call it once per request, not per item.
 */
export function queueSlots(db: DatabaseSync, visible: Iterable<string>, byStage: Map<string, Entry[]> = stages(db)): Map<string, QueueSlot> {
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
