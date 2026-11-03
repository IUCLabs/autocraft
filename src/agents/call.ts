// Starting a model call: picks the account (Claude) and records the agent run,
// in one transaction so two job processes cannot both take the last slot.
import type { DatabaseSync } from "node:sqlite";
import { chooseAccount, freeSlots, type Choice } from "./accounts.ts";
import { insertRun, type RunStart } from "./runs.ts";
import { scrubError } from "./text.ts";

/** Set by the job process: which job and step the calls belong to, and whether a cancel was asked. */
export type CallContext = { jobId: number; step: string; stage: number; cancelled(): boolean };
let context: CallContext | null = null;
export const setCallContext = (c: CallContext | null): void => void (context = c);
export const callContext = (): CallContext | null => context;

/** Step names for calls made outside a job (the classify and decide commands). */
const PROMPT_STEP: Record<string, { step: string; stage: number }> = {
  "classify.haiku": { step: "classify-new", stage: 2 }, "classify.jev": { step: "classify-new", stage: 2 }, "referee.sonnet": { step: "referee", stage: 2 },
  "decide.summary": { step: "decide", stage: 3 }, "review.sonnet": { step: "review-batch", stage: 5 }, "fixup.patch": { step: "fixup", stage: 6 }, "verify.plan": { step: "verify", stage: 6 },
  "verify.summary": { step: "verify-collect", stage: 6 }, "priority.jev": { step: "prioritize", stage: 2 }, "priority.haiku": { step: "prioritize", stage: 2 },
  "dupes.jev": { step: "dupes", stage: 3 }, "dupes.haiku": { step: "dupes", stage: 3 },
  "fixissue.triage": { step: "fixissue", stage: 7 }, "fixissue.patch": { step: "fixissue", stage: 7 }, "review.opus": { step: "opus-review", stage: 5 },
  "dupes.compare-prs.opus": { step: "dupes-compare", stage: 3 }, "dupes.compare-issues.sonnet": { step: "dupes-compare", stage: 3 },
  "decide.recommend": { step: "decide", stage: 3 }, "fixup.check": { step: "fixup", stage: 6 }, "fixissue.check": { step: "fixissue", stage: 7 },
  "conversation.turn": { step: "conversation", stage: 3 },
};

export function stepOf(promptId: string): { jobId: number | null; step: string; stage: number } {
  if (context) return { jobId: context.jobId, step: context.step, stage: context.stage };
  return { jobId: null, ...(PROMPT_STEP[promptId] ?? { step: "unknown", stage: 0 }) };
}

export const allocation = { pollMs: 3000, logEveryMs: 5 * 60_000 };

export class NoAccountError extends Error {}
export class CancelledError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Calls in this process that are waiting for a slot. */
let waiting = 0;

/** How many more Claude calls this process may start now: free slots on the enabled accounts, minus calls already waiting for one. */
export function claudeRoom(db: DatabaseSync): number {
  return Math.max(0, freeSlots(db) - waiting);
}

export type Started = { runId: number; configDir: string; accountId: string };

type RunInput = Omit<RunStart, "accountId" | "jobId" | "step" | "stage">;

/**
 * One attempt to take a slot: picks the account and records the running agent run
 * in a single BEGIN IMMEDIATE transaction, so job processes that choose at the
 * same time cannot both take the last slot. Returns why it could not, if it could not.
 */
export function tryStartClaudeRun(db: DatabaseSync, s: RunInput): Started | Exclude<Choice, { account: unknown }> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const c = chooseAccount(db);
    if (!("account" in c)) {
      db.exec("COMMIT");
      return c;
    }
    const runId = insertRun(db, { ...s, ...stepOf(s.promptId), accountId: c.account.id });
    db.exec("COMMIT");
    return { runId, configDir: c.account.configDir, accountId: c.account.id };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already committed */ }
    throw e;
  }
}

/** Waits for an enabled account with a free slot and headroom, then records the running agent run on it. */
export async function startClaudeRun(db: DatabaseSync, s: RunInput, log: (line: string) => void = console.log): Promise<Started> {
  let lastLog = 0;
  // Counted until the claim, and decremented in the same synchronous step as it, so claudeRoom() is exact right after a call starts.
  waiting++;
  try {
    for (;;) {
      const c = tryStartClaudeRun(db, s);
      if ("runId" in c) return c;
      if ("none" in c) throw new NoAccountError("no Claude account is enabled; an operator enables one on the Accounts page or with `autocraft accounts set <id> --enabled yes`");
      if (Date.now() - lastLog >= allocation.logEveryMs) {
        lastLog = Date.now();
        log(`waiting for a Claude account: ${scrubError(c.wait)}`);
      }
      if (context?.cancelled()) throw new CancelledError("cancelled while waiting for a Claude account");
      await sleep(allocation.pollMs);
      if (context?.cancelled()) throw new CancelledError("cancelled while waiting for a Claude account");
    }
  } finally {
    waiting--;
  }
}

/** Records a Jev call (no account, no slot). */
export function startJevRun(db: DatabaseSync, s: Omit<RunStart, "accountId" | "jobId" | "step" | "stage">): number {
  return insertRun(db, { ...s, ...stepOf(s.promptId), accountId: null });
}
