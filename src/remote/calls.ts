// Remote calls of the user-local inference mode. The calling process (askClaude, src/classify/run.ts) inserts a call
// and polls its row; a maintainer's helper claims it with an agent token that may run tasks, fetches the bundle and
// sends heartbeats and the reply with the lease secret (routes in src/dash/server/index.ts, wire format in protocol.ts).
// Nothing here runs on a timer: leases are checked by the calling process on each poll and by every claim.
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
import { COOLOFF_REASON, cooloffUntil, noteDrop } from "./cooloff.ts";
import { acceptedModels, familyOf, isEffort, isTier, meetsEffort, minEfforts, TIERS } from "./mode.ts";
import { PROTOCOL_VERSION, ROUTES, type Claim, type ClaimReply, type HarnessId, type Heartbeat, type Release, type Submit, type SubmitReply, type TaskBundle, type Tier } from "./protocol.ts";
import { userReserve } from "./reserve.ts";
import { CALLER_STALE_MS, IDLE_FRESH_MS } from "./room.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { endChecks, serveChecks } from "./check-relay.ts";
import type { CheckTool } from "../checktool/index.ts";

/** A lease with no heartbeat for this long goes back to the queue. */
export const LEASE_IDLE_MS = 2 * 60_000;
/** A lease also ends this long after the bundle's own time limit. */
export const LEASE_MARGIN_MS = 2 * 60_000;
/** How long a follow-up turn waits for the helper that holds its session before the caller falls back to a fresh call. */
export const STICKY_MS = LEASE_IDLE_MS;
/** A call whose caller has not polled for this long has lost it (the process died): the call fails. */
export const CALLER_GONE_MS = 5 * 60_000;
/** Seconds a helper waits before claiming again when nothing could be taken. */
export const CLAIM_RETRY_S = 15;
/** The oldest helper version that may run a lease. */
export const REQUIRED_HELPER = "1.1.0";
/** A call this login released is not offered to it again for this long (its helper could not run it). */
export const RELEASE_SKIP_MS = 10 * 60_000;
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

type Row = {
  id: number; job_id: number | null; step: string; stage: number; run_id: number | null; prompt_id: string; prompt_version: string;
  tier: Tier; effort: string; asked_model: string; bundle: string; state: "queued" | "leased" | "done" | "failed"; items: string; repo: string | null;
  cls: number; level: number; since: number; seen_at: number; queued_since: number | null; queued_ms: number;
  user_login: string | null; harness: string | null; model: string | null; leased_at: number | null; heartbeat_at: number | null;
  attempt: number; max_attempts: number; timeout_ms: number; parent_id: number | null; sticky_login: string | null; progress: string | null;
  reply: string | null; usage: string | null; turns: number | null; session_id: string | null; error: string | null; root: string | null;
};
const COLS = "id, job_id, step, stage, run_id, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class AS cls, level, since, seen_at, queued_since, queued_ms, user_login, harness, model, leased_at, heartbeat_at, attempt, max_attempts, timeout_ms, parent_id, sticky_login, progress, reply, usage, turns, session_id, error, root";
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
  return Number(db.prepare(`INSERT INTO main.remote_calls (job_id, step, stage, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class, level, since, seen_at, queued_since, max_attempts, timeout_ms, parent_id, sticky_login, reference_repo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.jobId, s.step, s.stage, c.promptId, c.promptVersion, c.tier, c.effort, c.askedModel, JSON.stringify(c.bundle), JSON.stringify(c.items), q.repo, q.cls, c.level, nowMs, nowMs, nowMs,
      Math.max(1, c.maxAttempts), c.bundle.timeoutSeconds * 1000, c.parentId ?? null, sticky, c.referenceRepo ?? null).lastInsertRowid);
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

/** A lost lease goes back to the queue with the next attempt, or fails once the prompt's attempts are used up. */
function requeue(db: DatabaseSync, r: Pick<Row, "id" | "run_id" | "attempt" | "max_attempts" | "leased_at">, reason: string, nowMs: number): boolean {
  const fail = r.attempt >= r.max_attempts;
  // Compare and set: only the lease that was read ends, so two processes that saw it expire end it once.
  const up = db.prepare(`UPDATE main.remote_calls SET state = ?, attempt = attempt + ?, lease_secret_hash = NULL, token_id = NULL, queued_since = ?, ended_at = ?, error = ?, progress = NULL
    WHERE id = ? AND state = 'leased' AND attempt = ? AND leased_at IS ?`).run(fail ? "failed" : "queued", fail ? 0 : 1, fail ? null : nowMs, fail ? nowMs : null, reason, r.id, r.attempt, r.leased_at);
  if (Number(up.changes) === 1 && r.run_id !== null) finishRun(db, r.run_id, { state: "failed", error: reason, summary: "lease ended" });
  return Number(up.changes) === 1;
}

/** Puts a leased call back in the queue without using an attempt (released by its helper, or its token lost the right to run it). */
function unlease(db: DatabaseSync, id: number, runId: number | null, why: string, nowMs: number, releasedBy: string | null = null): void {
  const up = db.prepare(`UPDATE main.remote_calls SET state = 'queued', lease_secret_hash = NULL, token_id = NULL, queued_since = ?, error = ?, progress = NULL, released_by = COALESCE(?, released_by), released_at = CASE WHEN ? IS NULL THEN released_at ELSE ? END
    WHERE id = ? AND state = 'leased'`).run(nowMs, why, releasedBy, releasedBy, nowMs, id);
  if (Number(up.changes) === 1 && runId !== null) finishRun(db, runId, { state: "failed", error: why, summary: "returned to the queue" });
}

/**
 * The failure backoff of remote calls (registered in src/stages/registry.ts): a lease with no heartbeat for LEASE_IDLE_MS, or past
 * its time limit plus LEASE_MARGIN_MS, goes back to the queue (attempt + 1, up to the prompt's attempts); a call whose caller
 * stopped polling fails. The lost lease also counts toward its token's flap cool-off. Run by each claim (every call, and old rows are pruned) and by the caller's poll (`id`: that call only).
 */
export function expireLeases(db: DatabaseSync, nowMs: number = Date.now(), id?: number): void {
  const one = id === undefined ? "" : " AND id = ?";
  const lost = db.prepare(`SELECT id, run_id, attempt, max_attempts, heartbeat_at, leased_at, timeout_ms, token_id FROM main.remote_calls
    WHERE state = 'leased' AND (heartbeat_at < ? OR leased_at + timeout_ms + ? < ?)${one}`).all(nowMs - LEASE_IDLE_MS, LEASE_MARGIN_MS, nowMs, ...(id === undefined ? [] : [id])) as (Row & { timeout_ms: number; token_id: number | null })[];
  for (const r of lost) {
    const why = Number(r.heartbeat_at) < nowMs - LEASE_IDLE_MS ? `lease expired: no heartbeat for ${LEASE_IDLE_MS / 60_000} min` : "lease expired: past the call's time limit";
    // A lost lease counts toward its token's cool-off (cooloff.ts), not as a call failure: the attempt counting stays as it is.
    if (requeue(db, r, why, nowMs) && r.token_id !== null) noteDrop(db, Number(r.token_id), nowMs);
  }
  const gone = db.prepare(`SELECT id FROM main.remote_calls WHERE state IN ('queued', 'leased') AND seen_at < ?${one}`).all(nowMs - CALLER_GONE_MS, ...(id === undefined ? [] : [id])) as { id: number }[];
  for (const r of gone) withdrawCall(db, Number(r.id), "the caller stopped waiting", undefined, nowMs);
  if (id === undefined) {
    db.prepare("DELETE FROM main.remote_calls WHERE state IN ('done', 'failed') AND COALESCE(ended_at, since) < ?").run(nowMs - KEEP_MS);
    db.prepare("DELETE FROM main.remote_checks WHERE state = 'done' AND COALESCE(ended_at, requested_at) < ?").run(nowMs - KEEP_MS);
  }
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
    unlease(db, Number(r.id), r.run_id, "returned to the queue: the token that claimed it may no longer run tasks", nowMs);
    return null;
  }
  return r ? { id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo, root: r.root } : null;
}

/** The state of the call a lease secret was issued for, live or not (for task status); null for an unknown secret. */
export function leaseState(db: DatabaseSync, secret: string | undefined): { id: number; state: Row["state"]; error: string | null } | null {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const r = db.prepare("SELECT id, state, error FROM main.remote_calls WHERE lease_secret_hash = ?").get(sha256hex(secret)) as { id: number; state: Row["state"]; error: string | null } | undefined;
  return r ? { id: Number(r.id), state: r.state, error: r.error } : null;
}

// ---- claims ------------------------------------------------------------------------

export type Caller = { tokenId: number; login: string; role: Role };

const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/** Whether `login` authored any of the items, or authored or co-authored (a Co-authored-by trailer, as GitHub lists the commit's authors) a commit of one. */
export function authorOf(db: DatabaseSync, refs: ItemRef[], login: string): boolean {
  const item = db.prepare("SELECT 1 FROM main.items WHERE repo = ? AND number = ? AND author = ? COLLATE NOCASE");
  const commit = db.prepare(`SELECT 1 FROM main.pr_commits WHERE repo = ? AND number = ?
    AND (author = ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(co_authors) THEN co_authors ELSE '[]' END) WHERE value = ? COLLATE NOCASE)) LIMIT 1`);
  return refs.some((r) => item.get(r.repo, r.number, login) !== undefined || commit.get(r.repo, r.number, login, login) !== undefined);
}

type CallScope = Pick<Row, "prompt_id" | "items" | "repo" | "tier">;
const reposOf = (r: CallScope, refs: ItemRef[]): string[] => [...new Set([...refs.map((x) => x.repo), ...(r.repo ? [r.repo] : [])])];
/** The role rules: maintainers and operators; discord.* calls and calls that name no repo go to operators only. */
const roleFits = (role: string, r: CallScope, repos: string[]): boolean =>
  (role === "operator" || role === "maintainer") && !((r.prompt_id.startsWith("discord.") || !repos.length) && role !== "operator");

/**
 * Whether a login other than `login` could take the call now: its helper's last claim found nothing within IDLE_FRESH_MS, that
 * claim covered the call's tier and repos, the login fits the role rules, its cached write permission covers every repo and
 * it authored no item of the call. A state check made at each claim; nothing waits on it.
 */
function otherHelperIdle(db: DatabaseSync, login: string, r: CallScope, refs: ItemRef[], repos: string[], nowMs: number): boolean {
  const idle = db.prepare(`SELECT t.login, a.role, t.idle_tiers, t.idle_repos FROM main.mcp_tokens t JOIN main.access a ON a.login = t.login
    WHERE t.can_run = 1 AND t.expires_at > ? AND t.idle_claim_at >= ? AND t.login <> ? COLLATE NOCASE`).all(new Date(nowMs).toISOString(), nowMs - IDLE_FRESH_MS, login) as
    { login: string; role: string; idle_tiers: string | null; idle_repos: string | null }[];
  const perm = db.prepare("SELECT permission, checked_at FROM main.repo_permissions WHERE login = ? AND repo = ?");
  const canWrite = (who: string, repo: string): boolean => {
    const p = perm.get(who, repo) as { permission: string; checked_at: string } | undefined;
    return p !== undefined && WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL;
  };
  return idle.some((o) => {
    const tiers = o.idle_tiers ? JSON.parse(o.idle_tiers) as string[] : [];
    const only = o.idle_repos ? new Set(JSON.parse(o.idle_repos) as string[]) : null;
    return tiers.includes(r.tier) && (!only || repos.every((x) => only.has(x))) && roleFits(o.role, r, repos)
      && repos.every((x) => canWrite(o.login, x)) && !authorOf(db, refs, o.login);
  });
}

/**
 * Who may take a call: a maintainer or operator with write permission on every repo of the call (which covers reading a
 * private one); discord.* calls and calls that name no repo go to operators only. An author or co-author of an item a judging
 * prompt judges is passed over only while another helper that could take the call is asking for work (otherHelperIdle).
 */
async function eligible(db: DatabaseSync, caller: Caller, r: CallScope, canWrite: (repo: string) => Promise<boolean>, nowMs: number): Promise<boolean> {
  const refs = JSON.parse(r.items) as ItemRef[];
  const repos = reposOf(r, refs);
  if (!roleFits(caller.role, r, repos)) return false;
  for (const repo of repos) if (!(await canWrite(repo))) return false;
  return !(judges(r.prompt_id) && authorOf(db, refs, caller.login) && otherHelperIdle(db, caller.login, r, refs, repos, nowMs));
}

const HARNESSES: HarnessId[] = ["claude", "codex"];
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** The claim body, checked; throws HttpError 400 for a malformed one and 409 for another protocol version. */
export function parseClaim(raw: unknown): Claim {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Claim object");
  const c = raw as Record<string, unknown>;
  if (c.protocol !== PROTOCOL_VERSION) throw new HttpError(409, `this server speaks protocol ${PROTOCOL_VERSION}; update the helper`);
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
  return { protocol: PROTOCOL_VERSION, helperVersion: c.helperVersion, harness: c.harness as HarnessId, harnessVersion: c.harnessVersion, tiers, ...(efforts && { efforts }), ...(c.repos !== undefined && { repos: c.repos as string[] }), ...(c.sessions !== undefined && { sessions: c.sessions as number[] }), ...(c.root !== undefined && { root: c.root as string }) };
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

/** Leases the call to the caller if it is still queued: the agent run starts now, on no account, with the user and harness. */
function leaseCall(db: DatabaseSync, id: number, caller: Caller, claim: Claim, model: string, nowMs: number): Extract<ClaimReply, { lease: object }>["lease"] | null {
  const secret = `${LEASE_PREFIX}${randomToken(32)}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare(`UPDATE main.remote_calls SET state = 'leased', token_id = ?, user_login = ?, harness = ?, harness_version = ?, model = ?, root = ?, lease_secret_hash = ?, leased_at = ?, heartbeat_at = ?,
        queued_ms = queued_ms + CASE WHEN queued_since IS NULL THEN 0 ELSE MAX(0, ? - queued_since) END, queued_since = NULL, progress = NULL, error = NULL
      WHERE id = ? AND state = 'queued' RETURNING ${COLS}`).get(caller.tokenId, caller.login, claim.harness, claim.harnessVersion, model, claim.root ?? null, sha256hex(secret), nowMs, nowMs, nowMs, id) as Row | undefined;
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

type Cand = Waiter & Pick<Row, "prompt_id" | "tier" | "items" | "parent_id" | "sticky_login">;

/** The queued calls a claim could take in the order it takes them, before eligibility: follow-up turns of the sessions its helper holds first, then the model queue's order, filtered by tiers and repos. */
function claimOrder(db: DatabaseSync, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number): Cand[] {
  const rows = (db.prepare(`SELECT id, class AS cls, level, step, repo, since, prompt_id, tier, items, parent_id, sticky_login FROM main.remote_calls
      WHERE state = 'queued' AND seen_at >= ? AND NOT COALESCE(released_by = ? COLLATE NOCASE AND released_at >= ?, 0)`).all(nowMs - CALLER_STALE_MS, caller.login, nowMs - RELEASE_SKIP_MS) as Cand[])
    .filter((r) => tiers.has(r.tier) && (!repos || (JSON.parse(r.items) as ItemRef[]).every((x) => repos.has(x.repo)) && (!r.repo || repos.has(r.repo))));
  const sessions = new Set(sessionIds);
  const followUps = rows.filter((r) => r.parent_id !== null && sessions.has(r.parent_id) && sameLogin(r.sticky_login, caller.login)).sort((a, b) => a.since - b.since || a.id - b.id);
  return [...followUps, ...queueOrder(db, nowMs, rows.filter((r) => r.parent_id === null))];
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
  if (cooloffUntil(db, caller.tokenId, nowMs) !== null) return 0;
  const accepted = acceptedModels(db);
  // A tier counts when the model the helper would use for it is of an accepted family; without a model, when the tier accepts any.
  const tiers = new Set((opts.tiers ?? TIERS).filter((t) => accepted[t].length > 0 && (opts.models?.[t] === undefined || familyOf(opts.models[t]!, accepted[t]) !== null)));
  const can = memoWrite(canWrite);
  let n = 0;
  for (const r of claimOrder(db, caller, tiers, null, [], nowMs)) if (await eligible(db, caller, r, can, nowMs)) n++;
  return n;
}

/** The state of a call this login holds or held (by its lease id); null for an unknown call and for another login's. */
export function callStatus(db: DatabaseSync, id: number, login: string): { id: number; state: Row["state"]; error: string | null; title: string } | null {
  const r = db.prepare("SELECT id, state, error, prompt_id, items, user_login FROM main.remote_calls WHERE id = ?").get(id) as { id: number; state: Row["state"]; error: string | null; prompt_id: string; items: string; user_login: string | null } | undefined;
  if (!r || !sameLogin(r.user_login, login)) return null;
  return { id: Number(r.id), state: r.state, error: r.error, title: titleOf(r.prompt_id, JSON.parse(r.items) as ItemRef[]) };
}

/**
 * Gives the caller the first queued call it may take (claimOrder), filtered by eligibility. `canWrite` reads the caller's live
 * write permission on a repo. The reply carries the user's reserve either way.
 */
export async function claimCall(db: DatabaseSync, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<ClaimReply> {
  if (olderVersion(claim.helperVersion, REQUIRED_HELPER)) throw new HttpError(409, `helper ${claim.helperVersion} is older than ${REQUIRED_HELPER}, the oldest this server accepts; download the current helper from ${ROUTES.helper}`);
  expireLeases(db, nowMs);
  const until = cooloffUntil(db, caller.tokenId, nowMs);
  if (until !== null) return { lease: null, retryAfter: Math.ceil((until - nowMs) / 1000), reason: COOLOFF_REASON, until, reserve: userReserve(db, caller.login) };
  const accepted = acceptedModels(db), floors = minEfforts(db);
  const tiers = new Set((Object.keys(claim.tiers) as Tier[]).filter((t) => familyOf(claim.tiers[t]!, accepted[t]) !== null && meetsEffort(claim.efforts?.[t], floors[t], claim.harness)));
  if (!tiers.size) throw new HttpError(400, `no tier of the claim has an accepted model at the minimum effort; accepted: ${(Object.keys(accepted) as Tier[]).map((t) => `${t} ${accepted[t].join("/")}${floors[t] ? ` at effort ${floors[t]} or higher` : ""}`).join(", ")}`);
  const can = memoWrite(canWrite);
  for (const r of claimOrder(db, caller, tiers, claim.repos ? new Set(claim.repos) : null, claim.sessions ?? [], nowMs)) {
    if (!(await eligible(db, caller, r, can, nowMs))) continue;
    const lease = leaseCall(db, Number(r.id), caller, claim, claim.tiers[r.tier]!, Date.now());
    if (!lease) continue;
    db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = NULL WHERE id = ?").run(caller.tokenId);
    return { lease, reserve: userReserve(db, caller.login) };
  }
  // An idle helper, with what it takes: an author's claim gives way to it (otherHelperIdle).
  db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = ?, idle_tiers = ?, idle_repos = ? WHERE id = ?").run(nowMs, JSON.stringify([...tiers]), claim.repos ? JSON.stringify(claim.repos) : null, caller.tokenId);
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

/** Records a heartbeat; false when the lease is gone (the route answers 410). */
export function heartbeat(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const p = (raw as Heartbeat | undefined)?.progress;
  const line = progressLine(typeof p === "string" ? unrooted(p, l.root) : p);
  db.prepare("UPDATE main.remote_calls SET heartbeat_at = ?, progress = COALESCE(?, progress) WHERE id = ?").run(nowMs, line, l.id);
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

/** Takes a helper's result. A reply from another model than the claim declared for the tier is refused and the call goes back to the queue. */
export function submitCall(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): SubmitReply {
  const l = liveLease(db, secret, nowMs);
  if (!l) return { accepted: false, reason: "the lease is gone (expired, withdrawn or already submitted)" };
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
      requeue(db, r, `the harness reported model ${s.model.slice(0, 100)}, not the ${family ?? r.model} family claimed for the tier`, nowMs);
      return { accepted: false, reason: `the claim declared ${r.model} for this tier` };
    }
    const byModel: Record<string, ReturnType<typeof usageOf>> = {};
    const mu = (s as { modelUsage?: unknown }).modelUsage;
    if (mu && typeof mu === "object" && !Array.isArray(mu)) for (const [m, u] of Object.entries(mu).slice(0, 20)) if (m.length <= 100 && usageOf(u)) byModel[m] = usageOf(u);
    const turns = Number.isInteger(s.turns) && s.turns! >= 0 ? s.turns! : null;
    const sessionId = typeof s.sessionId === "string" && s.sessionId.length <= 200 ? s.sessionId : null;
    const costUsd = typeof s.costUsd === "number" && Number.isFinite(s.costUsd) && s.costUsd >= 0 ? s.costUsd : null;
    db.prepare("UPDATE main.remote_calls SET state = 'done', reply = ?, usage = ?, turns = ?, session_id = ?, duration_ms = ?, ended_at = ?, progress = NULL WHERE id = ? AND state = 'leased'")
      .run(unrooted(s.text, r.root), JSON.stringify({ ...(usage ?? usageOf({})), ...(Object.keys(byModel).length > 0 && { byModel }), ...(costUsd !== null && { costUsd }) }), turns, sessionId, duration, nowMs, l.id);
    // The claim named the model the helper meant to run (often an alias); the reply names the one that ran.
    if (r.run_id !== null) {
      db.prepare("UPDATE main.agent_runs SET reported_model = ? WHERE id = ?").run(s.model.slice(0, 100), r.run_id);
      try { saveRemoteTools(db, r.run_id, r.id, rootless((s as { tools?: unknown }).tools, r.root)); } catch (e) { console.log(`tool uses of remote call ${r.id} not stored: ${(e as Error).message}`); }
    }
    return { accepted: true };
  }
  if (s.ok !== false || typeof s.error !== "string") throw new HttpError(400, "ok must be true with text and model, or false with error");
  db.prepare("UPDATE main.remote_calls SET state = 'failed', error = ?, usage = ?, duration_ms = ?, ended_at = ?, progress = NULL WHERE id = ? AND state = 'leased'")
    .run(scrubError(`helper: ${unrooted(s.error, l.root)}`), usage ? JSON.stringify(usage) : null, duration, nowMs, l.id);
  return { accepted: true };
}

/** The helper gives the lease back (too old, or its platform or harness login is missing): the call returns to the queue without using an attempt. False when the lease is gone. */
export function releaseCall(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const reason = progressLine((raw as Release | undefined)?.reason) ?? "released by the helper";
  unlease(db, l.id, l.runId, `released by the helper: ${reason}`, nowMs, l.login);
  return true;
}

// ---- the caller's side -------------------------------------------------------------

export type Outcome =
  /** `byModel`: tokens per model id as the helper reported them (subagents included), when it did. `costUsd`: the harness's cost of the whole call, when it reported one. */
  | { state: "done"; text: string; usage: Usage; byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null; costUsd: number | null; turns: number | null; sessionId: string | null; runId: number | null }
  | { state: "failed"; error: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; runId: number | null }
  /** A follow-up turn that the session's helper did not take within STICKY_MS; it was withdrawn. */
  | { state: "unclaimed" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the call's result, polling its row like the model queue polls (allocation.pollMs). Each poll ends a lost lease
 * (expireLeases). A queued call is withdrawn when the job is cancelled or the pipeline is switched off (the halt is thrown),
 * after `maxWaitMs` in the queue (WaitLimitError), and, for a follow-up, after STICKY_MS. The helper's progress lines go to `onProgress`.
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
  let lastProgress: string | null = null, lastLog = 0;
  for (;;) {
    const nowMs = Date.now();
    db.prepare("UPDATE main.remote_calls SET seen_at = ? WHERE id = ?").run(nowMs, id);
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
      if (r.parent_id !== null && nowMs - (r.queued_since ?? r.since) >= STICKY_MS) {
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
