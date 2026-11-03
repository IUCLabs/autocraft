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

/** From the diff cache or `gh pr diff` (a read). */
export const diffPaths: PathSource = async (repo, number, head) => {
  if (!head) return null;
  const r = await cachedDiff(repo, number, head, ghDiff);
  return r.ok ? splitDiff(r.text).map((f) => f.path).slice(0, AREA_PATHS_MAX) : null;
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
    saveUsage(db, p.usageRun, `areas-haiku-${repo}-${String(n).padStart(3, "0")}`, "areas", HAIKU.models[0]!, batch.length - todo.length, usage, start, now());
  }), () => claudeRoom(db));
  return out;
}

/** Asks the due items of one repo and stores the answers. */
async function assignRepo(db: DatabaseSync, repo: string, due: Due[], p: AssignParams, r: AssignResult): Promise<void> {
  const list = currentList(db, repo)!;
  const version = list.version;
  const store = (x: AreaItem, area: string | null, source: "jev" | "haiku", conf: number | null) => {
    setItemArea(db, x.repo, x.number, area, source, conf, version);
    if (source === "jev") r.jev++; else r.haiku++;
    if (area === null) r.none++;
  };
  for (let i = 0; i < due.length && !p.cancelled?.(); i += CHUNK) {
    const chunk = await withPaths(due.slice(i, i + CHUNK), p.paths ?? diffPaths);
    p.onSent?.(chunk.length);
    const answered = new Set<string>();
    const unsure: AreaItem[] = [];
    if (jevAvailable(db)) {
      await pool(chunk.map((x) => async () => {
        if (!jevAvailable(db)) return;
        for (let attempt = 0; attempt < 2 && !answered.has(refOf(x)) && jevAvailable(db); attempt++) {
          const res = await askJev("areas.jev", x, db, renderAreaJev(x, list.areas));
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

