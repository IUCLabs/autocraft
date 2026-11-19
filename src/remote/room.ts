// Room in the user-local model queue: how many more calls may be made now. A helper whose last claim found nothing is
// idle; each idle helper token is room for one call, less the calls already queued at or above the caller's class.
import type { DatabaseSync } from "node:sqlite";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = 45_000;
/** A queued call whose caller has not polled for this long has lost its caller and is not counted or claimed. */
export const CALLER_STALE_MS = 30_000;

export function remoteRoom(db: DatabaseSync, cls: number, nowMs: number = Date.now()): number {
  const idle = (db.prepare("SELECT COUNT(*) AS n FROM main.mcp_tokens WHERE can_run = 1 AND idle_claim_at >= ?").get(nowMs - IDLE_FRESH_MS) as { n: number }).n;
  const ahead = (db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'queued' AND class >= ? AND seen_at >= ?").get(cls, nowMs - CALLER_STALE_MS) as { n: number }).n;
  return Math.max(0, Number(idle) - Number(ahead));
}
