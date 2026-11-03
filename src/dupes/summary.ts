// Haiku summaries for Close-as-duplicate decisions. A failed or missing summary
// never blocks asking the decision: it is asked without one and filled by a later run.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { parseSummaryReply } from "../classify/parse.ts";
import { askClaude, pool } from "../classify/run.ts";
import { getDecision } from "../decisions.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { pairInput } from "./check.ts";
import { duplicateAskTargets } from "./decide.ts";
import { DUPES_SUMMARY_PER_RUN, type DupePair } from "./pair.ts";

const PROMPT = CLAUDE_PROMPTS["dupes.summary"];
export const SUMMARY_MODEL = PROMPT.models[0]!;

export type PairSummary = { summary: string; by: string; at: string };
/** Haiku's reply text for a batch of pairs; null when there was none. */
export type Summarize = (pairs: DupePair[]) => Promise<string | null>;

export const defaultSummarize = (db: DatabaseSync): Summarize => async (pairs) =>
  (await askClaude("dupes.summary", SUMMARY_MODEL, pairs, db))?.text ?? null;

/**
 * Summaries for open duplicate decisions that have none (new ones first by being unasked, then the
 * backlog), at most `limit` pairs. Keyed by decision id; pairs that got no valid summary are left out.
 */
export async function summarizeDuplicates(db: DatabaseSync, summarize: Summarize, at: string, repo?: string, limit = DUPES_SUMMARY_PER_RUN): Promise<Map<string, PairSummary>> {
  const out = new Map<string, PairSummary>();
  const need = duplicateAskTargets(db, repo).filter((t) => !getDecision(db, t.id)?.summary).slice(0, limit);
  const pairs = new Map<string, { id: string; pair: DupePair }>();
  for (const t of need) {
    const a = Math.min(t.x, t.g.canonical), b = Math.max(t.x, t.g.canonical);
    const pair = pairInput(db, { repo: t.g.repo, a, b, a_hash: "", b_hash: "", similarity: 0 });
    pairs.set(pair.ref, { id: t.id, pair });
  }
  const refs = [...pairs.keys()];
  const batches: string[][] = [];
  for (let i = 0; i < refs.length; i += PROMPT.limits.perCall) batches.push(refs.slice(i, i + PROMPT.limits.perCall));
  await pool(batches.map((batch) => async () => {
    let todo = batch;
    for (let attempt = 0; attempt < PROMPT.limits.attempts && todo.length; attempt++) {
      let text: string | null = null;
      try { text = await summarize(todo.map((r) => pairs.get(r)!.pair)); } catch { /* ask without a summary */ }
      if (text === null) continue;
      const { summaries, missing } = parseSummaryReply(text, todo);
      for (const s of summaries) out.set(pairs.get(s.ref)!.id, { summary: s.summary, by: SUMMARY_MODEL, at });
      todo = todo.filter((r) => missing.includes(r));
    }
  }), () => claudeRoom(db), { first: true });
  return out;
}

