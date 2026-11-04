// Opus recommendation for scope decisions: one call per decision, with read-only
// tools on a checkout of the default branch when there is one. The model may
// answer with no recommendation. Our code accepts only a key of the decision's
// own options.
import { referenceDir } from "../reference.ts";
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { summaryInput } from "../classify/parse.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { RECOMMEND_MAX_FAILURES } from "../core/item-rules.ts";
import { plannedItems } from "../core/select-items.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { loadSummaryItems } from "./index.ts";
import { OPENING_MAX } from "../conversations/types.ts";
import { startFromOpus, type DiffSource } from "../conversations/store.ts";
import { RECOMMEND_REASON_MAX, type RecommendInput } from "./recommend-types.ts";

export const RECOMMEND_PROMPT = CLAUDE_PROMPTS["decide.recommend"];
export type Recommendation = { recommended: string | null; reason: string; /** An opening question or proposal for the item's conversation. */ conversation?: string };

/** The last balanced `{...}` in the text that parses and has the property (string quoting respected), or null. For replies with prose braces around the answer. */
function lastObjectWith(text: string, prop: string): unknown {
  for (let end = text.lastIndexOf("}"); end > 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0, inStr = false;
    for (let i = end; i >= 0; i--) {
      const ch = text[i]!;
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr && ch === "}") depth++;
      else if (!inStr && ch === "{" && --depth === 0) {
        try { const o = JSON.parse(text.slice(i, end + 1)); if (o && typeof o === "object" && prop in o) return o; } catch { /* try an earlier object */ }
        break;
      }
    }
  }
  return null;
}

/** The recommendation in a reply, or null when it has no JSON object. A key that is not one of `keys` becomes null. */
export function parseRecommendReply(text: string, keys: string[]): Recommendation | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let o: unknown;
  try { o = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { o = lastObjectWith(text, "recommended"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const { recommended, reason, conversation } = o as Record<string, unknown>;
  const text1 = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, RECOMMEND_REASON_MAX) : "";
  const opening = typeof conversation === "string" ? conversation.trim().slice(0, OPENING_MAX) : "";
  return { recommended: typeof recommended === "string" && keys.includes(recommended) ? recommended : null, reason: text1, ...(opening && { conversation: opening }) };
}

type Row = { id: string; repo: string; number: number; question: string; facts: string | null; options: string; summary: string | null };

/** Ids of the open scope decisions of the items whose Plans ask for a recommendation, oldest decision first. */
export function recommendIds(db: DatabaseSync, nowMs: number = Date.now()): string[] {
  const own = db.prepare("SELECT id, asked_at FROM decisions WHERE kind = 'scope' AND repo = ? AND number = ? AND answer IS NULL AND recommended_by IS NULL");
  return plannedItems(db, "decide", { bucket: "recommend", now: nowMs })
    .flatMap((p) => own.all(p.facts.repo, p.facts.number) as { id: string; asked_at: string }[])
    .sort((a, b) => (a.asked_at < b.asked_at ? -1 : a.asked_at > b.asked_at ? 1 : a.id < b.id ? -1 : 1)).map((d) => d.id);
}

export type RecommendParams = {
  model?: string;
  /** Host directory with a read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  /** PR diffs for the item block of a conversation Opus starts. Default: none. */
  diff?: DiffSource;
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
  const failed = db.prepare("UPDATE decisions SET recommend_failures = COALESCE(recommend_failures, 0) + 1, recommend_failed_at = ? WHERE id = ?");
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
      const reply = await askClaude("decide.recommend", model, [input], db, { checkout: checkout ?? undefined, reference: checkout ? referenceDir(d.repo) : undefined });
      if (!reply) continue;
      usage = add(usage, reply.usage);
      got = parseRecommendReply(reply.text, options.map((o) => o.key));
    }
    if (got) {
      store.run(got.recommended, got.reason || null, model, d.id);
      stored++;
      if (got.conversation) await startFromOpus(db, d.repo, d.number, got.conversation, { diff: p.diff }).catch((e) => p.log(`decide: no conversation for ${d.id}: ${(e as Error).message}`));
    } else {
      failed.run(now(), d.id);
      p.log(`decide: no valid recommendation for ${d.id}; retried in an hour, at most ${RECOMMEND_MAX_FAILURES} tries`);
    }
    saveUsage(db, p.usageRun, `recommend-${String(n).padStart(3, "0")}`, "decide", model, 1, usage, start, now());
  }), () => claudeRoom(db), { first: true });
  return stored;
}
