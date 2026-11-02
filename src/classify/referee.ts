// Referee: Sonnet decides disagreements between Jev and Haiku under the written rules.
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { parseRefereeReply, type Item } from "./parse.ts";
import { type Pair, ref } from "./report.ts";
import { askClaude, loadItems, pool, saveUsage } from "./run.ts";
import { rng, spread } from "./sample.ts";

export function pickDisagreements(pairs: Pair[], count: number, seed: number): Pair[] {
  const dis = pairs.filter((p) => p.jev.type_label !== p.haiku.type_label);
  return spread(dis, (p) => `${p.r.kind}|${p.jev.type_label}`, count, rng(seed));
}

const REFEREE = CLAUDE_PROMPTS["referee.sonnet"];

export async function runReferee(db: DatabaseSync, runId: string, picked: Pair[], perCall = REFEREE.limits.perCall): Promise<void> {
  const items = loadItems(db, picked.map((p) => p.r));
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += perCall) chunks.push(items.slice(i, i + perCall));
  const ins = db.prepare(`INSERT OR REPLACE INTO classifications (repo, number, classifier, run_id, at, type_label, flags, reason)
    VALUES (?, ?, 'sonnet', ?, ?, ?, '[]', ?)`);
  await pool(chunks.map((chunk, n) => async () => {
    const start = new Date().toISOString();
    const refs = chunk.map(ref);
    let got = 0;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null as number | null };
    for (let attempt = 0; attempt < REFEREE.limits.attempts && got < refs.length; attempt++) {
      const todo = chunk.filter((i) => !db.prepare(`SELECT 1 FROM classifications WHERE repo = ? AND number = ? AND classifier = 'sonnet' AND run_id = ?`).get(i.repo, i.number, runId));
      const reply = await askClaude("referee.sonnet", REFEREE.models[0]!, todo, db);
      if (!reply) continue;
      usage = { input: usage.input + reply.usage.input, output: usage.output + reply.usage.output, cacheRead: usage.cacheRead + reply.usage.cacheRead, cacheWrite: usage.cacheWrite + reply.usage.cacheWrite, cost: (usage.cost ?? 0) + (reply.usage.cost ?? 0) };
      for (const v of parseRefereeReply(reply.text, todo.map(ref))) {
        const [repo, num] = v.ref.split("#");
        ins.run(repo!, Number(num), runId, new Date().toISOString(), v.type_label, v.why);
        got++;
      }
    }
    saveUsage(db, runId, `sonnet-${n}`, "referee", REFEREE.models[0]!, got, usage, start, new Date().toISOString());
  }), REFEREE.limits.parallel);
}

/** Marks a varied subset (by kind and by whom Sonnet sided with) for the owner to check by hand. */
export function markSpotCheck(db: DatabaseSync, runId: string, pairs: Pair[], count: number, seed: number): void {
  const verdicts = new Map(
    (db.prepare(`SELECT repo, number, type_label FROM classifications WHERE classifier = 'sonnet' AND run_id = ?`).all(runId) as
      { repo: string; number: number; type_label: string }[]).map((r) => [ref(r), r.type_label]),
  );
  const refereed = pairs.filter((p) => verdicts.has(ref(p.r)));
  const side = (p: Pair) => { const v = verdicts.get(ref(p.r)); return v === p.jev.type_label ? "jev" : v === p.haiku.type_label ? "haiku" : "neither"; };
  db.prepare(`UPDATE classifications SET flags = '[]' WHERE classifier = 'sonnet' AND run_id = ?`).run(runId);
  const upd = db.prepare(`UPDATE classifications SET flags = '["spot-check"]' WHERE classifier = 'sonnet' AND run_id = ? AND repo = ? AND number = ?`);
  for (const p of spread(refereed, (p) => `${p.r.kind}|${side(p)}`, count, rng(seed + 1))) upd.run(runId, p.r.repo, p.r.number);
}
