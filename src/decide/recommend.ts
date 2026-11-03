// Opus recommendation for scope decisions: one call per decision, with read-only
// tools on a checkout of the default branch when there is one. The model may
// answer with no recommendation. Our code accepts only a key of the decision's
// own options.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { summaryInput } from "../classify/parse.ts";
import { askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { notHeldSql } from "../dupes/held.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { loadSummaryItems } from "./index.ts";
import { RECOMMEND_REASON_MAX, type RecommendInput } from "./recommend-types.ts";

export const RECOMMEND_PROMPT = CLAUDE_PROMPTS["decide.recommend"];
export type Recommendation = { recommended: string | null; reason: string };

/** The recommendation in a reply, or null when it has no JSON object. A key that is not one of `keys` becomes null. */
export function parseRecommendReply(text: string, keys: string[]): Recommendation | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let o: unknown;
  try { o = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { o = null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const { recommended, reason } = o as Record<string, unknown>;
  const text1 = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, RECOMMEND_REASON_MAX) : "";
  return { recommended: typeof recommended === "string" && keys.includes(recommended) ? recommended : null, reason: text1 };
}

type Row = { id: string; repo: string; number: number; question: string; facts: string | null; options: string; summary: string | null };

/** Ids of open scope decisions without a recommendation from this prompt, on open pilot items, oldest first. */
export function backfillIds(db: DatabaseSync, limit: number): string[] {
  if (limit <= 0) return [];
  return (db.prepare(`SELECT d.id FROM decisions d JOIN items i ON i.repo = d.repo AND i.number = d.number
    WHERE d.kind = 'scope' AND d.answer IS NULL AND d.recommended_by IS NULL AND i.state = 'OPEN' AND ${notHeldSql("i")}
    ORDER BY d.asked_at, d.id LIMIT ?`).all(limit) as { id: string }[]).map((r) => r.id);
}

export type RecommendParams = {
  model?: string;
  /** Host directory with a read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  usageRun: string;
  onSent?: () => void;
  log: (line: string) => void;
};

const now = () => new Date().toISOString();

/** Asks Opus about each decision (one call each) and stores the answers. Returns how many decisions got an answer. */
export async function recommend(db: DatabaseSync, ids: string[], p: RecommendParams): Promise<number> {
  const model = p.model ?? RECOMMEND_PROMPT.models[0]!;
  const checkouts = new Map<string, Promise<string | null>>();
  const select = db.prepare("SELECT id, repo, number, question, facts, options, summary FROM decisions WHERE id = ? AND kind = 'scope' AND answer IS NULL");
  const store = db.prepare("UPDATE decisions SET recommended = ?, recommended_reason = ?, recommended_by = ? WHERE id = ? AND answer IS NULL");
  let stored = 0;
  await pool(ids.map((id, n) => async () => {
    const d = select.get(id) as Row | undefined;
    if (!d) return;
    const start = now();
    const options = JSON.parse(d.options) as { key: string; label: string; hint?: string }[];
    const [item] = loadSummaryItems(db, [d]);
    if (!item) return;
    if (!checkouts.has(d.repo)) checkouts.set(d.repo, p.checkout(d.repo).catch(() => null));
    const checkout = await checkouts.get(d.repo)!;
    const input: RecommendInput = {
      ref: `${d.repo}#${d.number}`, item: summaryInput(item), question: d.question,
      facts: JSON.parse(d.facts ?? "[]") as string[], summary: d.summary ?? "",
      options: options.map((o) => ({ key: o.key, label: o.label, hint: o.hint ?? "" })),
    };
    if (checkout) input.repo_dir = REPO_PATH;
    p.onSent?.();
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let got: Recommendation | null = null;
    for (let attempt = 0; attempt < RECOMMEND_PROMPT.limits.attempts && !got; attempt++) {
      const reply = await askClaude("decide.recommend", model, [input], db, { checkout: checkout ?? undefined });
      if (!reply) continue;
      usage = { input: usage.input + reply.usage.input, output: usage.output + reply.usage.output, cacheRead: usage.cacheRead + reply.usage.cacheRead, cacheWrite: usage.cacheWrite + reply.usage.cacheWrite, cost: usage.cost === null && reply.usage.cost === null ? null : (usage.cost ?? 0) + (reply.usage.cost ?? 0) };
      got = parseRecommendReply(reply.text, options.map((o) => o.key));
    }
    if (got) {
      store.run(got.recommended, got.reason || null, model, d.id);
      stored++;
    } else p.log(`decide: no valid recommendation for ${d.id}; the next run retries it`);
    saveUsage(db, p.usageRun, `recommend-${String(n).padStart(3, "0")}`, "decide", model, 1, usage, start, now());
  }), () => claudeRoom(db), { first: true });
  return stored;
}
