// Room in the user-local model queue: how many more calls may be made now. A helper whose last claim found nothing is
// idle; each idle helper token whose last status is `ready` and fresh (helpers.ts) is room for one call, less the calls
// already queued at or above the caller's class. A helper held by its plan usage or paused stops asking for work, but its
// last empty claim would count for a while without the status.
import type { DatabaseSync } from "node:sqlite";
import { STATUS_FRESH_MS } from "./helpers.ts";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = 45_000;
/** How often a waiting caller stamps its call's `seen_at` (it polls more often, but writes only this often). */
export const SEEN_EVERY_MS = 30_000;
/** A queued call whose caller has not stamped it for this long has lost its caller and is not counted or claimed: two stamps and some slack. */
export const CALLER_STALE_MS = 2 * SEEN_EVERY_MS + 15_000;

export function remoteRoom(db: DatabaseSync, cls: number, nowMs: number = Date.now()): number {
  const idle = (db.prepare(`SELECT COUNT(*) AS n FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.can_run = 1 AND t.idle_claim_at >= ? AND h.readiness = 'ready' AND h.reported_at >= ?`).get(nowMs - IDLE_FRESH_MS, nowMs - STATUS_FRESH_MS) as { n: number }).n;
  const ahead = (db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls INDEXED BY remote_calls_queued WHERE state = 'queued' AND class >= ? AND seen_at >= ?").get(cls, nowMs - CALLER_STALE_MS) as { n: number }).n;
  return Math.max(0, Number(idle) - Number(ahead));
}
