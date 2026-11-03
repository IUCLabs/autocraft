// The pair check: Jev for every pair, accepted at 0.9 either way; Haiku for the
// pairs Jev is not sure about.
import type { DatabaseSync } from "node:sqlite";
import { jevParallel } from "../agents/accounts.ts";
import { claudeRoom } from "../agents/call.ts";
import { askClaude, askJev, pool } from "../classify/run.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { pickCanonical } from "./canonical.ts";
import { pairRef, parsePairReply, settlePair, type DupePair, type PairVerdict } from "./pair.ts";
import { pilotSqlFor } from "../pilot.ts";

const HAIKU = CLAUDE_PROMPTS["dupes.haiku"];

export type PairKey = { repo: string; a: number; b: number; a_hash: string; b_hash: string; similarity: number };

/** Unchecked pairs whose items still have the hashed text and of which at least one is open, most similar first. */
export function uncheckedPairs(db: DatabaseSync, limit: number): PairKey[] {
  return db.prepare(`SELECT p.repo, p.a, p.b, p.a_hash, p.b_hash, p.similarity FROM duplicate_pairs p
    JOIN items ia ON ia.repo = p.repo AND ia.number = p.a AND ia.embed_hash = p.a_hash
    JOIN items ib ON ib.repo = p.repo AND ib.number = p.b AND ib.embed_hash = p.b_hash
    WHERE p.verdict IS NULL AND (ia.state = 'OPEN' OR ib.state = 'OPEN') AND p.repo IN (SELECT name FROM tracked_repos)
      AND (${pilotSqlFor("p.repo", "p.a")} OR ${pilotSqlFor("p.repo", "p.b")})
    ORDER BY p.similarity DESC, p.repo, p.a, p.b LIMIT ?`).all(limit) as PairKey[];
}

export function pairInput(db: DatabaseSync, k: PairKey): DupePair {
  const get = db.prepare("SELECT number, kind, state, title, body FROM items WHERE repo = ? AND number = ?");
  const item = (n: number) => {
    const r = get.get(k.repo, n) as { number: number; kind: "pr" | "issue"; state: string; title: string | null; body: string | null };
    return { number: r.number, kind: r.kind, state: r.state, title: r.title ?? "", body: r.body ?? "" };
  };
  return { ref: pairRef(k.repo, k.a, k.b), repo: k.repo, a: item(k.a), b: item(k.b) };
}

export type CheckDeps = {
  /** Jev's yes-probability that the pair is one bug or request; null when it gave no valid answer. */
  jev(pair: DupePair): Promise<number | null>;
  /** Haiku's reply text for a batch of pairs; null when there was none. */
  haiku(pairs: DupePair[]): Promise<string | null>;
  now(): Date;
};

export function defaultCheckDeps(db: DatabaseSync): CheckDeps {
  return {
    async jev(pair) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await askJev("dupes.jev", pair, db);
        try {
          const p = (JSON.parse(r.stdout) as { answers?: { same?: { noul?: unknown } } }).answers?.same?.noul;
          if (typeof p === "number" && p >= 0 && p <= 1) return p;
        } catch { /* retry once */ }
      }
      return null;
    },
    async haiku(pairs) {
      return (await askClaude("dupes.haiku", HAIKU.models[0]!, pairs, db))?.text ?? null;
    },
    now: () => new Date(),
  };
}

export type CheckCounts = { checked: number; jev: number; haiku: number; verdicts: Record<string, number>; unanswered: number };

function store(db: DatabaseSync, k: PairKey, jev: number | null, haiku: PairVerdict | null, verdict: PairVerdict, at: string): void {
  const canonical = verdict === "duplicate" ? pickCanonical(db, k.repo, [k.a, k.b]).number : null;
  db.prepare(`UPDATE duplicate_pairs SET jev_p = ?, haiku = ?, verdict = ?, canonical = ?, checked_at = ?
    WHERE repo = ? AND a = ? AND b = ? AND a_hash = ? AND b_hash = ?`).run(jev, haiku, verdict, canonical, at, k.repo, k.a, k.b, k.a_hash, k.b_hash);
}

/** Checks the pairs and stores each answered one. `onHandled` gets the running count of pairs sent to a model. */
export async function checkPairs(db: DatabaseSync, keys: PairKey[], deps: CheckDeps, onHandled?: (n: number) => void): Promise<CheckCounts> {
  const c: CheckCounts = { checked: 0, jev: 0, haiku: 0, verdicts: {}, unanswered: 0 };
  const jevP = new Map<string, number | null>();
  const pairs = new Map(keys.map((k) => [pairRef(k.repo, k.a, k.b), { k, pair: pairInput(db, k) }]));
  let handled = 0;
  await pool([...pairs.entries()].map(([ref, e]) => async () => {
    jevP.set(ref, await deps.jev(e.pair));
    c.jev++;
    onHandled?.(++handled);
  }), jevParallel(db));
  const at = deps.now().toISOString();
  const done = (ref: string, haiku: PairVerdict | null, verdict: PairVerdict) => {
    store(db, pairs.get(ref)!.k, jevP.get(ref) ?? null, haiku, verdict, at);
    c.checked++;
    c.verdicts[verdict] = (c.verdicts[verdict] ?? 0) + 1;
  };
  const second: string[] = [];
  for (const ref of pairs.keys()) {
    const v = settlePair(jevP.get(ref) ?? null, null);
    if (v) done(ref, null, v);
    else second.push(ref);
  }
  const batches: string[][] = [];
  for (let i = 0; i < second.length; i += HAIKU.limits.perCall) batches.push(second.slice(i, i + HAIKU.limits.perCall));
  await pool(batches.map((batch) => async () => {
    let todo = batch;
    for (let attempt = 0; attempt < HAIKU.limits.attempts && todo.length; attempt++) {
      const text = await deps.haiku(todo.map((r) => pairs.get(r)!.pair));
      if (text === null) continue;
      const { answers, missing } = parsePairReply(text, todo);
      c.haiku += answers.length;
      for (const a of answers) done(a.ref, a.verdict, settlePair(jevP.get(a.ref) ?? null, a.verdict) ?? "unsure");
      todo = todo.filter((r) => missing.includes(r));
    }
    c.unanswered += todo.length;
  }), () => claudeRoom(db), { first: true });
  return c;
}
