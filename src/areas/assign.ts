// Assigns items to the areas of their repo's list: one Jev `choice` question per item among the areas plus
// "none of these". Jev's top choice at AREA_SURE or more settles it; below that Haiku decides, and Haiku
// decides alone while Jev is unavailable. Repos without a list are skipped. An item asked against the current
// list version is not asked again unless a re-scan asks for the unassigned ones.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { jevParallel } from "../agents/accounts.ts";
import { jevAvailable } from "../agents/jev.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { refOf } from "../classify/parse.ts";
import { add, askClaude, askJev, pool, saveUsage, type Usage } from "../classify/run.ts";
import { JEV_USD_PER_INPUT_TOKEN } from "../prompts/index.ts";
import { pilotSql } from "../pilot.ts";
import { CLAUDE_PROMPTS, renderAreaJev } from "../prompts/index.ts";
import { cachedDiff, ghDiff, splitDiff } from "../review/diff.ts";
import { jevAreaAnswer, parseAreaReply, settles } from "./parse.ts";
import { currentList, setItemArea } from "./store.ts";
import { AREA_PATHS_MAX, type Area, type AreaItem } from "./types.ts";

const HAIKU = CLAUDE_PROMPTS["areas.haiku"];
const CHUNK = 40;

/** Changed file paths of a pull request, or null when unavailable. */
export type PathSource = (repo: string, number: number, head: string | null) => Promise<string[] | null>;

/** Below this many GitHub points left (the sync's last reading) no diff is fetched; cached diffs are still read. */
export const RATE_FLOOR = 500;
// Heads whose diff could not be fetched in this process: not tried again.
const failedHeads = new Set<string>();

/** From the diff cache or `gh pr diff` (a read). `db` supplies the stored sync rate reading. */
export const diffPaths = (db: DatabaseSync): PathSource => async (repo, number, head) => {
  if (!head) return null;
  const key = `${repo}#${number}@${head}`;
  if (failedHeads.has(key)) return null;
  const low = Number((db.prepare("SELECT value FROM settings WHERE key = 'sync_rate_remaining'").get() as { value: string } | undefined)?.value ?? Infinity) < RATE_FLOOR;
  const r = await cachedDiff(repo, number, head, low ? async () => ({ ok: false, tooLarge: false, error: "rate low" }) : ghDiff);
  if (!r.ok) {
    if (!low) failedHeads.add(key);
    return null;
  }
  return splitDiff(r.text).map((f) => f.path).slice(0, AREA_PATHS_MAX);
};

type Due = AreaItem & { head: string | null; version: number };

/**
 * Open items of repos with an area list that need an answer. Without `rescan`: never asked, or asked against an older
 * list version and unassigned. With `rescan`: also the ones answered "none of these" for the current version.
 * Operator-assigned items are never due.
 */
export function dueForArea(db: DatabaseSync, opts: { repo?: string; limit: number; rescan?: boolean }): Due[] {
  return db.prepare(`SELECT i.repo, i.number, i.kind, COALESCE(i.title, '') AS title, COALESCE(i.body, '') AS body,
      i.additions + i.deletions AS lines_changed, i.changed_files AS files_changed, i.author_association, i.head_oid AS head, l.v AS version
    FROM items i JOIN tracked_repos t ON t.name = i.repo
    JOIN (SELECT repo, MAX(version) AS v FROM area_lists GROUP BY repo) l ON l.repo = i.repo
    LEFT JOIN item_areas a ON a.repo = i.repo AND a.number = i.number
    WHERE i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} AND (:repo IS NULL OR i.repo = :repo)
      AND (a.number IS NULL OR (a.source <> 'operator' AND (a.list_version <> l.v OR (:rescan AND a.area IS NULL))))
    ORDER BY t.pipeline DESC, i.updated_at DESC, i.repo, i.number LIMIT :limit`)
    .all({ repo: opts.repo ?? null, rescan: opts.rescan ? 1 : 0, limit: opts.limit }) as unknown as Due[];
}

export type AssignParams = {
  repo?: string;
  limit: number;
  rescan?: boolean;
  paths?: PathSource;
  usageRun: string;
  onSent?: (n: number) => void;
  cancelled?: () => boolean;
  progress?: (line: string) => void;
  log?: (line: string) => void;
};
export type AssignResult = { due: number; jev: number; haiku: number; none: number; left: number };

/** Usage rows of an earlier pass under the same agent name are renamed, so INSERT OR REPLACE does not overwrite their cost. */
function keepUsage(db: DatabaseSync, run: string, agent: string, attempt = 0): void {
  if (attempt > 0) return;
  db.prepare("UPDATE token_usage SET agent = agent || '@' || COALESCE(started_at, '') WHERE run_id = ? AND agent = ?").run(run, agent);
}

const now = () => new Date().toISOString();
const usageZero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });

async function withPaths(items: Due[], source: PathSource): Promise<AreaItem[]> {
  const prs = items.filter((x) => x.kind === "pr");
  const found = new Map<string, string[]>();
  await pool(prs.map((x) => async () => {
    const p = await source(x.repo, x.number, x.head).catch(() => null);
    if (p) found.set(refOf(x), p);
  }), 4);
  return items.map(({ head: _h, version: _v, ...x }) => ({ ...x, ...(found.has(refOf(x)) && { paths: found.get(refOf(x))! }) }));
}

async function haikuAreas(db: DatabaseSync, repo: string, areas: Area[], items: AreaItem[], p: AssignParams): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const batches: AreaItem[][] = [];
  for (let i = 0; i < items.length; i += HAIKU.limits.perCall) batches.push(items.slice(i, i + HAIKU.limits.perCall));
  await pool(batches.map((batch, n) => async () => {
    const start = now();
    let usage = usageZero(), todo = batch;
    for (let attempt = 0; attempt < HAIKU.limits.attempts && todo.length && !p.cancelled?.(); attempt++) {
      const reply = await askClaude("areas.haiku", HAIKU.models[0]!, [{ repo, areas, items: todo }], db);
      if (!reply) continue;
      usage = add(usage, reply.usage);
      const { answers, missing } = parseAreaReply(reply.text, todo.map(refOf), areas);
      for (const [ref, area] of answers) out.set(ref, area);
      todo = todo.filter((x) => missing.includes(refOf(x)));
    }
    const agent = `areas-haiku-${repo}-${String(n).padStart(3, "0")}`;
    keepUsage(db, p.usageRun, agent);
    saveUsage(db, p.usageRun, agent, "areas", HAIKU.models[0]!, batch.length - todo.length, usage, start, now());
  }), () => claudeRoom(db));
  return out;
}

/** Asks the due items of one repo and stores the answers. */
async function assignRepo(db: DatabaseSync, repo: string, due: Due[], p: AssignParams, r: AssignResult): Promise<void> {
  const list = currentList(db, repo)!;
  const version = list.version;
  const store = (x: AreaItem, area: string | null, source: "jev" | "haiku", conf: number | null) => {
    // The list was edited while this pass ran: the answer is for a list that is gone.
    if (currentList(db, repo)?.version !== version) return;
    setItemArea(db, x.repo, x.number, area, source, conf, version);
    if (source === "jev") r.jev++; else r.haiku++;
    if (area === null) r.none++;
  };
  for (let i = 0; i < due.length && !p.cancelled?.(); i += CHUNK) {
    // With neither model available there is nothing to ask, so no diff is fetched.
    if (!jevAvailable(db) && claudeRoom(db) <= 0 && !p.paths) { p.log?.(`areas: no model available for ${repo}`); break; }
    const chunk = await withPaths(due.slice(i, i + CHUNK), p.paths ?? diffPaths(db));
    p.onSent?.(chunk.length);
    const answered = new Set<string>();
    const unsure: AreaItem[] = [];
    const jevUsage = new Map<string, number>();
    if (jevAvailable(db)) {
      await pool(chunk.map((x) => async () => {
        if (!jevAvailable(db)) return;
        for (let attempt = 0; attempt < 2 && !answered.has(refOf(x)) && jevAvailable(db); attempt++) {
          const t0 = now();
          const res = await askJev("areas.jev", x, db, renderAreaJev(x, list.areas));
          try {
            const j = JSON.parse(res.stdout) as { usage?: { input_tokens?: number; output_tokens?: number } };
            const input = (jevUsage.get(refOf(x)) ?? 0) + (j.usage?.input_tokens ?? 0);
            jevUsage.set(refOf(x), input);
            keepUsage(db, p.usageRun, `areas-jev-${refOf(x)}`, attempt);
            saveUsage(db, p.usageRun, `areas-jev-${refOf(x)}`, "areas", "jev-latest", 1, { input, output: j.usage?.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0, cost: input * JEV_USD_PER_INPUT_TOKEN }, t0, now());
          } catch { /* an unreadable answer is retried below */ }
          const a = res.code === 0 ? jevAreaAnswer(res.stdout, list.areas) : null;
          if (!a) continue;
          answered.add(refOf(x));
          if (settles(a.top)) store(x, a.area, "jev", a.top);
          else unsure.push(x);
        }
      }), jevParallel(db));
    }
    // Items Jev could not answer because it is unavailable go to Haiku alone; a Jev failure with Jev up leaves the item for the next pass.
    const alone = jevAvailable(db) ? [] : chunk.filter((x) => !answered.has(refOf(x)));
    const ask = [...unsure, ...alone];
    if (ask.length && !p.cancelled?.()) {
      const got = await haikuAreas(db, repo, list.areas, ask, p);
      for (const x of ask) if (got.has(refOf(x))) store(x, got.get(refOf(x))!, "haiku", null);
    }
    p.progress?.(`Areas ${repo}: ${Math.min(i + CHUNK, due.length)} of ${due.length} items`);
  }
}

/** Assigns areas to the due items. Returns counts; `left` is the due items that got no answer in this pass. */
export async function assignAreas(db: DatabaseSync, p: AssignParams): Promise<AssignResult> {
  const due = dueForArea(db, { repo: p.repo, limit: p.limit, rescan: p.rescan });
  const r: AssignResult = { due: due.length, jev: 0, haiku: 0, none: 0, left: 0 };
  const byRepo = new Map<string, Due[]>();
  for (const x of due) byRepo.set(x.repo, [...(byRepo.get(x.repo) ?? []), x]);
  for (const [repo, items] of byRepo) {
    if (p.cancelled?.()) break;
    await assignRepo(db, repo, items, p, r);
  }
  r.left = r.due - r.jev - r.haiku;
  p.log?.(`areas: ${r.due} items due, Jev settled ${r.jev}, Haiku ${r.haiku}, ${r.none} with none of the areas, ${r.left} unanswered`);
  return r;
}

