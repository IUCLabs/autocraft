// Remote calls of the user-local inference mode. The calling process (askClaude, src/classify/run.ts) inserts a call
// and polls its row; a maintainer's helper claims it with an agent token that may run tasks, fetches the bundle and
// sends heartbeats and the reply with the lease secret (routes in src/dash/server/index.ts, wire format in protocol.ts).
// Leases are checked by the calling process on each poll and by every claim; the dashboard deletes old rows once a minute (pruneRemote).
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "../../web/src/api/types.ts";
import { allocation, callQueue, queueOrder, stepOf, throwIfHalted, WaitLimitError, type Waiter } from "../agents/call.ts";
import { finishRun, insertRun, setRunProgress } from "../agents/runs.ts";
import { saveRemoteTools } from "../agents/tools.ts";
import { scrubError } from "../agents/text.ts";
import type { Usage } from "../classify/run.ts";
import { randomToken, sha256hex } from "../dash/server/crypto.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { fillHarness, rootArgs, validRoot } from "../prompts/harness.ts";
import { rootAgents } from "../sandbox/agents.ts";
import { joinParts } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { cooloffOf, noteDrop, noteFailure, noteSuccess, pruneCooloffs } from "./cooloff.ts";
import { dashboardAlive } from "./liveness.ts";
import { acceptedModels, familyOf, isEffort, isTier, meetsEffort, minEfforts, TIERS } from "./mode.ts";
import { ACCEPTED_PROTOCOLS, CLAIM_ID_TTL_S, HEARTBEAT_S, PREPARE_MAX_S, ROUTES, type Claim, type ClaimReply, type HarnessId, type Heartbeat, type Release, type Submit, type SubmitReply, type TaskBundle, type Tier } from "./protocol.ts";
import { claimRepos } from "./my-repos.ts";
import { userMaxCalls } from "./max-calls.ts";
import { claimClass, gating } from "./claim-class.ts";
import { userReserve } from "./reserve.ts";
import { scaled, scaledS } from "./time-scale.ts";
import { CALLER_STALE_MS, IDLE_FRESH_MS, SEEN_EVERY_MS } from "./room.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { manualOnly, manualSql } from "./manual-only.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { endChecks, serveChecks } from "./check-relay.ts";
import type { CheckTool } from "../checktool/index.ts";

/** A lease with no heartbeat for this long, while the dashboard was serving (liveness.ts), goes back to the queue. */
export const LEASE_IDLE_MS = scaled(2 * 60_000);
/** A lease also ends this long after the bundle's own time limit, counted from its first `running` heartbeat. */
export const LEASE_MARGIN_MS = scaled(2 * 60_000);
/**
 * How long a follow-up turn waits for the helper that holds its session before the caller falls back to a fresh call, while
 * that login runs no live lease. While it does (the helper is busy, and its fast lane takes the turn as soon as it is free),
 * the turn waits up to STICKY_CAP_MS.
 */
export const STICKY_MS = LEASE_IDLE_MS;
export const STICKY_CAP_MS = scaled(15 * 60_000);
/** A lease counts as live for a waiting follow-up while its last heartbeat is at most this old (three heartbeats). */
const STICKY_LIVE_MS = 3 * scaled(HEARTBEAT_S * 1000);
/** A call whose caller has not polled for this long has lost it (the process died): the call fails. */
export const CALLER_GONE_MS = scaled(5 * 60_000);
/** Seconds a helper waits before claiming again when nothing could be taken. */
export const CLAIM_RETRY_S = scaledS(15);
/** The oldest helper version that may run a lease. */
export const REQUIRED_HELPER = "1.2.0";
/** A call this login released is not offered to it again for this long (its helper could not run it). */
export const RELEASE_SKIP_MS = scaled(10 * 60_000);
/**
 * The most queue time the runner leaves out of a job's deadline and no-progress stop. Helpers run on people's own machines
 * across time zones, so a call may wait out a night with nobody online; past 12 hours the call is unlikely to be taken at all
 * (no eligible helper: the only maintainers authored the item), and the job is stopped so it no longer holds its item.
 */
export const REMOTE_WAIT_CAP_MS = 12 * 3600_000;
/** Ended calls are kept this long (task status, follow-up lookups), then deleted. */
const KEEP_MS = 24 * 3600_000;
const LEASE_PREFIX = "aclease_";
const PROGRESS_MAX = 200;
const REPLY_MAX = 4_000_000;

/** Prompts that judge an item: an author or co-author of an item they judge gets their calls only when no other helper that could take them is asking for work. */
const JUDGING = new Set(["review.opus", "premerge.opus", "postmerge.opus", "fixup.check", "fixissue.check", "decide.prepare", "conversation.turn", "verify.compare", "classify.haiku", "security.verify", "security.fixcheck"]);
export const judges = (promptId: string): boolean => JUDGING.has(promptId) || promptId.startsWith("dupes.compare-");

/** What a helper's fast-lane slot takes: gating calls (its own sessions' follow-ups among them) and small-tier calls. */
const fastLaneFits = (r: { tier: Tier; parent_id: number | null; prompt_id: string }): boolean => gating(r) || r.tier === "small";

type Row = {
  id: number; job_id: number | null; step: string; stage: number; run_id: number | null; prompt_id: string; prompt_version: string;
  tier: Tier; effort: string; asked_model: string; bundle: string; state: "queued" | "leased" | "done" | "failed"; items: string; repo: string | null;
  cls: number; level: number; since: number; seen_at: number; queued_since: number | null; queued_ms: number;
  user_login: string | null; harness: string | null; model: string | null; leased_at: number | null; heartbeat_at: number | null; started_at: number | null;
  token_id: number | null; lease_secret_hash: string | null;
  attempt: number; max_attempts: number; timeout_ms: number; parent_id: number | null; sticky_login: string | null; progress: string | null;
  reply: string | null; usage: string | null; turns: number | null; session_id: string | null; error: string | null; root: string | null;
};
const COLS = "id, job_id, step, stage, run_id, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class AS cls, level, since, seen_at, queued_since, queued_ms, user_login, harness, model, leased_at, heartbeat_at, started_at, token_id, lease_secret_hash, attempt, max_attempts, timeout_ms, parent_id, sticky_login, progress, reply, usage, turns, session_id, error, root";
const rowOf = (db: DatabaseSync, id: number): Row | undefined => db.prepare(`SELECT ${COLS} FROM main.remote_calls WHERE id = ?`).get(id) as Row | undefined;

export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string;
  bundle: Omit<TaskBundle, "callId">; items: ItemRef[]; level: number; maxAttempts: number;
  /** A follow-up turn on the session of this call. */
  parentId?: number;
  /** The repo whose reference documentation the call's reference tools search (when its bundle lists REFERENCE_SERVER). */
  referenceRepo?: string;
};

/** Queues a call for the current job and step; a follow-up is offered only to the helper of the parent's lease holder. */
export function enqueueCall(db: DatabaseSync, c: NewCall, nowMs: number = Date.now()): number {
  const s = stepOf(c.promptId), q = callQueue(c.promptId);
  const sticky = c.parentId === undefined ? null : (db.prepare("SELECT user_login FROM main.remote_calls WHERE id = ?").get(c.parentId) as { user_login: string | null } | undefined)?.user_login ?? null;
  const authors = judges(c.promptId) ? JSON.stringify(authorsOf(db, c.items)) : "[]";
  const id = Number(db.prepare(`INSERT INTO main.remote_calls (job_id, step, stage, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class, level, since, seen_at, queued_since, max_attempts, timeout_ms, parent_id, sticky_login, reference_repo, authors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.jobId, s.step, s.stage, c.promptId, c.promptVersion, c.tier, c.effort, c.askedModel, JSON.stringify(c.bundle), JSON.stringify(c.items), q.repo, q.cls, c.level, nowMs, nowMs, nowMs,
      Math.max(1, c.maxAttempts), c.bundle.timeoutSeconds * 1000, c.parentId ?? null, sticky, c.referenceRepo ?? null, authors).lastInsertRowid);
  dropQueueCache(db);
  return id;
}

/** Ends a call that is in one of `states` as failed; true when it did. A leased call's agent run fails with it. */
export function withdrawCall(db: DatabaseSync, id: number, reason: string, states: ("queued" | "leased")[] = ["queued", "leased"], nowMs: number = Date.now()): boolean {
  const r = db.prepare(`UPDATE main.remote_calls SET state = 'failed', error = ?, ended_at = ?, queued_ms = queued_ms + CASE WHEN queued_since IS NULL THEN 0 ELSE MAX(0, ? - queued_since) END, queued_since = NULL
    WHERE id = ? AND state IN (${states.map(() => "?").join(", ")}) RETURNING run_id`).get(reason, nowMs, nowMs, id, ...states) as { run_id: number | null } | undefined;
  if (!r) return false;
  if (r.run_id !== null) finishRun(db, r.run_id, { state: "failed", error: reason, summary: "withdrawn" });
  return true;
}

/** Withdraws the open calls of a job that ended, or of every job (the runner restarted); calls made outside a job are left to their caller. */
export function withdrawJobCalls(db: DatabaseSync, reason: string, jobId?: number): number {
  const ids = (jobId === undefined
    ? db.prepare("SELECT id FROM main.remote_calls WHERE state IN ('queued', 'leased') AND job_id IS NOT NULL").all()
    : db.prepare("SELECT id FROM main.remote_calls WHERE state IN ('queued', 'leased') AND job_id = ?").all(jobId)) as { id: number }[];
  return ids.filter((r) => withdrawCall(db, Number(r.id), reason)).length;
}

/** Keeps the secret hash of a lease that just ended or went back to the queue, so its routes answer 410 (leaseState); kept as long as ended calls (pruneRemote). */
function bury(db: DatabaseSync, id: number, hash: string | null, nowMs: number): void {
  if (hash === null) return;
  db.prepare("INSERT OR IGNORE INTO main.remote_lease_tombstones (secret_hash, call_id, at) VALUES (?, ?, ?)").run(hash, id, nowMs);
}

/**
 * A lost or failed lease goes back to the queue with the next attempt, or fails once the prompt's attempts are used up.
 * `skipLogin`: the login whose helper failed the call is not offered it again for RELEASE_SKIP_MS.
 */
function requeue(db: DatabaseSync, r: Pick<Row, "id" | "run_id" | "attempt" | "max_attempts" | "leased_at" | "lease_secret_hash">, reason: string, nowMs: number, opts: { skipLogin?: string; summary?: string } = {}): boolean {
  const fail = r.attempt >= r.max_attempts;
  const skip = opts.skipLogin ?? null;
  // Compare and set: only the lease that was read ends, so two processes that saw it expire end it once.
  const up = db.prepare(`UPDATE main.remote_calls SET state = ?, attempt = attempt + ?, lease_secret_hash = NULL, token_id = NULL, claim_id = NULL, started_at = NULL, queued_since = ?, ended_at = ?, error = ?, progress = NULL, picked_by = NULL, picked_at = NULL, pick_until = NULL,
      released_by = COALESCE(?, released_by), released_at = CASE WHEN ? IS NULL THEN released_at ELSE ? END
    WHERE id = ? AND state = 'leased' AND attempt = ? AND leased_at IS ?`).run(fail ? "failed" : "queued", fail ? 0 : 1, fail ? null : nowMs, fail ? nowMs : null, reason, skip, skip, nowMs, r.id, r.attempt, r.leased_at);
  if (Number(up.changes) !== 1) return false;
  dropQueueCache(db);
  bury(db, r.id, r.lease_secret_hash, nowMs);
  if (r.run_id !== null) finishRun(db, r.run_id, { state: "failed", error: reason, summary: opts.summary ?? "lease ended" });
  return true;
}

/** Puts a leased call back in the queue without using an attempt (released by its helper, or its token lost the right to run it). */
function unlease(db: DatabaseSync, r: { id: number; runId: number | null; hash: string | null }, why: string, nowMs: number, releasedBy: string | null = null): void {
  const up = db.prepare(`UPDATE main.remote_calls SET state = 'queued', lease_secret_hash = NULL, token_id = NULL, claim_id = NULL, started_at = NULL, queued_since = ?, error = ?, progress = NULL, picked_by = NULL, picked_at = NULL, pick_until = NULL, released_by = COALESCE(?, released_by), released_at = CASE WHEN ? IS NULL THEN released_at ELSE ? END
    WHERE id = ? AND state = 'leased' AND lease_secret_hash IS ?`).run(nowMs, why, releasedBy, releasedBy, nowMs, r.id, r.hash);
  if (Number(up.changes) !== 1) return;
  dropQueueCache(db);
  bury(db, r.id, r.hash, nowMs);
  if (r.runId !== null) finishRun(db, r.runId, { state: "failed", error: why, summary: "returned to the queue" });
}

/**
 * The failure backoff of remote calls (registered in src/stages/registry.ts): a lease with no heartbeat for LEASE_IDLE_MS, a
 * lease still preparing PREPARE_MAX_S after the claim, or one running past its time limit plus LEASE_MARGIN_MS goes back to
 * the queue (attempt + 1, up to the prompt's attempts); a call whose caller stopped polling fails. Leases end only while the
 * dashboard serves, and for lack of heartbeats only when it served for the whole idle window (liveness.ts): helpers reach
 * the server only through it. The lost lease counts toward its login's cool-off. Run by each claim (every call) and by the
 * caller's poll (`id`: that call only); old rows go with pruneRemote.
 */
export function expireLeases(db: DatabaseSync, nowMs: number = Date.now(), id?: number): void {
  const one = id === undefined ? "" : " AND id = ?";
  const live = dashboardAlive(db, nowMs);
  if (live.alive) {
    const idle = live.since <= nowMs - LEASE_IDLE_MS ? 1 : 0;
    const lost = db.prepare(`SELECT id, run_id, attempt, max_attempts, heartbeat_at, leased_at, started_at, timeout_ms, token_id, user_login, lease_secret_hash FROM main.remote_calls
      WHERE state = 'leased' AND ((? AND heartbeat_at < ?) OR (started_at IS NULL AND leased_at + ? < ?) OR (started_at IS NOT NULL AND started_at + timeout_ms + ? < ?))${one}`)
      .all(idle, nowMs - LEASE_IDLE_MS, scaled(PREPARE_MAX_S * 1000), nowMs, LEASE_MARGIN_MS, nowMs, ...(id === undefined ? [] : [id])) as Row[];
    for (const r of lost) {
      const why = idle && Number(r.heartbeat_at) < nowMs - LEASE_IDLE_MS ? `lease expired: no heartbeat for ${Math.round(LEASE_IDLE_MS / 1000)} s`
        : r.started_at === null ? `lease expired: still preparing ${Math.round(scaled(PREPARE_MAX_S * 1000) / 1000)} s after the claim` : "lease expired: past the call's time limit";
      // A lost lease counts toward its login's cool-off (cooloff.ts), and uses an attempt like a failed call. A lease that never
      // had a heartbeat does not count: the helper most likely never got the claim's reply.
      const beaten = Number(r.heartbeat_at) > Number(r.leased_at);
      if (requeue(db, r, why, nowMs) && beaten && r.token_id !== null && r.user_login !== null) noteDrop(db, Number(r.token_id), r.user_login, nowMs);
    }
  }
  const gone = db.prepare(`SELECT id FROM main.remote_calls WHERE state IN ('queued', 'leased') AND seen_at < ?${one}`).all(nowMs - CALLER_GONE_MS, ...(id === undefined ? [] : [id])) as { id: number }[];
  for (const r of gone) withdrawCall(db, Number(r.id), "the caller stopped waiting", undefined, nowMs);
}

/**
 * Deletes ended calls, finished check relays and lease tombstones older than KEEP_MS, lease drops and cool-offs that no
 * longer count (cooloff.ts), and the last status of deleted tokens. The dashboard runs it once a minute.
 */
export function pruneRemote(db: DatabaseSync, nowMs: number = Date.now()): void {
  const old = nowMs - KEEP_MS;
  // Each condition is a range of the (state, ended_at) indexes; a row without ended_at goes by when it began.
  db.prepare("DELETE FROM main.remote_calls WHERE state IN ('done', 'failed') AND ended_at < ?").run(old);
  db.prepare("DELETE FROM main.remote_calls WHERE state IN ('done', 'failed') AND ended_at IS NULL AND since < ?").run(old);
  db.prepare("DELETE FROM main.remote_checks WHERE state = 'done' AND ended_at < ?").run(old);
  db.prepare("DELETE FROM main.remote_checks WHERE state = 'done' AND ended_at IS NULL AND requested_at < ?").run(old);
  db.prepare("DELETE FROM main.remote_lease_tombstones WHERE at < ?").run(old);
  pruneCooloffs(db, nowMs);
  db.prepare("DELETE FROM main.remote_helpers WHERE NOT EXISTS (SELECT 1 FROM main.mcp_tokens t WHERE t.id = remote_helpers.token_id)").run();
}

/** The call a lease secret belongs to while its lease is live (expired leases are ended first), or null. For the per-lease routes: bundle, heartbeat, submit, the task MCP servers and the tarball. */
export function liveLease(db: DatabaseSync, secret: string | undefined, nowMs: number = Date.now()): { id: number; jobId: number | null; runId: number | null; login: string; promptId: string; items: ItemRef[]; repo: string | null; root: string | null } | null {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const found = db.prepare("SELECT id FROM main.remote_calls WHERE lease_secret_hash = ? AND state = 'leased'").get(hash) as { id: number } | undefined;
  if (!found) return null;
  expireLeases(db, nowMs, Number(found.id));
  // The lease lives only while the token that claimed it may still run tasks and its login is still a maintainer or operator.
  const r = db.prepare(`SELECT c.id, c.job_id, c.run_id, c.user_login, c.prompt_id, c.items, c.repo, c.root, a.login AS ok FROM main.remote_calls c
      LEFT JOIN main.mcp_tokens t ON t.id = c.token_id AND t.can_run = 1 AND t.expires_at > ?
      LEFT JOIN main.access a ON a.login = t.login AND a.role IN ('maintainer', 'operator')
    WHERE c.id = ? AND c.lease_secret_hash = ? AND c.state = 'leased'`).get(new Date(nowMs).toISOString(), found.id, hash) as
    { id: number; job_id: number | null; run_id: number | null; user_login: string; prompt_id: string; items: string; repo: string | null; root: string | null; ok: string | null } | undefined;
  if (r && r.ok === null) {
    unlease(db, { id: Number(r.id), runId: r.run_id, hash }, "returned to the queue: the token that claimed it may no longer run tasks", nowMs);
    return null;
  }
  return r ? { id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo, root: r.root } : null;
}

/**
 * The call a lease secret was issued for, whether its lease is live or has ended (submitted, failed, expired, released or
 * requeued: the tombstones), or null for a secret never issued. The lease routes answer 410 for an ended lease and 401 only for null.
 */
export function leaseState(db: DatabaseSync, secret: string | undefined): { id: number; live: boolean } | null {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const r = db.prepare("SELECT id, state FROM main.remote_calls WHERE lease_secret_hash = ?").get(hash) as { id: number; state: Row["state"] } | undefined;
  if (r) return { id: Number(r.id), live: r.state === "leased" };
  const t = db.prepare("SELECT call_id FROM main.remote_lease_tombstones WHERE secret_hash = ?").get(hash) as { call_id: number } | undefined;
  return t ? { id: Number(t.call_id), live: false } : null;
}

// ---- claims ------------------------------------------------------------------------

export type Caller = { tokenId: number; login: string; role: Role };

const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/** The lowercase logins that authored any of the items, or authored or co-authored (a Co-authored-by trailer, as GitHub lists the commit's authors) a commit of one. */
export function authorsOf(db: DatabaseSync, refs: readonly ItemRef[]): string[] {
  if (!refs.length) return [];
  const item = db.prepare("SELECT author FROM main.items WHERE repo = ? AND number = ? AND author IS NOT NULL");
  const commits = db.prepare("SELECT author, co_authors FROM main.pr_commits WHERE repo = ? AND number = ?");
  const out = new Set<string>();
  for (const r of refs) {
    const a = item.get(r.repo, r.number) as { author: string } | undefined;
    if (a) out.add(a.author.toLowerCase());
    for (const c of commits.all(r.repo, r.number) as { author: string | null; co_authors: string | null }[]) {
      if (c.author) out.add(c.author.toLowerCase());
      let co: unknown = [];
      try { co = c.co_authors ? JSON.parse(c.co_authors) : []; } catch { /* not JSON: no co-authors */ }
      if (Array.isArray(co)) for (const x of co) if (typeof x === "string") out.add(x.toLowerCase());
    }
  }
  return [...out];
}

/** A queued call as claims read it: the items parsed, the repos it names and its authors. */
type Cand = Waiter & Pick<Row, "prompt_id" | "tier" | "parent_id" | "sticky_login" | "seen_at"> & {
  refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>; releasedBy: string | null; releasedAt: number | null;
  /** The lowercase login of the call's pick ("Run on my Task Runner", picks.ts), when it has one, live or not (pickCounts). */
  pickedBy: string | null; pickedAt: number | null; pickUntil: number | null;
  /** Ends the call's pick; set while it has one. */
  unpick?: () => void;
};

/** The role rules: maintainers and operators; discord.* calls and calls that name no repo go to operators only. */
export const roleFits = (role: string, c: Pick<Cand, "prompt_id" | "repos">): boolean =>
  (role === "operator" || role === "maintainer") && !((c.prompt_id.startsWith("discord.") || !c.repos.length) && role !== "operator");

type IdleHelper = { login: string; role: string; tiers: ReadonlySet<string>; only: ReadonlySet<string> | null };

/**
 * Whether a login other than the caller could take a call now: its helper's last claim found nothing within IDLE_FRESH_MS
 * and the login is not Manual only (manual-only.ts),
 * that claim covered the call's tier and repos, the login fits the role rules, its cached write permission covers every repo
 * and it authored no item of the call. A state check made at each claim; nothing waits on it. The idle helpers and their
 * permissions are read once per claim, on the first call that needs them.
 */
function idleOthers(db: DatabaseSync, login: string, nowMs: number): (c: Cand) => boolean {
  let idle: IdleHelper[] | null = null;
  // The cached write permissions of the idle logins, read in one query with the idle helpers.
  const writable = new Set<string>();
  const canWrite = (who: string, repo: string): boolean => writable.has(`${who.toLowerCase()}\n${repo}`);
  // The idle helpers that could take a call of this tier, prompt kind and repos, apart from authorship: calls share them.
  const takers = new Map<string, string[]>();
  return (c) => {
    if (!idle) {
      idle = (db.prepare(`SELECT t.login, a.role, t.idle_tiers, t.idle_repos FROM main.mcp_tokens t JOIN main.access a ON a.login = t.login
          WHERE t.can_run = 1 AND t.expires_at > ? AND t.idle_claim_at >= ? AND t.login <> ? COLLATE NOCASE AND NOT ${manualSql("t.login")}`).all(new Date(nowMs).toISOString(), nowMs - IDLE_FRESH_MS, login) as
        { login: string; role: string; idle_tiers: string | null; idle_repos: string | null }[])
        .map((o) => ({ login: o.login, role: o.role, tiers: new Set(o.idle_tiers ? JSON.parse(o.idle_tiers) as string[] : []), only: o.idle_repos ? new Set(JSON.parse(o.idle_repos) as string[]) : null }));
      for (const p of db.prepare("SELECT login, repo, permission, checked_at FROM main.repo_permissions WHERE login IN (SELECT value FROM json_each(?))").all(JSON.stringify(idle.map((o) => o.login))) as { login: string; repo: string; permission: string; checked_at: string }[])
        if (WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) writable.add(`${p.login.toLowerCase()}\n${p.repo}`);
    }
    const key = `${c.tier}\n${c.prompt_id.startsWith("discord.")}\n${c.repos.join("\n")}`;
    let logins = takers.get(key);
    if (!logins) {
      logins = idle.filter((o) => o.tiers.has(c.tier) && (!o.only || c.repos.every((x) => o.only!.has(x))) && roleFits(o.role, c) && c.repos.every((x) => canWrite(o.login, x))).map((o) => o.login.toLowerCase());
      takers.set(key, logins);
    }
    return logins.some((l) => !c.authors.has(l));
  };
}

/**
 * Who may take a call: a maintainer or operator with write permission on every repo of the call (which covers reading a
 * private one); discord.* calls and calls that name no repo go to operators only. An author or co-author of an item a judging
 * prompt judges is passed over only while another helper that could take the call is asking for work (idleOthers).
 */
async function eligible(caller: Caller, c: Cand, canWrite: (repo: string) => Promise<boolean>, othersIdle: (c: Cand) => boolean): Promise<boolean> {
  const ok = await mayTake(caller, c, canWrite, othersIdle);
  // The caller's own pick of a call it may no longer take ends: it would hold the call from every other user.
  if (!ok && c.pickedBy === caller.login.toLowerCase()) c.unpick?.();
  return ok;
}

async function mayTake(caller: Caller, c: Cand, canWrite: (repo: string) => Promise<boolean>, othersIdle: (c: Cand) => boolean): Promise<boolean> {
  if (!roleFits(caller.role, c)) return false;
  for (const repo of c.repos) if (!(await canWrite(repo))) return false;
  return !(judges(c.prompt_id) && c.authors.has(caller.login.toLowerCase()) && othersIdle(c));
}

const HARNESSES: HarnessId[] = ["claude", "codex"];
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** The claim body, checked; throws HttpError 400 for a malformed one and 409 for a protocol version outside ACCEPTED_PROTOCOLS. */
export function parseClaim(raw: unknown): Claim {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Claim object");
  const c = raw as Record<string, unknown>;
  if (typeof c.protocol !== "number" || !ACCEPTED_PROTOCOLS.includes(c.protocol)) throw new HttpError(409, `this server speaks protocol ${ACCEPTED_PROTOCOLS.join(" or ")}; update the helper`);
  const protocol = c.protocol;
  if (!HARNESSES.includes(c.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  if (!short(c.helperVersion, 40) || !short(c.harnessVersion, 80)) throw new HttpError(400, "helperVersion and harnessVersion must be short strings");
  if (!c.tiers || typeof c.tiers !== "object" || Array.isArray(c.tiers)) throw new HttpError(400, "tiers must map a tier to a model");
  const tiers: Claim["tiers"] = {};
  for (const [t, m] of Object.entries(c.tiers as Record<string, unknown>)) {
    if (!isTier(t) || !short(m, 100)) throw new HttpError(400, `tier ${t}: a known tier with a model name`);
    tiers[t] = m;
  }
  let efforts: Claim["efforts"];
  if (c.efforts !== undefined) {
    if (!c.efforts || typeof c.efforts !== "object" || Array.isArray(c.efforts) || !Object.entries(c.efforts).every(([t, e]) => isTier(t) && isEffort(e))) throw new HttpError(400, "efforts must map a tier to an effort of the ladder low, medium, high, xhigh, max");
    efforts = c.efforts as Claim["efforts"];
  }
  if (c.repos !== undefined && (!Array.isArray(c.repos) || c.repos.length > 500 || !c.repos.every((x) => short(x, 100)))) throw new HttpError(400, "repos must be a list of repo names");
  if (c.sessions !== undefined && (!Array.isArray(c.sessions) || c.sessions.length > 500 || !c.sessions.every((x) => Number.isInteger(x)))) throw new HttpError(400, "sessions must be a list of call ids");
  if (c.root !== undefined && (typeof c.root !== "string" || !validRoot(c.root))) throw new HttpError(400, "root must be an absolute path of plain characters (letters, digits, . _ + @ -) without . or .. components");
  if (typeof c.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.requestId)) throw new HttpError(400, "requestId must be 8 to 64 letters, digits, - or _");
  if (c.fastLane !== undefined && typeof c.fastLane !== "boolean") throw new HttpError(400, "fastLane must be a boolean");
  // Protocol 3 helpers know no wait; a field they might send is not read.
  const wait = protocol >= 4 ? c.wait : undefined;
  if (wait !== undefined && (!Number.isInteger(wait) || (wait as number) < 0 || (wait as number) > 30)) throw new HttpError(400, "wait must be whole seconds from 0 to 30");
  return { requestId: c.requestId, ...(c.fastLane === true && { fastLane: true }), ...(wait !== undefined && { wait: wait as number }), protocol, helperVersion: c.helperVersion, harness: c.harness as HarnessId, harnessVersion: c.harnessVersion, tiers, ...(efforts && { efforts }), ...(c.repos !== undefined && { repos: c.repos as string[] }), ...(c.sessions !== undefined && { sessions: c.sessions as number[] }), ...(c.root !== undefined && { root: c.root as string }) };
}

/** Whether dotted version `v` is older than `min` (numeric parts compared in order; a part that is not a number counts as 0). */
export function olderVersion(v: string, min: string): boolean {
  const a = v.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0), b = min.split(".").map((x) => Number(x));
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i]!;
  return false;
}

/** One line for the lease: the prompt and its first item. */
function titleOf(promptId: string, refs: ItemRef[]): string {
  if (!refs.length) return promptId;
  return `${promptId} on ${refs[0]!.repo}#${refs[0]!.number}${refs.length > 1 ? ` (+${refs.length - 1})` : ""}`;
}

/** The calls the login's helpers hold leases on now, all helpers together. */
const leasedBy = (db: DatabaseSync, login: string): number =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'leased' AND user_login = ? COLLATE NOCASE").get(login) as { n: number }).n);

/**
 * Leases the call to the caller if it is still queued and no other user's pick counts for it (a Manual only caller: only
 * its own pick or a follow-up); the pick ends with the lease. The agent run starts now, on no account, with the user and
 * harness. With `cap`, only while the login holds fewer leases than that (checked in the same transaction, so parallel claims
 * of one user cannot pass it together); "limit" when it holds that many.
 */
function leaseCall(db: DatabaseSync, id: number, caller: Caller, claim: Claim, model: string, nowMs: number, cap: number | null = null): Extract<ClaimReply, { lease: object }>["lease"] | "limit" | null {
  const secret = `${LEASE_PREFIX}${randomToken(32)}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (cap !== null && leasedBy(db, caller.login) >= cap) {
      db.exec("COMMIT");
      return "limit";
    }
    const r = db.prepare(`UPDATE main.remote_calls SET state = 'leased', token_id = ?, user_login = ?, harness = ?, harness_version = ?, model = ?, root = ?, lease_secret_hash = ?, leased_at = ?, heartbeat_at = ?, started_at = NULL, claim_id = ?,
        queued_ms = queued_ms + CASE WHEN queued_since IS NULL THEN 0 ELSE MAX(0, ? - queued_since) END, queued_since = NULL, progress = NULL, error = NULL,
        picked_by = NULL, picked_at = NULL, pick_until = NULL
      WHERE id = ? AND state = 'queued' AND (picked_by IS NULL OR picked_by = ? OR ${pickLapsedSql}) AND (? = 0 OR parent_id IS NOT NULL OR picked_by = ?) RETURNING ${COLS}`)
      .get(caller.tokenId, caller.login, claim.harness, claim.harnessVersion, model, claim.root ?? null, sha256hex(secret), nowMs, nowMs, claim.requestId, nowMs, id,
        caller.login, ...pickLapsedArgs(nowMs), manualOnly(db, caller.login) ? 1 : 0, caller.login) as Row | undefined;
    if (!r) {
      db.exec("COMMIT");
      return null;
    }
    const b = forHarness(JSON.parse(r.bundle) as Omit<TaskBundle, "callId">, claim.harness, r.root ?? "");
    const refs = JSON.parse(r.items) as ItemRef[];
    const runId = insertRun(db, { jobId: r.job_id, step: r.step, stage: r.stage, promptId: r.prompt_id, promptVersion: r.prompt_version, provider: "claude", model: r.asked_model, accountId: null, items: refs, prompt: joinParts(b) });
    db.prepare("UPDATE main.agent_runs SET user_login = ?, harness = ?, reported_model = ? WHERE id = ?").run(caller.login, claim.harness, model, runId);
    db.prepare("UPDATE main.remote_calls SET run_id = ? WHERE id = ?").run(runId, id);
    db.exec("COMMIT");
    return { id, secret, title: titleOf(r.prompt_id, refs), requiredHelper: REQUIRED_HELPER };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already committed */ }
    throw e;
  }
}

/**
 * How long claims reuse the queued calls in queue order (queueOrder) before reading them again. The order, small-tier aging
 * across classes (claimClass) included, is taken when the cache is built, so it is at most this old.
 */
export const QUEUE_CACHE_MS = 2_000;
type QueueCache = { at: number; sig: string; followUps: Cand[]; ordered: Cand[] };
const queueCaches = new WeakMap<DatabaseSync, QueueCache>();
/** The parsed items, repos and authors of each queued call by id: they never change, so a rebuild reads them only for new calls. */
type Parsed = Pick<Cand, "refs" | "repos" | "authors">;
const parsedCalls = new WeakMap<DatabaseSync, Map<number, Parsed>>();
/** Drops the cached queue order: a call was queued or leased by this process. Other processes' changes show in the signature (count and newest id of the queued calls) or within QUEUE_CACHE_MS. */
export const dropQueueCache = (db: DatabaseSync): void => void queueCaches.delete(db);
/** The signature of the queued calls as queuedCalls reads it from the table: their count and newest id. */
const queueSig = (n: number, m: number | null): string => `${n}:${m}`;
/**
 * Takes a call this process just leased out of the cached queue order, so a burst of claims does not rebuild the order
 * after every lease; the signature follows, so the cache stays valid while no other process changed the queue.
 */
function takeFromQueueCache(db: DatabaseSync, id: number): void {
  const c = queueCaches.get(db);
  if (!c) return;
  const drop = (l: Cand[]): boolean => { const i = l.findIndex((r) => r.id === id); if (i >= 0) l.splice(i, 1); return i >= 0; };
  if (!drop(c.followUps) && !drop(c.ordered)) return dropQueueCache(db);
  let m: number | null = null;
  for (const r of c.followUps) if (m === null || r.id > m) m = r.id;
  for (const r of c.ordered) if (m === null || r.id > m) m = r.id;
  c.sig = queueSig(c.followUps.length + c.ordered.length, m);
}

/** Every queued call, read once per QUEUE_CACHE_MS: follow-ups by age, the rest in queue order. Callers filter it and must not change it; only takeFromQueueCache does. */
function queuedCalls(db: DatabaseSync, nowMs: number): QueueCache {
  const q = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS m FROM main.remote_calls WHERE state = 'queued'").get() as { n: number; m: number | null };
  const sig = queueSig(Number(q.n), q.m === null ? null : Number(q.m));
  const hit = queueCaches.get(db);
  if (hit && hit.sig === sig && nowMs >= hit.at && nowMs - hit.at < QUEUE_CACHE_MS) return hit;
  const known = parsedCalls.get(db) ?? new Map<number, Parsed>(), seen = new Map<number, Parsed>();
  const extra = db.prepare("SELECT items, authors FROM main.remote_calls WHERE id = ?");
  const rows = (db.prepare(`SELECT id, class AS cls, level, step, repo, since, seen_at, prompt_id, tier, parent_id, sticky_login, released_by, released_at, picked_by, picked_at, pick_until
      FROM main.remote_calls INDEXED BY remote_calls_waiting WHERE state = 'queued'`).all() as
    (Waiter & Pick<Row, "prompt_id" | "tier" | "parent_id" | "sticky_login" | "seen_at"> & { released_by: string | null; released_at: number | null; picked_by: string | null; picked_at: number | null; pick_until: number | null })[])
    .map((r): Cand => {
      const id = Number(r.id);
      let p = known.get(id);
      if (!p) {
        const x = extra.get(id) as { items: string; authors: string | null };
        const refs = JSON.parse(x.items) as ItemRef[];
        // Calls queued before authors were stored on the row are read now.
        const authors = x.authors !== null ? JSON.parse(x.authors) as string[] : judges(r.prompt_id) ? authorsOf(db, refs) : [];
        p = { refs, repos: [...new Set([...refs.map((i) => i.repo), ...(r.repo ? [r.repo] : [])])], authors: new Set(authors) };
      }
      seen.set(id, p);
      return {
        id, cls: r.cls, level: r.level, step: r.step, repo: r.repo, since: r.since, seen_at: r.seen_at, prompt_id: r.prompt_id, tier: r.tier, parent_id: r.parent_id, sticky_login: r.sticky_login,
        ...p, releasedBy: r.released_by?.toLowerCase() ?? null, releasedAt: r.released_at,
        pickedBy: r.picked_by?.toLowerCase() ?? null, pickedAt: r.picked_at, pickUntil: r.pick_until,
        ...(r.picked_by !== null && { unpick: () => void clearPick(db, id) }),
      };
    });
  parsedCalls.set(db, seen);
  const c: QueueCache = {
    at: nowMs, sig,
    followUps: rows.filter((r) => r.parent_id !== null).sort((a, b) => a.since - b.since || a.id - b.id),
    ordered: queueOrder(db, nowMs, rows.filter((r) => r.parent_id === null), (r) => claimClass(r, nowMs)),
  };
  queueCaches.set(db, c);
  return c;
}

/** Every queued call in queue order (follow-ups first), as claims read it: for the queue view (queue-view.ts). Read only. */
export function queueSnapshot(db: DatabaseSync, nowMs: number): readonly Readonly<Cand>[] {
  const q = queuedCalls(db, nowMs);
  return [...q.followUps, ...q.ordered];
}

/**
 * The queued calls a claim could take in the order it takes them, before eligibility: follow-up turns of the sessions its
 * helper holds first, then the user's own live picks (picks.ts) oldest first, then the model queue's order with gating and
 * long-waiting small calls raised (claimClass) and without other users' live picks, filtered by tiers and repos (claimRepos:
 * every repo a call names must be in the set; picks do not go by it). A fast-lane claim gets only what fastLaneFits. A Manual
 * only user (manual-only.ts) gets no calls from the queue's order. The caller's pick of a call it released or whose role
 * rules it no longer fits ends here; one it may not take for another reason ends in eligible.
 */
function claimOrder(db: DatabaseSync, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number, fastLane = false): Cand[] {
  const q = queuedCalls(db, nowMs);
  const login = caller.login.toLowerCase();
  const live = (r: Cand): boolean => r.seen_at >= nowMs - CALLER_STALE_MS;
  const released = (r: Cand): boolean => r.releasedBy === login && r.releasedAt !== null && r.releasedAt >= nowMs - RELEASE_SKIP_MS;
  const fits = (r: Cand): boolean => live(r) && !released(r) && tiers.has(r.tier) && (!repos || r.repos.every((x) => repos.has(x)));
  const sessions = new Set(sessionIds);
  const followUps = q.followUps.filter((r) => sessions.has(r.parent_id!) && sameLogin(r.sticky_login, caller.login) && fits(r));
  let fresh: Set<string> | null = null;
  // The caller claims, so its own runners are fresh; other pickers' are read once, when a pick needs it.
  const counts = (r: Cand): boolean => pickCounts(r, nowMs, (who) => who === login || (fresh ??= freshRunnerLogins(db, nowMs)).has(who));
  const mine: Cand[] = [];
  for (const r of q.ordered) {
    if (r.pickedBy !== login || !counts(r)) continue;
    if (released(r) || !roleFits(caller.role, r)) clearPick(db, r.id);
    else if (live(r) && tiers.has(r.tier) && (!fastLane || fastLaneFits(r))) mine.push(r);
  }
  mine.sort((a, b) => a.pickedAt! - b.pickedAt! || a.id - b.id);
  if (manualOnly(db, caller.login)) return [...followUps, ...mine];
  return [...followUps, ...mine, ...q.ordered.filter((r) => fits(r) && !(r.pickedBy !== null && counts(r)) && (!fastLane || fastLaneFits(r)))];
}

// ---- picks ("Run on my Task Runner", picks.ts) ----------------------------------------

/**
 * SQL on a remote_calls row that has a pick: the pick no longer counts, as its time is up or none of the picker's Task
 * Runners is fresh (its last status is older than STATUS_FRESH_MS). Bind pickLapsedArgs.
 */
export const pickLapsedSql = `(pick_until < ? OR NOT EXISTS (SELECT 1 FROM main.remote_helpers ph JOIN main.mcp_tokens pt ON pt.id = ph.token_id
  WHERE ph.login = remote_calls.picked_by AND pt.kind = 'runner' AND pt.expires_at > ? AND ph.reported_at >= ?))`;
export const pickLapsedArgs = (nowMs: number): [number, string, number] => [nowMs, new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS];

/** The logins (lowercase) with a fresh Task Runner: only their picks count. */
export function freshRunnerLogins(db: DatabaseSync, nowMs: number): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT lower(h.login) AS login FROM main.remote_helpers h JOIN main.mcp_tokens t ON t.id = h.token_id
    WHERE t.kind = 'runner' AND t.expires_at > ? AND h.reported_at >= ?`).all(new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as { login: string }[];
  return new Set(rows.map((r) => r.login));
}

/** Whether a queued call's pick counts now: it has one, its time is not up (no time: until it ends) and its picker has a fresh Task Runner. */
export const pickCounts = (r: { pickedBy: string | null; pickUntil: number | null }, nowMs: number, fresh: (login: string) => boolean): boolean =>
  r.pickedBy !== null && (r.pickUntil === null || r.pickUntil >= nowMs) && fresh(r.pickedBy.toLowerCase());

/** Ends a queued call's pick (only `login`'s, when given); true when one ended. */
export function clearPick(db: DatabaseSync, id: number, login?: string): boolean {
  const r = login === undefined
    ? db.prepare("UPDATE main.remote_calls SET picked_by = NULL, picked_at = NULL, pick_until = NULL WHERE id = ? AND picked_by IS NOT NULL").run(id)
    : db.prepare("UPDATE main.remote_calls SET picked_by = NULL, picked_at = NULL, pick_until = NULL WHERE id = ? AND picked_by = ?").run(id, login);
  if (Number(r.changes) !== 1) return false;
  dropQueueCache(db);
  return true;
}

/** Memoises the caller's write permission per repo; a failed lookup counts as no permission. */
const memoWrite = (canWrite: (repo: string) => Promise<boolean>): ((repo: string) => Promise<boolean>) => {
  const memo = new Map<string, Promise<boolean>>();
  return (repo) => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = canWrite(repo).catch(() => false)));
    return p;
  };
};

/** How many queued calls the caller could claim now (same filters and eligibility as claimCall, nothing is leased), for a session's next_task. Follow-ups of a helper's own sessions are not counted. */
export async function claimableCalls(db: DatabaseSync, caller: Caller, opts: { tiers?: readonly Tier[]; models?: Partial<Record<Tier, string>> }, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<number> {
  expireLeases(db, nowMs);
  if (cooloffOf(db, caller.login, nowMs) !== null) return 0;
  const max = userMaxCalls(db, caller.login);
  if (max !== null && leasedBy(db, caller.login) >= max) return 0;
  const accepted = acceptedModels(db);
  // A tier counts when the model the helper would use for it is of an accepted family; without a model, when the tier accepts any.
  const tiers = new Set((opts.tiers ?? TIERS).filter((t) => accepted[t].length > 0 && (opts.models?.[t] === undefined || familyOf(opts.models[t]!, accepted[t]) !== null)));
  const can = memoWrite(canWrite), others = idleOthers(db, caller.login, nowMs);
  let n = 0;
  for (const r of claimOrder(db, caller, tiers, claimRepos(db, caller.login, undefined), [], nowMs)) if (await eligible(caller, r, can, others)) n++;
  return n;
}

/** The state of a call this login holds or held (by its lease id); null for an unknown call and for another login's. */
export function callStatus(db: DatabaseSync, id: number, login: string): { id: number; state: Row["state"]; error: string | null; title: string } | null {
  const r = db.prepare("SELECT id, state, error, prompt_id, items, user_login FROM main.remote_calls WHERE id = ?").get(id) as { id: number; state: Row["state"]; error: string | null; prompt_id: string; items: string; user_login: string | null } | undefined;
  if (!r || !sameLogin(r.user_login, login)) return null;
  return { id: Number(r.id), state: r.state, error: r.error, title: titleOf(r.prompt_id, JSON.parse(r.items) as ItemRef[]) };
}

/**
 * Claim replies by agent token and request id, for CLAIM_ID_TTL_S: a repeated claim (its reply was lost) gets the same reply,
 * the same lease with the same secret included. Kept in the memory of the dashboard process, the only one that serves
 * claims, so the secret is never stored; the promise is kept from the start, so a repeat that arrives while the first is
 * still being answered waits for it.
 */
const claimReplies = new Map<string, { at: number; reply: Promise<ClaimReply> }>();

/**
 * Gives the caller the first queued call it may take (claimOrder), filtered by eligibility. `canWrite` reads the caller's live
 * write permission on a repo. The reply carries the user's reserve either way. A claim repeated with the same request id
 * gets the first one's reply. While the login's leases are at the user's "Max calls at once" (max-calls.ts), only a follow-up
 * of its own sessions is leased, one past the limit at most, so a session can finish; otherwise the reply says why.
 */
export function claimCall(db: DatabaseSync, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<ClaimReply> {
  // Entries are in claim order, so the expired ones come first.
  for (const [k, v] of claimReplies) { if (v.at >= nowMs - scaled(CLAIM_ID_TTL_S * 1000)) break; claimReplies.delete(k); }
  const key = `${caller.tokenId}:${claim.requestId}`;
  const seen = claimReplies.get(key);
  if (seen) return seen.reply;
  const reply = claimNew(db, caller, claim, canWrite, nowMs);
  claimReplies.set(key, { at: nowMs, reply });
  reply.catch(() => { if (claimReplies.get(key)?.reply === reply) claimReplies.delete(key); });
  return reply;
}

async function claimNew(db: DatabaseSync, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number): Promise<ClaimReply> {
  if (olderVersion(claim.helperVersion, REQUIRED_HELPER)) throw new HttpError(409, `helper ${claim.helperVersion} is older than ${REQUIRED_HELPER}, the oldest this server accepts; download the current helper from ${ROUTES.helper}`);
  // A repeat the dashboard no longer remembers (it restarted in between): the lease the first claim took cannot be given
  // out again, as only its secret's hash is stored, so it goes back to the queue unused and this claim is answered afresh.
  const orphan = db.prepare("SELECT id, run_id, lease_secret_hash FROM main.remote_calls WHERE token_id = ? AND claim_id = ? AND state = 'leased'").get(caller.tokenId, claim.requestId) as { id: number; run_id: number | null; lease_secret_hash: string | null } | undefined;
  if (orphan) unlease(db, { id: Number(orphan.id), runId: orphan.run_id, hash: orphan.lease_secret_hash }, "returned to the queue: the claim that leased it was repeated after a server restart", nowMs);
  expireLeases(db, nowMs);
  const cooled = cooloffOf(db, caller.login, nowMs);
  if (cooled) return { lease: null, retryAfter: Math.ceil((cooled.until - nowMs) / 1000), reason: cooled.reason, until: cooled.until, reserve: userReserve(db, caller.login) };
  const accepted = acceptedModels(db), floors = minEfforts(db);
  const tiers = new Set((Object.keys(claim.tiers) as Tier[]).filter((t) => familyOf(claim.tiers[t]!, accepted[t]) !== null && meetsEffort(claim.efforts?.[t], floors[t], claim.harness)));
  if (!tiers.size) throw new HttpError(400, `no tier of the claim has an accepted model at the minimum effort; accepted: ${(Object.keys(accepted) as Tier[]).map((t) => `${t} ${accepted[t].join("/")}${floors[t] ? ` at effort ${floors[t]} or higher` : ""}`).join(", ")}`);
  const can = memoWrite(canWrite), others = idleOthers(db, caller.login, nowMs);
  const repos = claimRepos(db, caller.login, claim.repos);
  const fast = claim.fastLane === true;
  const max = userMaxCalls(db, caller.login);
  const atLimit = (): ClaimReply => ({ lease: null, retryAfter: CLAIM_RETRY_S, reason: `your helpers run ${max} calls, your limit of calls at once (Connect page, My settings)`, reserve: userReserve(db, caller.login) });
  const full = max !== null && leasedBy(db, caller.login) >= max;
  let limited = full;
  for (const r of claimOrder(db, caller, tiers, repos, claim.sessions ?? [], nowMs, fast)) {
    // Only follow-ups of the helper's own sessions carry a parent here (claimOrder).
    if (full && r.parent_id === null) continue;
    if (!(await eligible(caller, r, can, others))) continue;
    const lease = leaseCall(db, Number(r.id), caller, claim, claim.tiers[r.tier]!, Date.now(), max === null ? null : r.parent_id !== null ? max + 1 : max);
    if (lease === "limit") {
      limited = true;
      continue;
    }
    if (!lease) continue;
    takeFromQueueCache(db, Number(r.id));
    // The fast lane says nothing about the helper's other slots: only their claims mark it idle or busy.
    if (!fast) db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = NULL WHERE id = ?").run(caller.tokenId);
    return { lease, reserve: userReserve(db, caller.login) };
  }
  if (limited) return atLimit();
  if (fast) return { lease: null, retryAfter: CLAIM_RETRY_S, reserve: userReserve(db, caller.login) };
  // An idle helper, with what it takes (the user's picks narrowed by the helper's list): an author's claim gives way to it (idleOthers).
  db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = ?, idle_tiers = ?, idle_repos = ? WHERE id = ?").run(nowMs, JSON.stringify([...tiers]), repos ? JSON.stringify([...repos]) : null, caller.tokenId);
  return { lease: null, retryAfter: CLAIM_RETRY_S, reserve: userReserve(db, caller.login) };
}

// ---- lease routes ------------------------------------------------------------------

/**
 * A queued bundle as one harness reads it: the marked harness phrases of its text, and of the `claude` hints that carry the
 * system prompt, filled in. With the claim's path root (a macOS helper) the marked sandbox paths, the path arguments of the
 * hints and the explorer's prompt name the same paths below it; the mounts keep the fixed paths, which the helper places
 * below its root itself.
 */
export function forHarness<B extends Omit<TaskBundle, "callId">>(b: B, harness: HarnessId, root = ""): B {
  const claude = b.hints.claude;
  return {
    ...b, stdin: fillHarness(b.stdin, harness, root), system: b.system === null ? null : fillHarness(b.system, harness, root),
    hints: { ...b.hints, ...(claude && { claude: { ...claude, args: rootArgs(claude.args.map((a) => fillHarness(a, "claude", root)), root), ...(claude.agents !== undefined && { agents: rootAgents(claude.agents, root) }) } }) },
  };
}

/** Reply or progress text with the claim's path root taken off, so paths read as the fixed sandbox paths the rest of the server expects (`/repo/src/a.rs`). */
const unrooted = (text: string, root: string | null): string => (root ? text.split(root).join("") : text);
/** A JSON value (the reply's tool uses) with the claim's path root taken off every string in it; the root is plain characters, so its JSON form is itself. */
const rootless = (v: unknown, root: string | null): unknown => (root && v !== undefined ? JSON.parse(unrooted(JSON.stringify(v), root)) as unknown : v);

/** The task bundle of a live lease, worded for the harness that claimed it, or null. */
export function bundleOf(db: DatabaseSync, secret: string | undefined): TaskBundle | null {
  const l = liveLease(db, secret);
  if (!l) return null;
  const r = db.prepare("SELECT bundle, harness FROM main.remote_calls WHERE id = ?").get(l.id) as { bundle: string; harness: HarnessId };
  return { ...forHarness(JSON.parse(r.bundle) as Omit<TaskBundle, "callId">, r.harness, l.root ?? ""), callId: l.id };
}

/** A plain one-line progress text from the helper: control characters removed, scrubbed, cut. */
const progressLine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? scrub(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, PROGRESS_MAX) : null);

/** Records a heartbeat; the first `running` one starts the call's time limit. False when the lease is gone (the route answers 410). */
export function heartbeat(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const h = raw as Partial<Heartbeat> | undefined;
  const line = progressLine(typeof h?.progress === "string" ? unrooted(h.progress, l.root) : h?.progress);
  db.prepare("UPDATE main.remote_calls SET heartbeat_at = ?, progress = COALESCE(?, progress), started_at = CASE WHEN ? AND started_at IS NULL THEN ? ELSE started_at END WHERE id = ?")
    .run(nowMs, line, h?.phase === "running" ? 1 : 0, nowMs, l.id);
  if (line && l.runId !== null) setRunProgress(db, l.runId, line);
  return true;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function usageOf(raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return { input: count(u.inputTokens), output: count(u.outputTokens), cacheRead: count(u.cacheReadTokens), cacheWrite: count(u.cacheWriteTokens) };
}

/** Tokens as stored in the `usage` column (usageOf's shape). */
const storedTokens = (v: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } => {
  const u = (v ?? {}) as Record<string, unknown>;
  return { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
};

/**
 * Takes a helper's result; null when the lease is gone (the route answers 410). A repeat of an accepted reply (the first
 * answer was lost) is accepted again. A reply from another model than the claim declared for the tier, and a failed reply
 * (`ok: false`), send the call back to the queue with its next attempt, not offered to that login for a while, and count
 * toward the login's cool-off; the call fails once its attempts are used up.
 */
export function submitCall(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): SubmitReply | null {
  const l = liveLease(db, secret, nowMs);
  const gone = (): SubmitReply | null => {
    const done = secret?.startsWith(LEASE_PREFIX) && db.prepare("SELECT 1 FROM main.remote_calls WHERE lease_secret_hash = ? AND state = 'done'").get(sha256hex(secret));
    return done ? { accepted: true } : null;
  };
  if (!l) return gone();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Submit object");
  const s = raw as Submit;
  const usage = usageOf((s as { usage?: unknown }).usage);
  const duration = count((s as { durationMs?: unknown }).durationMs);
  if (s.ok === true) {
    if (typeof s.text !== "string" || s.text.length > REPLY_MAX) throw new HttpError(400, "text must be the reply as a string");
    if (typeof s.model !== "string") throw new HttpError(400, "model must name the model that ran");
    const r = rowOf(db, l.id)!;
    const families = acceptedModels(db)[r.tier];
    const family = familyOf(r.model ?? "", families);
    if (family === null || familyOf(s.model, families) !== family) {
      if (requeue(db, r, `the harness reported model ${s.model.slice(0, 100)}, not the ${family ?? r.model} family claimed for the tier`, nowMs, { skipLogin: l.login, summary: "refused" })) noteFailure(db, l.login, nowMs);
      return { accepted: false, reason: `the claim declared ${r.model} for this tier` };
    }
    const byModel: Record<string, ReturnType<typeof usageOf>> = {};
    const mu = (s as { modelUsage?: unknown }).modelUsage;
    if (mu && typeof mu === "object" && !Array.isArray(mu)) for (const [m, u] of Object.entries(mu).slice(0, 20)) if (m.length <= 100 && usageOf(u)) byModel[m] = usageOf(u);
    const turns = Number.isInteger(s.turns) && s.turns! >= 0 ? s.turns! : null;
    const sessionId = typeof s.sessionId === "string" && s.sessionId.length <= 200 ? s.sessionId : null;
    const costUsd = typeof s.costUsd === "number" && Number.isFinite(s.costUsd) && s.costUsd >= 0 ? s.costUsd : null;
    // The lease can end between the check above and this write (another process expired it): then the reply is not taken.
    const up = db.prepare("UPDATE main.remote_calls SET state = 'done', reply = ?, usage = ?, turns = ?, session_id = ?, duration_ms = ?, ended_at = ?, progress = NULL WHERE id = ? AND state = 'leased' AND lease_secret_hash = ?")
      .run(unrooted(s.text, r.root), JSON.stringify({ ...(usage ?? usageOf({})), ...(Object.keys(byModel).length > 0 && { byModel }), ...(costUsd !== null && { costUsd }) }), turns, sessionId, duration, nowMs, l.id, sha256hex(secret!));
    if (Number(up.changes) !== 1) return gone();
    noteSuccess(db, l.login);
    // The claim named the model the helper meant to run (often an alias); the reply names the one that ran.
    if (r.run_id !== null) {
      db.prepare("UPDATE main.agent_runs SET reported_model = ? WHERE id = ?").run(s.model.slice(0, 100), r.run_id);
      try { saveRemoteTools(db, r.run_id, r.id, rootless((s as { tools?: unknown }).tools, r.root)); } catch (e) { console.log(`tool uses of remote call ${r.id} not stored: ${(e as Error).message}`); }
    }
    return { accepted: true };
  }
  if (s.ok !== false || typeof s.error !== "string") throw new HttpError(400, "ok must be true with text and model, or false with error");
  const r = rowOf(db, l.id)!;
  if (requeue(db, r, scrubError(`helper: ${unrooted(s.error, l.root)}`), nowMs, { skipLogin: l.login, summary: "helper failed" })) {
    noteFailure(db, l.login, nowMs);
    // The last attempt's tokens stay with the failed call.
    db.prepare("UPDATE main.remote_calls SET usage = ?, duration_ms = ? WHERE id = ? AND state = 'failed'").run(usage ? JSON.stringify(usage) : null, duration, l.id);
  }
  return { accepted: true };
}

/** The helper gives the lease back (it could not prepare or start the run): the call returns to the queue without using an attempt and is not offered to that login for a while. False when the lease is gone. */
export function releaseCall(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const reason = progressLine((raw as Release | undefined)?.reason) ?? "released by the helper";
  unlease(db, { id: l.id, runId: l.runId, hash: sha256hex(secret!) }, `released by the helper: ${reason}`, nowMs, l.login);
  return true;
}

// ---- the caller's side -------------------------------------------------------------

export type Outcome =
  /** `byModel`: tokens per model id as the helper reported them (subagents included), when it did. `costUsd`: the harness's cost of the whole call, when it reported one. */
  | { state: "done"; text: string; usage: Usage; byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null; costUsd: number | null; turns: number | null; sessionId: string | null; runId: number | null }
  | { state: "failed"; error: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; runId: number | null }
  /** A follow-up turn that the session's helper did not take in time (STICKY_MS, STICKY_CAP_MS); it was withdrawn. */
  | { state: "unclaimed" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether the helper that ran the parent call (its agent token, which holds the session) holds a lease that heartbeats: it is alive and busy. */
const runsLiveLease = (db: DatabaseSync, parentId: number, nowMs: number): boolean =>
  db.prepare(`SELECT 1 FROM main.remote_calls WHERE state = 'leased' AND heartbeat_at >= ?
    AND token_id = (SELECT token_id FROM main.remote_calls WHERE id = ?) LIMIT 1`).get(nowMs - STICKY_LIVE_MS, parentId) !== undefined;

/**
 * Waits for the call's result, polling its row like the model queue polls (allocation.pollMs). Each poll ends a lost lease
 * (expireLeases). A queued call is withdrawn when the job is cancelled or the pipeline is switched off (the halt is thrown),
 * after `maxWaitMs` in the queue (WaitLimitError), and, for a follow-up, after STICKY_MS while its session's login runs no live
 * lease, else after STICKY_CAP_MS. The helper's progress lines go to `onProgress`.
 * While the call is leased, each poll runs the `check` requests the dashboard relayed for it on `check` (src/remote/check-relay.ts).
 */
export async function awaitCall(db: DatabaseSync, id: number, opts: { onProgress?: (line: string) => void; maxWaitMs?: number; log?: (line: string) => void; check?: Pick<CheckTool, "run"> } = {}): Promise<Outcome> {
  try {
    return await pollCall(db, id, opts);
  } finally {
    endChecks(db, id);
  }
}

async function pollCall(db: DatabaseSync, id: number, opts: { onProgress?: (line: string) => void; maxWaitMs?: number; log?: (line: string) => void; check?: Pick<CheckTool, "run"> }): Promise<Outcome> {
  const log = opts.log ?? console.log;
  let lastProgress: string | null = null, lastLog = 0, lastSeen = 0;
  for (;;) {
    const nowMs = Date.now();
    // The caller's liveness stamp; claims and the room count a call while it is fresher than CALLER_STALE_MS.
    if (nowMs - lastSeen >= SEEN_EVERY_MS) {
      db.prepare("UPDATE main.remote_calls SET seen_at = ? WHERE id = ?").run(nowMs, id);
      lastSeen = nowMs;
    }
    expireLeases(db, nowMs, id);
    const r = rowOf(db, id);
    if (!r) return { state: "failed", error: "the call is gone", tokens: null, runId: null };
    if (r.state === "done") {
      const stored = (r.usage ? JSON.parse(r.usage) : {}) as { byModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>; costUsd?: number };
      const costUsd = typeof stored.costUsd === "number" ? stored.costUsd : null;
      // The raw reply is not kept: the agent run stores the scrubbed copy.
      db.prepare("UPDATE main.remote_calls SET reply = NULL WHERE id = ?").run(id);
      return { state: "done", text: r.reply ?? "", usage: { ...storedTokens(stored), cost: costUsd }, byModel: stored.byModel ?? null, costUsd, turns: r.turns, sessionId: r.session_id, runId: r.run_id };
    }
    if (r.state === "failed") return { state: "failed", error: r.error ?? "failed", tokens: r.usage ? storedTokens(JSON.parse(r.usage)) : null, runId: r.run_id };
    if (r.state === "queued") {
      try {
        throwIfHalted("waiting for a user-local helper");
      } catch (e) {
        if (withdrawCall(db, id, (e as Error).message, ["queued"])) throw e;
        continue; // claimed meanwhile: the call runs on
      }
      const waited = nowMs - (r.queued_since ?? r.since);
      if (r.parent_id !== null && (waited >= STICKY_CAP_MS || (waited >= STICKY_MS && !runsLiveLease(db, r.parent_id, nowMs)))) {
        if (withdrawCall(db, id, "the helper holding the session did not take the follow-up", ["queued"])) return { state: "unclaimed" };
        continue;
      }
      // Only time in the queue counts; a helper running the call is not waiting.
      if (opts.maxWaitMs !== undefined && r.queued_ms + (r.queued_since === null ? 0 : nowMs - r.queued_since) >= opts.maxWaitMs) {
        if (withdrawCall(db, id, "no helper took the call in time", ["queued"])) throw new WaitLimitError("no user-local helper took the call in time");
        continue;
      }
      if (nowMs - lastLog >= allocation.logEveryMs) {
        lastLog = nowMs;
        log(`waiting for a user-local helper (${r.prompt_id}, ${r.tier} tier)`);
      }
    }
    if (r.state === "leased" && opts.check) serveChecks(db, id, opts.check);
    if (r.progress && r.progress !== lastProgress) {
      lastProgress = r.progress;
      try { opts.onProgress?.(r.progress); } catch { /* progress is best effort */ }
    }
    await sleep(allocation.pollMs);
  }
}

/** For the runner: whether a remote call of the job waits in the queue now, and when its latest lease began. The runner sums the time in which any call waited (the union, as calls of one job wait side by side). */
export function jobRemoteQueue(db: DatabaseSync, jobId: number): { queued: boolean; lastLeaseAt: number | null } {
  const r = db.prepare("SELECT COALESCE(MAX(state = 'queued'), 0) AS queued, MAX(leased_at) AS last FROM main.remote_calls WHERE job_id = ?").get(jobId) as { queued: number; last: number | null };
  return { queued: Number(r.queued) === 1, lastLeaseAt: r.last === null ? null : Number(r.last) };
}
