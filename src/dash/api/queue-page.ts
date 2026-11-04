// The Queue page: tabs All, Review, Fix, Verify and Merge over one repo filter, with fast-tracked items first, plus
// the operator's fast-track, hold and batch controls. Reads are for anyone signed in, limited to the repos the
// requester may see; every write is for operators (the route says so) and audited.
import type { DatabaseSync } from "node:sqlite";
import type { FastPosition, MergeWait, NextMerge, QueueMergeRow, QueuePage, QueueRepos, QueueTab, QueueWorkRow, TypeLabel } from "../../../web/src/api/types.ts";
import { latestRun, settledLookup } from "../../classify/settled.ts";
import { addFastTrack, fastPositions, fastTrackList, FastTrackError, parseItemRef, removeFastTrack } from "../../fasttrack.ts";
import type { Exec } from "../../fixup/git.ts";
import { ControlError, holdMerge, releaseMerge, removeFromBatch, stopBatch } from "../../merge/controls.ts";
import { pageBatches } from "../../merge/batch-store.ts";
import { buildQueue, type QueueEntry } from "../../merge/queue.ts";
import { pipelineRepos } from "../../pilot.ts";
import { mergeOrder, queueSlots, scopedKeys, scoreLookup, type Candidate } from "../../rank/position.ts";
import { classifyListOf, factsOf, memoNoCi, nextStepOf, type NextFacts } from "../../rank/next.ts";
import type { RankBreakdown } from "../../rank/score.ts";
import { trackedNames } from "../../repos.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { toBatch, toRow } from "./queue.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import { stageById } from "../../stages/registry.ts";

export const TABS: QueueTab[] = ["all", "review", "fix", "verify", "merge"];
const NEXT_LIMIT = 10;

/** The tab a work row belongs to besides All, from its next step. */
export function tabOfNext(next: string): QueueTab | null {
  if (next === stageById("review").title) return "review";
  if (next.startsWith("Fix")) return "fix";
  if (next.startsWith("Verify")) return "verify";
  return null;
}

const WAITS: Record<string, [MergeWait, string, number]> = {
  ready: ["ready", "Ready", 0],
  "decision-answered-merge": ["ready", "Merge approved", 0],
  refused: ["refused", "Refused; tried again when GitHub reports something new", 1],
  "in-batch": ["batch-ci", "In a batch; waiting for the batch PR's CI", 1],
  "batch-checking": ["batch-check", "In a batch; checked in the sandbox", 1],
  "waiting-ci": ["ci", "Waiting for CI", 2],
  "waiting-main-ci": ["ci", "Waiting: main CI red", 2],
  "ci-approval": ["ci", "Waiting for CI run approval", 2],
  "waiting-verify": ["verify", "Waiting for Verify", 2],
  "waiting-premerge": ["premerge", "Waiting for the pre-merge review", 2],
};
const HELD: [MergeWait, string, number] = ["held", "Merge held by an operator", 9];

/** What merges next and what each PR waits for, from the queue states (src/merge/queue.ts). Fast-tracked first, held last. */
export function nextMerges(entries: QueueEntry[], fast: Map<string, FastPosition>, batchOf: Map<string, { id: number; branch: string }>, scores: Map<string, number>): NextMerge[] {
  const items = entries.flatMap((e) => {
    const w = e.held && e.state in WAITS ? HELD : e.state === "ci-approval" && e.runsBlocked ? WAITS[e.state]!.map((x, k) => (k === 1 ? "CI runs need a person to approve" : x)) as [MergeWait, string, number] : WAITS[e.state];
    return w ? [{ e, w }] : [];
  });
  items.sort((a, b) => {
    const fa = fast.get(`${a.e.repo}#${a.e.number}`)?.position ?? Infinity, fb = fast.get(`${b.e.repo}#${b.e.number}`)?.position ?? Infinity;
    return (a.w[2] === 9 ? 1 : 0) - (b.w[2] === 9 ? 1 : 0) || fa - fb || a.w[2] - b.w[2]
      || (scores.get(`${b.e.repo}#${b.e.number}`) ?? -1) - (scores.get(`${a.e.repo}#${a.e.number}`) ?? -1) || a.e.repo.localeCompare(b.e.repo) || a.e.number - b.e.number;
  });
  return items.slice(0, NEXT_LIMIT).map(({ e, w }) => ({
    repo: e.repo, number: e.number, title: e.title, waitsFor: w[0], label: w[1], fast: fast.get(`${e.repo}#${e.number}`) ?? null, batch: batchOf.get(`${e.repo}#${e.number}`) ?? null,
  }));
}

export async function queuePage(db: DatabaseSync, req: Req): Promise<QueuePage> {
  const tab = (req.query.get("tab") || "all") as QueueTab;
  if (!TABS.includes(tab)) throw new HttpError(400, `tab must be one of ${TABS.join(", ")}`);
  const reposParam = (req.query.get("repos") || "pipeline") as QueueRepos;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const visible = await visibleRepos(db, req);
  const visibleSet = new Set(visible);
  if (reposParam !== "pipeline" && reposParam !== "all" && !visibleSet.has(reposParam)) throw new HttpError(404, `${reposParam} is not a tracked repo`);
  const scoped = reposParam === "pipeline" ? scopedKeys(db) : null;
  const fast = new Map([...fastPositions(db)].filter(([k]) => visibleSet.has(k.slice(0, k.lastIndexOf("#")))));
  // The default view is the pipeline's scope (src/rank/position.ts), the same one the position badges count.
  const inScope = (repo: string, number: number): boolean =>
    reposParam === "all" ? visibleSet.has(repo) : reposParam === "pipeline" ? visibleSet.has(repo) && scoped!.has(`${repo}#${number}`) : repo === reposParam;
  const fastOf = (repo: string, number: number): FastPosition | null => fast.get(`${repo}#${number}`) ?? null;
  const held = new Set((db.prepare("SELECT repo, number FROM main.merge_holds").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));

  // A linked item (`item=repo:number`) comes with the first page: it is cut long enough to include the item.
  const item = req.query.get("item");
  const indexOf = (list: { repo: string; number: number }[]): number | null => {
    const at = item ? list.findIndex((r) => `${r.repo}:${r.number}` === item) : -1;
    return at < 0 ? null : at;
  };
  const sizeFor = (list: { repo: string; number: number }[], from: number): number => {
    const at = from === 0 ? indexOf(list) : null;
    return at === null ? limit : Math.min(500, Math.max(limit, Math.ceil((at + 1) / 100) * 100));
  };

  // Work rows (All, Review, Fix, Verify)
  const run = latestRun(db);
  const settled = settledLookup(db, run);
  // Each item's next step is worked out once for the rows and the position badges.
  const noCi = memoNoCi(db);
  const steps = new Map<string, { facts: NextFacts; next: string }>();
  const stepOf = (r: Candidate) => {
    const k = `${r.repo}#${r.number}`;
    let v = steps.get(k);
    if (!v) { const facts = factsOf(db, r.repo, r.number, r.kind, r.head_oid, settled(r.repo, r.number), noCi); steps.set(k, (v = { facts, next: nextStepOf(facts) })); }
    return v;
  };
  const allEntries = buildQueue(db, { merged: "exclude", run });
  const slots = queueSlots(db, visible, { nextOf: (r) => stepOf(r).next, entries: allEntries });
  const score = scoreLookup(db);
  type Row = { repo: string; number: number; kind: string; title: string | null; head_oid: string | null; score: number; breakdown: string };
  const ranked = db.prepare(`SELECT i.repo, i.number, i.kind, i.title, i.head_oid, r.score, r.breakdown FROM items i JOIN item_rank r ON r.repo = i.repo AND r.number = i.number
    WHERE i.state = 'OPEN' ORDER BY r.score DESC, i.repo, i.number`).all() as Row[];
  // Fast-tracked items (and the Fix PRs of fast-tracked issues) first, then the work rank.
  const inView = ranked.filter((r) => visibleSet.has(r.repo) && inScope(r.repo, r.number)).map((r) => ({ r, s: score(r.repo, r.number) ?? r.score }));
  inView.sort((a, b) => b.s - a.s);
  const work: QueueWorkRow[] = inView.map(({ r }) => {
    const s = settled(r.repo, r.number), bd = JSON.parse(r.breakdown) as RankBreakdown;
    const { facts, next } = stepOf(r);
    return {
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, level: bd.level, size: bd.size, breakdown: bd,
      label: s.label as TypeLabel | null, next, nextHref: facts.disagree && !facts.held ? classifyListOf(r.repo) : null,
      queue: slots.get(`${r.repo}#${r.number}`) ?? null, fast: fastOf(r.repo, r.number), held: held.has(`${r.repo}#${r.number}`),
    };
  });

  // Merge queue rows
  const hidden = trackedNames(db).filter((r) => !visibleSet.has(r));
  const hiddenSet = new Set(hidden);
  const entries = allEntries.filter((e) => e.state !== "merged" && !hiddenSet.has(e.repo) && inScope(e.repo, e.number));
  const asRow = (e: QueueEntry): QueueMergeRow => ({ ...toRow(e), fast: fastOf(e.repo, e.number), held: e.held });
  const count = (t: QueueTab): number => (t === "all" ? work.length : t === "merge" ? entries.length : work.filter((w) => tabOfNext(w.next) === t).length);
  const counts = { all: count("all"), review: count("review"), fix: count("fix"), verify: count("verify"), merge: count("merge") };

  const out: QueuePage = { tab, repos: reposParam, counts, rows: [], mergeRows: [], nextMerges: [], batches: [], total: 0, next: null };
  if (tab !== "merge") {
    const match = tab === "all" ? work : work.filter((w) => tabOfNext(w.next) === tab);
    out.itemIndex = indexOf(match);
    out.rows = match.slice(offset, offset + sizeFor(match, offset));
    out.total = match.length;
    out.next = offset + out.rows.length < match.length ? offset + out.rows.length : null;
    return out;
  }
  const { batches } = pageBatches(db, { exclude: hidden, limit: 100 });
  const active = batches.filter((b) => (b.state === "checking" || b.state === "open") && b.prs.some((p) => inScope(b.repo, p.number)));
  const rowOf = new Map(entries.map((e) => [`${e.repo}#${e.number}`, asRow(e)]));
  const batchOf = new Map(active.flatMap((b) => b.prs.map((p) => [`${b.repo}#${p.number}`, { id: b.id, branch: b.branch }] as const)));
  const scores = new Map((db.prepare("SELECT repo, number, score FROM item_rank").all() as { repo: string; number: number; score: number }[]).map((r) => [`${r.repo}#${r.number}`, r.score]));
  const free = mergeOrder(db, entries).map(asRow);
  out.itemIndex = indexOf(free);
  out.mergeRows = free.slice(offset, offset + sizeFor(free, offset));
  out.total = free.length;
  out.next = offset + out.mergeRows.length < free.length ? offset + out.mergeRows.length : null;
  out.nextMerges = nextMerges(entries, fast, batchOf, scores);
  out.batches = active.map((b) => toBatch(b, b.prs.flatMap((p) => rowOf.get(`${b.repo}#${p.number}`) ?? [])));
  return out;
}

// ---- repo list, fast track and merge controls --------------------------------

/** Visible repos whose pipeline is on. */
export async function pipelineRepoNames(db: DatabaseSync, req: Req): Promise<string[]> {
  const on = pipelineRepos(db);
  return (await visibleRepos(db, req)).filter((r) => on.has(r));
}

/** Open fast-tracked items as `repo#number`, first to run first. */
export async function fastTrackRefs(db: DatabaseSync, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  return fastTrackList(db).filter((f) => visible.has(f.repo)).map((f) => `${f.repo}#${f.number}`);
}

/** PRs whose merge an operator holds, as `repo#number`, in visible repos. */
export async function heldMergeRefs(db: DatabaseSync, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  const rows = db.prepare("SELECT repo, number FROM main.merge_holds ORDER BY repo, number").all() as { repo: string; number: number }[];
  return rows.filter((r) => visible.has(r.repo)).map((r) => `${r.repo}#${r.number}`);
}

function item(req: Req): { repo: string; number: number } {
  const b = req.json;
  const text = b && typeof b === "object" && !Array.isArray(b) ? (b as { item?: unknown }).item : undefined;
  try {
    return parseItemRef(text);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Runs a library call, turning its errors into HTTP ones. */
async function guarded<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof FastTrackError || e instanceof ControlError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export async function fastTrackAdd(db: DatabaseSync, req: Req): Promise<string[]> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await guarded(() => addFastTrack(db, req.user.login, `${r.repo}#${r.number}`));
  return fastTrackRefs(db, req);
}

export async function fastTrackRemove(db: DatabaseSync, req: Req): Promise<string[]> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await guarded(() => removeFastTrack(db, req.user.login, `${r.repo}#${r.number}`));
  return fastTrackRefs(db, req);
}

export async function mergeHoldPr(db: DatabaseSync, req: Req, on: boolean): Promise<{ ok: true }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  const changed = await guarded(() => (on ? holdMerge(db, req.user.login, r.repo, r.number) : releaseMerge(db, req.user.login, r.repo, r.number)));
  if (!changed) throw new HttpError(409, `${r.repo}#${r.number} is ${on ? "already" : "not"} held`);
  return { ok: true };
}

export async function batchRemovePr(db: DatabaseSync, req: Req, run?: Exec): Promise<{ batch: string; closed: number | null }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  return guarded(() => removeFromBatch(db, req.user.login, r.repo, r.number, run));
}

export async function batchStop(db: DatabaseSync, req: Req, run?: Exec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? (db.prepare("SELECT repo FROM main.merge_batches WHERE id = ?").get(id) as { repo: string } | undefined)?.repo : undefined;
  if (!repo) throw new HttpError(404, `no batch ${req.params.id}`);
  await needVisible(db, req, repo);
  return guarded(() => stopBatch(db, req.user.login, id, run));
}
