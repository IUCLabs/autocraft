// craft-auto prioritize [--limit N]: priority level (P0-P4) of open items and their reach (src/priority/score.ts).
//
// Jev classifies the impact of each item whose text has no priority row at its
// current hash; Haiku decides where Jev is under 90 % sure. The reach is
// recomputed from the mirror's reach signals on every pass, without a model.
import type { DatabaseSync } from "node:sqlite";
import { jevParallel } from "../agents/accounts.ts";
import { claudeRoom } from "../agents/call.ts";
import { type Item, refOf } from "../classify/parse.ts";
import { askClaude, askJev, pool } from "../classify/run.ts";
import { connect } from "../db.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { CLAUDE_PROMPTS, JEV_PROMPTS } from "../prompts/index.ts";
import { reachOfOpenItems } from "./reach.ts";
import { jevImpact, parseHaikuImpacts, reachScore, settleImpact, SURE, type Impact, type JevImpactAnswers } from "./score.ts";

const JEV = JEV_PROMPTS["priority.jev"], HAIKU = CLAUDE_PROMPTS["priority.haiku"];
const JEV_CHUNK = 40;
const now = () => new Date().toISOString();

type Due = Item & { hash: string };

const ITEM_COLUMNS = `i.repo, i.number, i.kind, COALESCE(i.title, '') AS title, COALESCE(i.body, '') AS body,
  i.additions + i.deletions AS lines_changed, i.changed_files AS files_changed, i.author_association, i.embed_hash AS hash`;

const DUE_WHERE = `i.state = 'OPEN' AND i.embed_hash IS NOT NULL AND (p.repo IS NULL OR p.text_hash <> i.embed_hash)`;

/** Number of open tracked items without a priority row at their current text hash. Read-only, for the autopilot. */
export function duePriorityCount(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN tracked_repos t ON t.name = i.repo
    LEFT JOIN item_priority p ON p.repo = i.repo AND p.number = i.number WHERE ${DUE_WHERE}`).get() as { n: number }).n;
}

/** Items with no row first, then changed ones; pull requests first, newest first. */
export function dueItems(db: DatabaseSync, limit: number): Due[] {
  return db.prepare(`SELECT ${ITEM_COLUMNS} FROM items i JOIN tracked_repos t ON t.name = i.repo
    LEFT JOIN item_priority p ON p.repo = i.repo AND p.number = i.number WHERE ${DUE_WHERE}
    ORDER BY p.repo IS NOT NULL, i.kind = 'pr' DESC, i.updated_at DESC, i.repo, i.number LIMIT ?`).all(limit) as unknown as Due[];
}

type Verdict = { jev: { impact: Impact; p: number } | null; haiku: { impact: Impact; reason: string } | null };

async function askJevImpact(db: DatabaseSync, item: Item): Promise<{ impact: Impact; p: number } | null> {
  for (let attempt = 0; attempt < JEV.limits.attempts; attempt++) {
    const r = await askJev("priority.jev", item, db);
    try {
      const v = jevImpact((JSON.parse(r.stdout) as { answers?: JevImpactAnswers }).answers);
      if (v) return v;
    } catch { /* retry once */ }
  }
  return null;
}

function save(db: DatabaseSync, item: Due, v: Verdict): boolean {
  const s = settleImpact(v.jev, v.haiku?.impact ?? null);
  if (!s) return false;
  const reason = s.model === "haiku" ? v.haiku!.reason : v.jev ? `${v.jev.impact} ${v.jev.p.toFixed(2)}` : "";
  db.prepare(`INSERT OR REPLACE INTO item_priority (repo, number, text_hash, impact, jev_impact, jev_p, haiku_impact, score, model, reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.repo, item.number, item.hash, s.impact, v.jev?.impact ?? null, v.jev?.p ?? null,
    v.haiku?.impact ?? null, 0, s.model, reason, now());
  return true;
}

/**
 * Recomputes the reach of every open item with a priority row from the current reach signals.
 * Returns the number of rows whose reach changed.
 */
export function rescore(db: DatabaseSync, nowMs: number = Date.now()): number {
  const reach = reachOfOpenItems(db, nowMs);
  const rows = db.prepare(`SELECT p.repo, p.number, p.score FROM item_priority p JOIN items i ON i.repo = p.repo AND i.number = p.number WHERE i.state = 'OPEN'`)
    .all() as { repo: string; number: number; score: number }[];
  const upd = db.prepare("UPDATE item_priority SET score = ? WHERE repo = ? AND number = ?");
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      const rc = reach.get(`${r.repo}#${r.number}`);
      if (!rc) continue;
      const score = reachScore(rc);
      if (score !== r.score) { upd.run(score, r.repo, r.number); changed++; }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return changed;
}

export type PrioritizeOptions = { limit: number; onSent?: (n: number) => void; cancelled?: () => boolean; log?: (line: string) => void };
export type PrioritizeResult = { due: number; sent: number; jev: number; haiku: number; saved: number; rescored: number };

export async function runPrioritize(db: DatabaseSync, opts: PrioritizeOptions): Promise<PrioritizeResult> {
  const log = opts.log ?? (() => {});
  fillEmbedHashes(db);
  const due = duePriorityCount(db);
  const todo = dueItems(db, opts.limit);
  log(`prioritize: ${due} items due, taking ${todo.length}`);
  const res: PrioritizeResult = { due, sent: 0, jev: 0, haiku: 0, saved: 0, rescored: 0 };
  for (let i = 0; i < todo.length && !opts.cancelled?.(); i += JEV_CHUNK) {
    const chunk = todo.slice(i, i + JEV_CHUNK);
    res.sent += chunk.length;
    opts.onSent?.(res.sent);
    const jev = await pool(chunk.map((item) => () => askJevImpact(db, item)), () => jevParallel(db));
    const verdicts = new Map<string, Verdict>();
    const unsure: Due[] = [];
    chunk.forEach((item, n) => {
      const v = jev[n] ?? null;
      verdicts.set(refOf(item), { jev: v, haiku: null });
      if (v) res.jev++;
      if (!v || v.p < SURE) unsure.push(item);
    });
    const batches: Due[][] = [];
    for (let j = 0; j < unsure.length; j += HAIKU.limits.perCall) batches.push(unsure.slice(j, j + HAIKU.limits.perCall));
    await pool(batches.map((batch) => async () => {
      let ask = batch;
      for (let attempt = 0; attempt < HAIKU.limits.attempts && ask.length; attempt++) {
        const reply = await askClaude("priority.haiku", HAIKU.models[0]!, ask, db);
        if (!reply) continue;
        const { answers, missing } = parseHaikuImpacts(reply.text, ask.map(refOf));
        for (const a of answers) { verdicts.get(a.ref)!.haiku = { impact: a.impact, reason: a.reason }; res.haiku++; }
        ask = ask.filter((x) => missing.includes(refOf(x)));
      }
    }), () => claudeRoom(db));
    for (const item of chunk) if (save(db, item, verdicts.get(refOf(item))!)) res.saved++;
    else log(`prioritize: no valid answer for ${refOf(item)}`);
  }
  res.rescored = rescore(db);
  return res;
}

export const commands = {
  prioritize: {
    summary: "prioritize [--limit N]: Jev (Haiku where unsure) rates the level (P0-P4) of open items without a priority, then recomputes all reach",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--limit");
      const limit = i >= 0 ? Number(args[i + 1]) : 500;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit is a whole number of at least 1");
      const r = await runPrioritize(connect(), { limit, log: console.log });
      console.log(`${r.saved} of ${r.sent} rated (${r.jev} by Jev, ${r.haiku} by Haiku); ${r.rescored} reach values changed`);
    },
  },
};
