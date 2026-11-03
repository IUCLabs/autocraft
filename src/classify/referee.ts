// Referee: Sonnet decides disagreements between Jev and Haiku under the written rules.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { parseRefereeReply, type Item } from "./parse.ts";
import { type Pair, ref } from "./report.ts";
import { askClaude, loadItems, pool, saveUsage } from "./run.ts";
import { rng, spread } from "./sample.ts";
import { isScope } from "../decide/select.ts";
import { notHeldSql } from "../dupes/held.ts";
import { settle, topOf } from "./settled.ts";

export function pickDisagreements(pairs: Pair[], count: number, seed: number): Pair[] {
  const dis = pairs.filter((p) => p.jev.type_label !== p.haiku.type_label);
  return spread(dis, (p) => `${p.r.kind}|${p.jev.type_label}`, count, rng(seed));
}

const REFEREE = CLAUDE_PROMPTS["referee.sonnet"];

export async function runReferee(db: DatabaseSync, runId: string, picked: Pair[], perCall = REFEREE.limits.perCall): Promise<void> {
  await refereeItems(db, runId, loadItems(db, picked.map((p) => p.r)), { perCall, pipeline: false });
}

type RefereeOpts = {
  perCall?: number;
  /** Pipeline results carry probs {"sure": bool}, which settled.ts reads; evaluation rows carry none and never settle an item. */
  pipeline: boolean;
  /** Items sent to the model so far. */
  onSent?: (n: number) => void;
  cancelled?: () => boolean;
};

/** Sends the items to the Sonnet referee and stores one 'sonnet' row per answer in `runId`. Returns the number of answers. */
export async function refereeItems(db: DatabaseSync, runId: string, items: Item[], opts: RefereeOpts): Promise<number> {
  const perCall = opts.perCall ?? REFEREE.limits.perCall;
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += perCall) chunks.push(items.slice(i, i + perCall));
  const ins = db.prepare(`INSERT OR REPLACE INTO classifications (repo, number, classifier, run_id, at, type_label, flags, reason, probs)
    VALUES (?, ?, 'sonnet', ?, ?, ?, '[]', ?, ?)`);
  const have = db.prepare(`SELECT 1 FROM classifications WHERE repo = ? AND number = ? AND classifier = 'sonnet' AND run_id = ? AND at >= ?`);
  // Evaluation runs resume: any earlier answer in the run counts. Pipeline runs ask again, since a new answer replaces the old one.
  let total = 0, sent = 0;
  await pool(chunks.map((chunk, n) => async () => {
    if (opts.cancelled?.()) return;
    const start = new Date().toISOString();
    const refs = chunk.map(ref);
    let got = 0;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null as number | null };
    for (let attempt = 0; attempt < REFEREE.limits.attempts && got < refs.length; attempt++) {
      const todo = chunk.filter((i) => !have.get(i.repo, i.number, runId, opts.pipeline ? start : ""));
      opts.onSent?.((sent += todo.length));
      const reply = await askClaude("referee.sonnet", REFEREE.models[0]!, todo, db);
      if (!reply) continue;
      usage = { input: usage.input + reply.usage.input, output: usage.output + reply.usage.output, cacheRead: usage.cacheRead + reply.usage.cacheRead, cacheWrite: usage.cacheWrite + reply.usage.cacheWrite, cost: (usage.cost ?? 0) + (reply.usage.cost ?? 0) };
      for (const v of parseRefereeReply(reply.text, todo.map(ref))) {
        const [repo, num] = v.ref.split("#");
        ins.run(repo!, Number(num), runId, new Date().toISOString(), v.type_label, v.why, opts.pipeline ? JSON.stringify({ sure: v.sure === true }) : null);
        got++;
      }
    }
    total += got;
    saveUsage(db, runId, opts.pipeline ? `sonnet-${Date.now().toString(36)}-${n}` : `sonnet-${n}`, "referee", REFEREE.models[0]!, got, usage, start, new Date().toISOString());
  }), () => claudeRoom(db), { first: true });
  return total;
}

/**
 * Open items in `run` where Jev and Haiku disagree, at least one label is outside the scope set (scope-vs-scope goes
 * to Decide), and no referee answer is as new as both verdicts. Highest work rank first.
 */
export function refereeCandidates(db: DatabaseSync, run: string, limit = Infinity): Item[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.kind, COALESCE(i.title, '') AS title, COALESCE(i.body, '') AS body,
      i.additions + i.deletions AS lines_changed, i.changed_files AS files_changed, i.author_association,
      j.type_label AS jl, j.flags AS jf, j.probs AS jp, j.at AS jat, h.type_label AS hl, h.flags AS hf, h.at AS hat,
      (SELECT MAX(s.at) FROM classifications s WHERE s.repo = j.repo AND s.number = j.number AND s.classifier = 'sonnet' AND s.run_id = j.run_id
         AND json_extract(CASE WHEN json_valid(s.probs) THEN s.probs END, '$.sure') IS NOT NULL) AS sat
    FROM items i JOIN tracked_repos t ON t.name = i.repo
    JOIN classifications j ON j.repo = i.repo AND j.number = i.number AND j.classifier = 'jev' AND j.run_id = :run
    JOIN classifications h ON h.repo = i.repo AND h.number = i.number AND h.classifier = 'haiku' AND h.run_id = :run
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.state = 'OPEN' AND COALESCE(i.is_draft, 0) = 0 AND j.type_label <> h.type_label AND ${notHeldSql("i")}
    ORDER BY p.score IS NULL, p.score DESC, i.kind = 'pr' DESC, i.created_at, i.repo, i.number`).all({ run }) as unknown as
    (Item & { jl: string; jf: string | null; jp: string | null; jat: string; hl: string; hf: string | null; hat: string; sat: string | null })[];
  const out: Item[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (r.sat !== null && r.sat >= r.jat && r.sat >= r.hat) continue;
    const s = settle({ label: r.jl, flags: [], top: topOf(r.jp) }, { label: r.hl, flags: [] });
    if (s.status !== "disagree" || (isScope(r.jl) && isScope(r.hl))) continue;
    out.push({ repo: r.repo, number: r.number, kind: r.kind, title: r.title, body: r.body, lines_changed: r.lines_changed, files_changed: r.files_changed, author_association: r.author_association });
  }
  return out;
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
