// The Conversation step: answers each operator message that waits for Opus with one sandboxed `claude -p` call
// (the item's repository and the shared repositories, read-only) and stores the reply with its action cards.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { parseReply } from "./cards.ts";
import { failTurn, pendingConversations, pendingTurn, promptParts, refreshItem, storeReply, type DiffSource } from "./store.ts";

export const CONVERSATION_PROMPT = CLAUDE_PROMPTS["conversation.turn"];

export type ConversationParams = {
  /** Most messages to answer in this run. */
  limit?: number;
  model?: string;
  /** Read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  /** Read-only checkouts of the shared repositories, asked once per run; those that fail are left out. */
  shared?: () => Promise<{ name: string; dir: string }[]>;
  diff?: DiffSource;
  usageRun: string;
  onHandled?: (n: number) => void;
  cancelled?: () => boolean;
  log: (line: string) => void;
};

const now = () => new Date().toISOString();
const sum = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0) });

/** Answers the waiting messages, oldest first. Returns how many got a reply. */
export async function answerPending(db: DatabaseSync, p: ConversationParams): Promise<number> {
  const model = p.model ?? CONVERSATION_PROMPT.models[0]!;
  let todo = pendingConversations(db);
  if (p.limit !== undefined) todo = todo.slice(0, Math.max(0, p.limit));
  let sharedAll: Promise<{ name: string; dir: string }[]> | undefined;
  const checkouts = new Map<string, Promise<string | null>>();
  let answered = 0, handled = 0;
  await pool(todo.map((c, k) => async () => {
    if (p.cancelled?.()) return;
    const { repo, number: n } = c;
    const wait = pendingTurn(db, repo, n);
    if (!wait) return;
    const start = now();
    p.onHandled?.(++handled);
    // The item may have changed since the message was written; the update goes in front of the message.
    await refreshItem(db, repo, n, { diff: p.diff });
    const parts = promptParts(db, repo, n);
    if (!parts) return;
    if (!checkouts.has(repo)) checkouts.set(repo, p.checkout(repo).catch(() => null));
    const checkout = await checkouts.get(repo)!;
    let shared: { name: string; dir: string }[] = [];
    if (checkout && p.shared) {
      sharedAll ??= p.shared().catch(() => []);
      shared = (await sharedAll).filter((x) => x.name !== repo).sort((a, b) => a.name.localeCompare(b.name));
    }
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let parsed: ReturnType<typeof parseReply> = null;
    for (let attempt = 0; attempt < CONVERSATION_PROMPT.limits.attempts && !parsed; attempt++) {
      const reply = await askClaude("conversation.turn", model, [{ ref: `${repo}#${n}`, item: parts.item, turns: parts.turns }], db, { checkout: checkout ?? undefined, shared });
      if (!reply) continue;
      usage = sum(usage, reply.usage);
      parsed = parseReply(db, repo, n, reply.text);
    }
    if (parsed) {
      storeReply(db, repo, n, wait.id, parsed.text, parsed.cards, parsed.notes);
      answered++;
    } else {
      failTurn(db, wait.id, "Opus gave no usable reply; send the message again");
      p.log(`conversation: no usable reply for ${repo}#${n}`);
    }
    saveUsage(db, p.usageRun, `conversation-${String(k).padStart(3, "0")}`, "conversation", model, 1, usage, start, now());
  }), () => claudeRoom(db), { first: true });
  return answered;
}

/** PR diffs from the diff cache or GitHub; null when unavailable. */
export const githubDiff: DiffSource = async (repo, n, head) => {
  const { cachedDiff, ghDiff } = await import("../review/diff.ts");
  const r = await cachedDiff(repo, n, head, ghDiff);
  return r.ok ? r.text : null;
};

/** The step's body: default checkouts (the item's default branch, the shared repositories) and diffs. Returns the answered count and the usage run id. */
export async function runConversations(db: DatabaseSync, p: { limit: number; onHandled?: (n: number) => void; cancelled?: () => boolean }, log: (line: string) => void = console.log): Promise<{ answered: number; waiting: number; usageRun: string }> {
  const usageRun = `conversation-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const waiting = pendingConversations(db).length;
  const answered = await answerPending(db, {
    ...p, usageRun, log, diff: githubDiff,
    checkout: (repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo)),
    shared: () => import("../sandbox/shared.ts").then((m) => m.sharedCheckouts(db, log)),
  });
  log(`conversation: ${answered} of ${waiting} messages answered`);
  return { answered, waiting, usageRun };
}
