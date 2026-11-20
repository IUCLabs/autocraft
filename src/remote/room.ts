// Room in the user-local model queue: how many more calls may be made now. Each helper whose last status is `ready` and
// fresh (helpers.ts), and which is active (its last claim found nothing within IDLE_FRESH_MS, or it runs a lease that
// heartbeats), is room for its free slots: its `--parallel` slots (the fast lane is not counted, see remoteRoom) less the
// leases its token holds. Only helpers that may take a call naming the caller's repos count (runnerTakes: the role rules, write
// permission, My repos narrowed by the helper's own list). A user's helpers together count no more than the user's "Max calls
// at once" leaves (max-calls.ts). The queued calls that rank at or above the caller's class in the claim order (claim-class.ts)
// and that a counted helper may take come first. A helper held by its plan usage or paused stops asking for work and reports
// so; a helper that stopped without a word stops counting once its last claim and heartbeats are old. The helpers of a Manual
// only user (manual-only.ts) take only the user's own picks and follow-ups, so they are no room.
import type { DatabaseSync } from "node:sqlite";
import { prep } from "../sql-cache.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { queueSnapshot, runnerTakes } from "./calls.ts";
import { claimClass } from "./claim-class.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { manualSql } from "./manual-only.ts";
import { userMaxCalls } from "./max-calls.ts";
import { claimRepos } from "./my-repos.ts";
import { scaled } from "./time-scale.ts";
import { HEARTBEAT_S } from "./protocol.ts";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = scaled(45_000);
/** How often a waiting caller stamps its call's `seen_at` (it polls more often, but writes only this often). */
export const SEEN_EVERY_MS = scaled(30_000);
/** A queued call whose caller has not stamped it for this long has lost its caller and is not counted or claimed: two stamps and some slack. */
export const CALLER_STALE_MS = 2 * SEEN_EVERY_MS + scaled(15_000);

/** A lease whose last heartbeat is at most this old shows its helper is running (three heartbeats). */
const LIVE_LEASE_MS = 3 * scaled(HEARTBEAT_S * 1000);

/**
 * Room for calls of class `cls` that name `repos` (undefined: any repo, every helper counts; empty: no repo, which only
 * operators take). A helper's fast-lane slot takes only small-tier and gating calls, and the planner does not
 * know which calls it is about to make, so the fast lane is not room. The status names no fast lane: a helper reporting 2
 * or more slots is taken to run one (work adds it to `--parallel N`, except for a harness that runs one call at a time,
 * which reports 1, and on macOS at `--parallel 16`, which this undercounts by one). A lease in the fast lane is not told
 * apart from the others', so it also undercounts by one while it runs.
 *
 * Write permission is the cached one (repo_permissions, roomCanWrite): only a non-write permission confirmed within
 * PERM_READ_TTL leaves a user out. A user with no fresh row for a repo counts for it, so a repo nobody's claim has looked at
 * lately still gets calls; the claim then checks the permission itself. The helper's repos are those of its last idle claim
 * (`idle_repos`) narrowed by the user's current My repos.
 */
export function remoteRoom(db: DatabaseSync, cls: number, nowMs: number = Date.now(), repos?: readonly string[]): number {
  return roomOf(db, roomState(db, nowMs), cls, nowMs, repos);
}

/**
 * Whether each of `logins` counts as able to write to a repo for the room: true unless a non-write permission confirmed within
 * PERM_READ_TTL is cached. One query for every login.
 */
export function roomCanWrite(db: DatabaseSync, logins: readonly string[], nowMs: number): (login: string, repo: string) => boolean {
  const denied = new Set<string>();
  for (const p of prep(db, "SELECT login, repo, permission, checked_at FROM main.repo_permissions WHERE login IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(logins)])) as { login: string; repo: string; permission: string; checked_at: string }[])
    if (!WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) denied.add(`${p.login.toLowerCase()}\n${p.repo}`);
  return (login, repo) => !denied.has(`${login.toLowerCase()}\n${repo}`);
}

type Helper = { login: string; role: string | null; idle_claim_at: number | null; idle_repos: string | null; slots: number; leased: number; beat: number | null };
type Taker = { h: Helper; r: { login: string; role: string; repos: ReadonlySet<string> | null } };
/** What the room reads of the helpers, once for any number of room questions at one moment: the active helpers, and on first use their permissions, repos and users' caps. */
export type RoomState = { active: Helper[]; takers?: { list: Taker[]; canWrite: (login: string, repo: string) => boolean }; left: Map<string, number> };

export function roomState(db: DatabaseSync, nowMs: number = Date.now()): RoomState {
  const rows = prep(db, `SELECT t.login, a.role, t.idle_claim_at, t.idle_repos, COALESCE(h.slots, 1) AS slots,
      (SELECT COUNT(*) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS leased,
      (SELECT MAX(c.heartbeat_at) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS beat
    FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id LEFT JOIN main.access a ON a.login = t.login
    WHERE t.kind = 'runner' AND t.expires_at > ? AND h.readiness = 'ready' AND h.reported_at >= ? AND NOT ${manualSql("t.login")}`).all(new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as Helper[];
  return { active: rows.filter((h) => (h.beat !== null && Number(h.beat) >= nowMs - LIVE_LEASE_MS) || (h.idle_claim_at !== null && Number(h.idle_claim_at) >= nowMs - IDLE_FRESH_MS)), left: new Map() };
}

/** Room for class `cls` and `repos` (see remoteRoom) from a state read at `nowMs`. */
export function roomOf(db: DatabaseSync, st: RoomState, cls: number, nowMs: number, repos?: readonly string[]): number {
  let takers = st.active;
  let takes: (c: { prompt_id: string; repos: readonly string[] }) => boolean = () => true;
  if (repos !== undefined && st.active.length) {
    const t = st.takers ??= {
      canWrite: roomCanWrite(db, st.active.map((h) => h.login), nowMs),
      list: st.active.map((h) => {
        let own: string[] | undefined;
        try { own = h.idle_repos ? JSON.parse(h.idle_repos) as string[] : undefined; } catch { /* every repo */ }
        return { h, r: { login: h.login, role: h.role ?? "", repos: claimRepos(db, h.login, own) } };
      }),
    };
    const fit = t.list.filter(({ r }) => runnerTakes(r, { prompt_id: "", repos }, t.canWrite));
    takers = fit.map((x) => x.h);
    takes = (c) => fit.some(({ r }) => runnerTakes(r, c, t.canWrite));
  }
  const free = new Map<string, number>();
  for (const h of takers) {
    const key = h.login.toLowerCase();
    const slots = Number(h.slots) - (Number(h.slots) >= 2 ? 1 : 0);
    free.set(key, (free.get(key) ?? 0) + Math.max(0, slots - Number(h.leased)));
  }
  let room = 0;
  for (const [login, n] of free) {
    let left = st.left.get(login);
    if (left === undefined) {
      const max = userMaxCalls(db, login);
      left = max === null ? Infinity : Math.max(0, max - Number((prep(db, "SELECT COUNT(*) AS n FROM main.remote_calls INDEXED BY remote_calls_leased WHERE state = 'leased' AND user_login = ? COLLATE NOCASE").get(login) as { n: number }).n));
      st.left.set(login, left);
    }
    room += Math.min(n, left);
  }
  if (room === 0) return 0;
  const ahead = queueSnapshot(db, nowMs).filter((r) => r.seen_at >= nowMs - CALLER_STALE_MS && claimClass(r, nowMs) >= cls && takes(r)).length;
  return Math.max(0, room - ahead);
}
