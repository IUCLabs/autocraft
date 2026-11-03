// The Conversation step: answers each operator message that waits for Opus with one sandboxed `claude -p` call
// (the item's repository and the workspace, read-only) and stores the reply with its action cards.
import { referenceDir } from "../reference.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { PROGRESS_KEEP, coalesce } from "../classify/progress.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { defaultSemanticDeps, referenceProblems, type SemanticDeps } from "../reference-lint.ts";
import { dropTexts, type Lint } from "../replylint.ts";
import { commentTexts, parseReply } from "./cards.ts";
import { sweepRunningCards } from "./act.ts";
import { claimPending, failTurn, pendingConversations, promptParts, refreshItem, setTurnProgress, storeReply, type DiffSource } from "./store.ts";

export const CONVERSATION_PROMPT = CLAUDE_PROMPTS["conversation.turn"];

export type ConversationParams = {
  /** Most messages to answer in this run. */
  limit?: number;
  model?: string;
  /** Read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  diff?: DiffSource;
  usageRun: string;
  onHandled?: (n: number) => void;
  cancelled?: () => boolean;
  log: (line: string) => void;
  /** The Jev and Haiku calls of the semantic reference check; absent: the real ones. */
  semantic?: SemanticDeps;
};

const now = () => new Date().toISOString();
const sum = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0) });

/** Answers the waiting messages, oldest first. Returns how many got a reply. */
export async function answerPending(db: DatabaseSync, p: ConversationParams): Promise<number> {
  const model = p.model ?? CONVERSATION_PROMPT.models[0]!;
  let todo = pendingConversations(db);
  if (p.limit !== undefined) todo = todo.slice(0, Math.max(0, p.limit));
  const checkouts = new Map<string, Promise<string | null>>();
  let answered = 0, handled = 0;
  await pool(todo.map((c, k) => async () => {
    if (p.cancelled?.()) return;
    const { repo, number: n } = c;
    const start = now();
    // The item may have changed since the message was written; the update goes in front of the message.
    await refreshItem(db, repo, n, { diff: p.diff });
    // One run holds the message; another run or a second start skips it.
    const held = claimPending(db, repo, n);
    if (!held) return;
    const { turn: wait, claim } = held;
    p.onHandled?.(++handled);
    const parts = promptParts(db, repo, n, wait);
    if (!parts) { failTurn(db, repo, n, claim, "the conversation has no item block; send the message again"); return; }
    if (!checkouts.has(repo)) checkouts.set(repo, p.checkout(repo).catch(() => null));
    const checkout = await checkouts.get(repo)!;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let parsed: ReturnType<typeof parseReply> = null;
    // The latest few lines go on the message's row, at most one write a second.
    let recent: string[] = [];
    const shown = coalesce((lines: string[]) => setTurnProgress(db, repo, n, claim, lines));
    const onProgress = (line: string) => {
      if (recent.at(-1) === line) return;
      recent = [...recent, line].slice(-PROGRESS_KEEP);
      shown.push(recent);
    };
    const dir = referenceDir(repo);
    const semantic = dir ? p.semantic ?? defaultSemanticDeps(db, `${repo}#${n}`) : undefined;
    // Comment cards are public text: a reference mention or quote goes back to the model as one fix turn. A reply without text is not linted and keeps the whole-call retry.
    const lint: Lint = async (text, stage) => (parseReply(db, repo, n, text) ? referenceProblems(commentTexts(text), dir, semantic, { stage }) : null);
    for (let attempt = 0; attempt < CONVERSATION_PROMPT.limits.attempts && !parsed; attempt++) {
      const reply = await askClaude("conversation.turn", model, [{ ref: `${repo}#${n}`, item: parts.item, turns: parts.turns, ...(checkout && { repo_dir: REPO_PATH }) }], db, { checkout: checkout ?? undefined, reference: checkout ? dir : undefined, onProgress, lint });
      shown.flush();
      if (!reply) continue;
      usage = sum(usage, reply.usage);
      if (reply.fixTurn) p.log(`conversation: ${repo}#${n}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`);
      parsed = parseReply(db, repo, n, reply.text, dropTexts(reply.problems));
    }
    if (parsed) {
      if (storeReply(db, repo, n, claim, parsed.text, parsed.cards, parsed.notes) !== null) answered++;
    } else {
      failTurn(db, repo, n, claim, "Opus gave no usable reply; send the message again");
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

/** The step's body: the item's default checkout (the workspace comes with the prompt) and diffs. Returns the answered count and the usage run id. */
export async function runConversations(db: DatabaseSync, p: { limit: number; onHandled?: (n: number) => void; cancelled?: () => boolean }, log: (line: string) => void = console.log): Promise<{ answered: number; waiting: number; usageRun: string }> {
  sweepRunningCards(db);
  const usageRun = `conversation-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const waiting = pendingConversations(db).length;
  const answered = await answerPending(db, {
    ...p, usageRun, log, diff: githubDiff,
    checkout: (repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo)),
  });
  log(`conversation: ${answered} of ${waiting} messages answered`);
  return { answered, waiting, usageRun };
}
