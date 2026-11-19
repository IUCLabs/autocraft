// Room in the user-local model queue: how many more calls may be made now. Each helper whose last status is `ready` and
// fresh (helpers.ts), and which is active (its last claim found nothing within IDLE_FRESH_MS, or it runs a lease that
// heartbeats), is room for its free slots: the slots it reported (its `--parallel` slots and the fast lane) less the leases
// its token holds. A user's helpers together count no more than the user's "Max calls at once" leaves (max-calls.ts). The
// queued calls that rank at or above the caller's class in the claim order (claim-class.ts) take room first. A helper
// held by its plan usage or paused stops asking for work and reports so; a helper that stopped without a word stops
// counting once its last claim and heartbeats are old.
import type { DatabaseSync } from "node:sqlite";
import { claimClass } from "./claim-class.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { userMaxCalls } from "./max-calls.ts";
import { HEARTBEAT_S, type Tier } from "./protocol.ts";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = 45_000;
/** A queued call whose caller has not polled for this long has lost its caller and is not counted or claimed. */
export const CALLER_STALE_MS = 30_000;
/** A lease whose last heartbeat is at most this old shows its helper is running (three heartbeats). */
const LIVE_LEASE_MS = 3 * HEARTBEAT_S * 1000;

export function remoteRoom(db: DatabaseSync, cls: number, nowMs: number = Date.now()): number {
  const helpers = db.prepare(`SELECT t.login, t.idle_claim_at, COALESCE(h.slots, 1) AS slots,
      (SELECT COUNT(*) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS leased,
      (SELECT MAX(c.heartbeat_at) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS beat
    FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.can_run = 1 AND t.expires_at > ? AND h.readiness = 'ready' AND h.reported_at >= ?`).all(new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as
    { login: string; idle_claim_at: number | null; slots: number; leased: number; beat: number | null }[];
  const free = new Map<string, number>();
  for (const h of helpers) {
    const active = (h.beat !== null && Number(h.beat) >= nowMs - LIVE_LEASE_MS) || (h.idle_claim_at !== null && Number(h.idle_claim_at) >= nowMs - IDLE_FRESH_MS);
    if (!active) continue;
    const key = h.login.toLowerCase();
    free.set(key, (free.get(key) ?? 0) + Math.max(0, Number(h.slots) - Number(h.leased)));
  }
  let room = 0;
  for (const [login, n] of free) {
    const max = userMaxCalls(db, login);
    const leased = max === null ? 0 : Number((db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'leased' AND user_login = ? COLLATE NOCASE").get(login) as { n: number }).n);
    room += max === null ? n : Math.min(n, Math.max(0, max - leased));
  }
  const queued = db.prepare("SELECT class AS cls, tier, since, parent_id, prompt_id FROM main.remote_calls WHERE state = 'queued' AND seen_at >= ?").all(nowMs - CALLER_STALE_MS) as
    { cls: number; tier: Tier; since: number; parent_id: number | null; prompt_id: string }[];
  const ahead = queued.filter((r) => claimClass(r, nowMs) >= cls).length;
  return Math.max(0, room - ahead);
}
