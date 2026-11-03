// The classify steps: Jev on every item that needs a verdict, then Haiku on the
// items Jev is under 90 % sure of. When Jev is unavailable (src/agents/jev.ts),
// Haiku classifies the due items itself and its verdict settles them. Uses the
// classifiers in src/classify/run.ts.
//
// "Changed" means the classifier's input changed: input_hash is a hash of the
// classification scheme (labels and rules) and the item as the classifier sees
// it (title, body, size). A new scheme or an edited title or body makes the item
// due again; a new comment or label does not. Verdicts from before input_hash
// existed count as changed when the item was updated after the verdict.
import type { DatabaseSync } from "node:sqlite";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { JEV_FLAG_NO, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES, refOf, type Item } from "../classify/parse.ts";
import { freeSlots } from "../agents/accounts.ts";
import { jevAvailable } from "../agents/jev.ts";
import { runHaiku, runJev } from "../classify/run.ts";
import { fillClassHashes, SCHEME_ID } from "../itemhash.ts";
import type { StepContext } from "./steps.ts";
import { newestVerdictRun } from "../classify/settled.ts";
import { pilotSql } from "../pilot.ts";
import { assignAreas, type AssignResult } from "../areas/assign.ts";

export { inputHash } from "../itemhash.ts";

// Jev's top probability from which its label stands without a second opinion.
export const SURE = 0.9;
const JEV_CHUNK = 40, HAIKU_PER_CALL = 25;


/** The run new verdicts go into: the last completed pass, else the run with the newest Jev verdict. */
export function currentRun(db: DatabaseSync): string | null {
  const set = db.prepare("SELECT value FROM settings WHERE key = 'classify_run'").get() as { value: string } | undefined;
  if (set?.value) return set.value;
  return newestVerdictRun(db);
}

type Row = Item & { updated_at: string | null; c_at: string | null; c_hash: string | null };

const ITEM_COLUMNS = `i.repo, i.number, i.kind, COALESCE(i.title, '') AS title, COALESCE(i.body, '') AS body,
  i.additions + i.deletions AS lines_changed, i.changed_files AS files_changed, i.author_association`;

const strip = (r: Row): Item => ({ repo: r.repo, number: r.number, kind: r.kind, title: r.title, body: r.body, lines_changed: r.lines_changed, files_changed: r.files_changed, author_association: r.author_association });

/**
 * runJev and runHaiku write one token_usage row per agent name (`jev-<ref>`,
 * `haiku-NN`) with INSERT OR REPLACE. Rows from earlier passes with those
 * names are renamed first so their cost stays on record.
 */
function keepUsage(db: DatabaseSync, run: string, agents: string[]): void {
  const q = db.prepare("UPDATE token_usage SET agent = agent || '@' || COALESCE(started_at, '') WHERE run_id = ? AND agent = ?");
  for (const a of agents) q.run(run, a);
}

/** Items sent to a model so far in this job, saved as the job's handled count. */
const sentCounter = (ctx: StepContext) => {
  let sent = 0;
  return (n: number) => ctx.handled((sent += n));
};

async function jevPass(ctx: StepContext, run: string, todo: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<Set<string>> {
  const { db } = ctx;
  const setHash = db.prepare("UPDATE classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'jev' AND run_id = ? AND at >= ?");
  const done = new Set<string>();
  for (let i = 0; i < todo.length && !ctx.cancelled() && jevAvailable(db); i += JEV_CHUNK) {
    const chunk = todo.slice(i, i + JEV_CHUNK);
    keepUsage(db, run, chunk.map((x) => `jev-${refOf(x)}`));
    const t0 = new Date().toISOString();
    sent(chunk.length);
    await runJev(db, run, chunk);
    for (const x of chunk) if (setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0).changes) done.add(refOf(x));
    ctx.progress(`Jev: ${Math.min(i + JEV_CHUNK, todo.length)} of ${todo.length} items`);
  }
  return done;
}

/**
 * Open items in `run` without a Haiku verdict as new as Jev's where Jev is unsure of the type or of a flag.
 * Items of repos with the pipeline on come first, then the newest Jev verdicts.
 */
export function haikuDue(db: DatabaseSync, run: string, limit: number): Item[] {
  const p = "CASE WHEN json_valid(j.probs) THEN j.probs END";
  const unsureFlag = (key: string, yes: number) => `COALESCE(json_extract(${p}, '$.${key}') >= :flagNo AND json_extract(${p}, '$.${key}') < ${yes}, 0)`;
  return db.prepare(`SELECT ${ITEM_COLUMNS} FROM items i JOIN tracked_repos t ON t.name = i.repo
    JOIN classifications j ON j.repo = i.repo AND j.number = i.number AND j.classifier = 'jev' AND j.run_id = :run
    LEFT JOIN classifications h ON h.repo = i.repo AND h.number = i.number AND h.classifier = 'haiku' AND h.run_id = :run
    WHERE i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")}
      AND (COALESCE(json_extract(${p}, '$.top'), 0) < :sure OR ${unsureFlag("security", JEV_SECURITY_YES)} OR ${unsureFlag("needs_decision", JEV_NEEDS_DECISION_YES)})
      AND (h.at IS NULL OR h.at < j.at)
    ORDER BY t.pipeline DESC, j.at DESC LIMIT :limit`).all({ run, sure: SURE, flagNo: JEV_FLAG_NO, limit }) as unknown as Item[];
}

async function haikuPass(ctx: StepContext, run: string, todo: Item[], sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const count = db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE classifier = 'haiku' AND run_id = ? AND at >= ?");
  const t0 = new Date().toISOString();
  // A chunk holds one batch for every call the accounts can take at once (at least 4), so the calls fill the free slots.
  for (let i = 0, size = 0; i < todo.length && !ctx.cancelled(); i += size) {
    size = HAIKU_PER_CALL * Math.max(4, freeSlots(db));
    const chunk = todo.slice(i, i + size);
    keepUsage(db, run, Array.from({ length: Math.ceil(chunk.length / HAIKU_PER_CALL) }, (_, n) => `haiku-${String(n).padStart(2, "0")}`));
    sent(chunk.length);
    // The first call of the pass runs alone and writes the prompt cache; the rest read it.
    await runHaiku(db, run, chunk, undefined, undefined, { cold: i === 0 });
    ctx.progress(`Haiku: ${Math.min(i + size, todo.length)} of ${todo.length} items`);
  }
  return (count.get(run, t0) as { n: number }).n;
}

/**
 * Haiku classifies the items alone. Its verdict carries the item's input hash, which keeps the item from being due for Jev
 * until it changes, and replaces a Jev verdict of the item's earlier text. Returns the number of items Haiku answered.
 */
async function haikuOnlyPass(ctx: StepContext, run: string, items: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const t0 = new Date().toISOString();
  await haikuPass(ctx, run, items, sent);
  const setHash = db.prepare("UPDATE classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'haiku' AND run_id = ? AND at >= ?");
  // A Jev row of the item's earlier text goes; one without a hash (older rows) is kept, it is current until the item changes.
  const dropStale = db.prepare("DELETE FROM classifications WHERE repo = ? AND number = ? AND classifier = 'jev' AND run_id = ? AND input_hash IS NOT NULL AND input_hash <> ?");
  let n = 0;
  for (const x of items) {
    if (!setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0).changes) continue;
    dropStale.run(x.repo, x.number, run, hashes.get(refOf(x))!);
    n++;
  }
  return n;
}

/**
 * Open items that need a Jev verdict in `run`, with each due item's input hash. "all" takes only items without a verdict.
 * The hashes are stored on the item row (src/itemhash.ts), so no body is read for items that are up to date.
 */
export function dueItems(db: DatabaseSync, run: string, mode: "new" | "all"): { open: number; due: Row[]; hashes: Map<string, string> } {
  fillClassHashes(db);
  const open = (db.prepare("SELECT COUNT(*) AS n FROM items i JOIN tracked_repos t ON t.name = i.repo WHERE i.state = 'OPEN'").get() as { n: number }).n;
  // Items without a verdict first, then changed ones; newest first within each.
  const due = db.prepare(`SELECT ${ITEM_COLUMNS}, i.updated_at, c.at AS c_at, c.input_hash AS c_hash, i.class_hash AS h
    FROM items i JOIN tracked_repos t ON t.name = i.repo
    LEFT JOIN classifications c ON c.repo = i.repo AND c.number = i.number AND c.classifier = 'jev' AND c.run_id = :run
    LEFT JOIN classifications hc ON hc.repo = i.repo AND hc.number = i.number AND hc.classifier = 'haiku' AND hc.run_id = :run
    WHERE i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} AND i.class_scheme = :scheme
      AND NOT COALESCE(hc.input_hash = i.class_hash AND (c.at IS NULL OR hc.at > c.at), 0)
      AND (c.at IS NULL OR (:new AND CASE WHEN c.input_hash IS NOT NULL THEN c.input_hash != i.class_hash ELSE COALESCE(i.updated_at, '') > c.at END))
    ORDER BY c.at IS NOT NULL, i.updated_at DESC, i.repo, i.number`).all({ run, scheme: SCHEME_ID, new: mode === "new" ? 1 : 0 }) as unknown as (Row & { h: string })[];
  const hashes = new Map<string, string>();
  for (const r of due) hashes.set(refOf(r), r.h);
  return { open, due, hashes };
}

async function pass(ctx: StepContext, run: string, mode: "new" | "all"): Promise<{ areas: AssignResult; jev: number; due: number; haiku: number; haikuDue: number; haikuAlone: number; aloneDue: number; left: number }> {
  const limit = Number(ctx.params.limit);
  ctx.usageRun(run);
  ctx.progress("Finding items to classify");
  const { open, due, hashes } = dueItems(ctx.db, run, mode);
  const todo = due.slice(0, limit).map(strip);
  ctx.log(`run ${run}: ${open} open items, ${due.length} due for Jev, taking ${todo.length}`);
  const sent = sentCounter(ctx);
  const jevDone = await jevPass(ctx, run, todo, hashes, sent);
  // Items Jev did not answer because it is unavailable go to Haiku, which settles them.
  const alone = ctx.cancelled() || jevAvailable(ctx.db) ? [] : todo.filter((x) => !jevDone.has(refOf(x)));
  const haikuAlone = alone.length ? await haikuOnlyPass(ctx, run, alone, hashes, sent) : 0;
  if (alone.length) ctx.log(`Jev unavailable: Haiku classified ${haikuAlone} of ${alone.length} items`);
  const aloneRefs = new Set(alone.map(refOf));
  const unsure = ctx.cancelled() ? [] : haikuDue(ctx.db, run, limit).filter((x) => !aloneRefs.has(refOf(x)));
  ctx.log(`Haiku: ${unsure.length} items where Jev is unsure of the type (under ${SURE * 100} %) or of a flag`);
  const haiku = await haikuPass(ctx, run, unsure, sent);
  const jev = jevDone.size;
  // Items of repos with an area list that were not asked against its current version; Jev's answers share the job's limit with the type pass.
  const areas = ctx.cancelled() ? { due: 0, jev: 0, haiku: 0, none: 0, left: 0 } : await assignAreas(ctx.db, { limit, usageRun: run, onSent: sent, cancelled: ctx.cancelled, progress: ctx.progress, log: ctx.log });
  return { areas, jev, due: due.length, haiku, haikuDue: unsure.length, haikuAlone, aloneDue: alone.length, left: due.length - jev - haikuAlone };
}

const areaNote = (r: { areas: AssignResult }): string => (r.areas.due ? ` Areas: ${r.areas.jev} by Jev, ${r.areas.haiku} by Haiku of ${r.areas.due} items asked.` : "");

const aloneNote = (r: { haikuAlone: number; aloneDue: number }): string => (r.aloneDue ? `Jev unavailable: Haiku classified ${r.haikuAlone} items. ` : "");

export async function classifyNew(ctx: StepContext): Promise<string> {
  const run = currentRun(ctx.db);
  if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
  const r = await pass(ctx, run, "new");
  if (!r.due && !r.haikuDue && !r.areas.due) return `Nothing to classify in run ${run}.`;
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} new or changed items${r.left ? ` (${r.left} left)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}`;
}

export async function classifyAll(ctx: StepContext): Promise<string> {
  const run = String(ctx.params.run);
  const r = await pass(ctx, run, "all");
  const complete = r.left === 0 && !ctx.cancelled();
  if (complete) ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(run);
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} items without a verdict${r.left ? ` (${r.left} left; start it again to continue)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}${complete ? " The run is now the current one." : ""}`;
}
