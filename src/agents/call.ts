// Starting a model call: picks the account (Claude) and records the agent run,
// in one transaction so two job processes cannot both take the last slot.
import type { DatabaseSync } from "node:sqlite";
import { chooseAccount } from "./accounts.ts";
import { insertRun, type RunStart } from "./runs.ts";
import { scrubError } from "./text.ts";

/** Set by the job process: which job and step the calls belong to, and whether a cancel was asked. */
export type CallContext = { jobId: number; step: string; stage: number; cancelled(): boolean };
let context: CallContext | null = null;
export const setCallContext = (c: CallContext | null): void => void (context = c);
export const callContext = (): CallContext | null => context;

/** Step names for calls made outside a job (the classify and decide commands). */
const PROMPT_STEP: Record<string, { step: string; stage: number }> = {
  "classify.haiku": { step: "classify-new", stage: 2 }, "classify.jev": { step: "classify-new", stage: 2 }, "referee.sonnet": { step: "classify-all", stage: 2 },
  "decide.summary": { step: "decide", stage: 3 }, "review.sonnet": { step: "review-batch", stage: 5 },
};

export function stepOf(promptId: string): { jobId: number | null; step: string; stage: number } {
  if (context) return { jobId: context.jobId, step: context.step, stage: context.stage };
  return { jobId: null, ...(PROMPT_STEP[promptId] ?? { step: "unknown", stage: 0 }) };
}

export const allocation = { pollMs: 3000, logEveryMs: 5 * 60_000 };

export class NoAccountError extends Error {}
export class CancelledError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Started = { runId: number; configDir: string; accountId: string };

/** Waits for an enabled account with a free slot and headroom, then records the running agent run on it. */
export async function startClaudeRun(db: DatabaseSync, s: Omit<RunStart, "accountId" | "jobId" | "step" | "stage">, log: (line: string) => void = console.log): Promise<Started> {
  let lastLog = 0;
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const c = chooseAccount(db);
      if ("account" in c) {
        const runId = insertRun(db, { ...s, ...stepOf(s.promptId), accountId: c.account.id });
        db.exec("COMMIT");
        return { runId, configDir: c.account.configDir, accountId: c.account.id };
      }
      db.exec("COMMIT");
      if ("none" in c) throw new NoAccountError("no Claude account is enabled; an operator enables one on the Accounts page or with `craft-auto accounts set <id> --enabled yes`");
      if (Date.now() - lastLog >= allocation.logEveryMs) {
        lastLog = Date.now();
        log(`waiting for a Claude account: ${scrubError(c.wait)}`);
      }
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already committed */ }
      throw e;
    }
    if (context?.cancelled()) throw new CancelledError("cancelled while waiting for a Claude account");
    await sleep(allocation.pollMs);
    if (context?.cancelled()) throw new CancelledError("cancelled while waiting for a Claude account");
  }
}

/** Records a Jev call (no account, no slot). */
export function startJevRun(db: DatabaseSync, s: Omit<RunStart, "accountId" | "jobId" | "step" | "stage">): number {
  return insertRun(db, { ...s, ...stepOf(s.promptId), accountId: null });
}
