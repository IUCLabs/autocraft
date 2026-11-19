// The class a queued user-local call ranks with in the claim order (calls.ts claimOrder, room.ts): calls a running step
// waits on go first, and small-tier calls rise across classes as they wait, so a long Opus backlog cannot hold them.
import type { Tier } from "./protocol.ts";
import { scaled } from "./time-scale.ts";

/** Calls a running step waits on before it can finish: follow-up turns (fix turns, check reminders, resumes) and lint checks. */
export const gating = (r: { parent_id: number | null; prompt_id: string }): boolean => r.parent_id !== null || r.prompt_id.startsWith("lint.");
/** The class gating calls rank with: above every step class (0 to 2). */
export const GATE_CLASS = 3;
/** A small-tier call ranks one class higher for each of these it has waited, up to the top step class, so a long Opus backlog cannot hold it. */
export const SMALL_AGING_MS = scaled(2 * 60_000);
/** The class a queued call ranks with in the claim order (queueOrder): gating calls first, small-tier calls aged across classes. */
export function claimClass(r: { cls: number; tier: Tier; since: number; parent_id: number | null; prompt_id: string }, nowMs: number): number {
  if (gating(r)) return GATE_CLASS;
  if (r.tier !== "small") return r.cls;
  return Math.max(r.cls, Math.min(2, r.cls + Math.floor(Math.max(0, nowMs - r.since) / SMALL_AGING_MS)));
}
