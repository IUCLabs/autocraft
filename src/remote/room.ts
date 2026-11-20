// Room in the user-local model queue: how many more calls may be made now. Each helper whose last status is `ready` and
// fresh (helpers.ts), and which is active (its last claim found nothing within IDLE_FRESH_MS, or it runs a lease that
// heartbeats), is room for its free slots: its `--parallel` slots (the fast lane is not counted, see remoteRoom) less the
// leases its token holds. A user's helpers together count no more than the user's "Max calls at once" leaves (max-calls.ts). The
// queued calls that rank at or above the caller's class in the claim order (claim-class.ts) take room first. A helper
// held by its plan usage or paused stops asking for work and reports so; a helper that stopped without a word stops
// counting once its last claim and heartbeats are old. The helpers of a Manual only user (manual-only.ts) take only the user's
// own picks and follow-ups, so they are no room.
import type { DatabaseSync } from "node:sqlite";
import { prep } from "../sql-cache.ts";
import { claimClass } from "./claim-class.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { manualSql } from "./manual-only.ts";
import { userMaxCalls } from "./max-calls.ts";
import { scaled } from "./time-scale.ts";
import { HEARTBEAT_S, type Tier } from "./protocol.ts";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = scaled(45_000);
/** How often a waiting caller stamps its call's `seen_at` (it polls more often, but writes only this often). */
export const SEEN_EVERY_MS = scaled(30_000);
/** A queued call whose caller has not stamped it for this long has lost its caller and is not counted or claimed: two stamps and some slack. */
export const CALLER_STALE_MS = 2 * SEEN_EVERY_MS + scaled(15_000);

/** A lease whose last heartbeat is at most this old shows its helper is running (three heartbeats). */
const LIVE_LEASE_MS = 3 * scaled(HEARTBEAT_S * 1000);

/**
 * Room for calls of class `cls`. A helper's fast-lane slot takes only small-tier and gating calls, and the planner does not
 * know which calls it is about to make, so the fast lane is not room. The status names no fast lane: a helper reporting 2
 * or more slots is taken to run one (work adds it to `--parallel N`, except for a harness that runs one call at a time,
 * which reports 1, and on macOS at `--parallel 16`, which this undercounts by one). A lease in the fast lane is not told
 * apart from the others', so it also undercounts by one while it runs.
 */
export function remoteRoom(db: DatabaseSync, cls: number, nowMs: number = Date.now()): number {
  const helpers = prep(db, `SELECT t.login, t.idle_claim_at, COALESCE(h.slots, 1) AS slots,
      (SELECT COUNT(*) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS leased,
      (SELECT MAX(c.heartbeat_at) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS beat
    FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.kind = 'runner' AND t.expires_at > ? AND h.readiness = 'ready' AND h.reported_at >= ? AND NOT ${manualSql("t.login")}`).all(new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as
    { login: string; idle_claim_at: number | null; slots: number; leased: number; beat: number | null }[];
  const free = new Map<string, number>();
  for (const h of helpers) {
    const active = (h.beat !== null && Number(h.beat) >= nowMs - LIVE_LEASE_MS) || (h.idle_claim_at !== null && Number(h.idle_claim_at) >= nowMs - IDLE_FRESH_MS);
    if (!active) continue;
    const key = h.login.toLowerCase();
    const slots = Number(h.slots) - (Number(h.slots) >= 2 ? 1 : 0);
    free.set(key, (free.get(key) ?? 0) + Math.max(0, slots - Number(h.leased)));
  }
  let room = 0;
  for (const [login, n] of free) {
    const max = userMaxCalls(db, login);
    const leased = max === null ? 0 : Number((prep(db, "SELECT COUNT(*) AS n FROM main.remote_calls INDEXED BY remote_calls_leased WHERE state = 'leased' AND user_login = ? COLLATE NOCASE").get(login) as { n: number }).n);
    room += max === null ? n : Math.min(n, Math.max(0, max - leased));
  }
  const queued = prep(db, "SELECT class AS cls, tier, since, parent_id, prompt_id FROM main.remote_calls INDEXED BY remote_calls_waiting WHERE state = 'queued' AND seen_at >= ?").all(nowMs - CALLER_STALE_MS) as
    { cls: number; tier: Tier; since: number; parent_id: number | null; prompt_id: string }[];
  const ahead = queued.filter((r) => claimClass(r, nowMs) >= cls).length;
  return Math.max(0, room - ahead);
}
