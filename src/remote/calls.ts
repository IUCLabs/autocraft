// Remote calls of the user-local inference mode. The calling process (askClaude, src/classify/run.ts) inserts a call
// and polls its row; a maintainer's helper claims it with an agent token that may run tasks, fetches the bundle and
// sends heartbeats and the reply with the lease secret (routes in src/dash/server/index.ts, wire format in protocol.ts).
// Nothing here runs on a timer: leases are checked by the calling process on each poll and by every claim.
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "../../web/src/api/types.ts";
import { allocation, callQueue, queueOrder, stepOf, throwIfHalted, WaitLimitError, type Waiter } from "../agents/call.ts";
import { finishRun, insertRun, setRunProgress } from "../agents/runs.ts";
import { scrubError } from "../agents/text.ts";
import type { Usage } from "../classify/run.ts";
import { randomToken, sha256hex } from "../dash/server/crypto.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { joinParts } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { acceptedModels, familyOf, isTier, TIERS } from "./mode.ts";
import { PROTOCOL_VERSION, type Claim, type ClaimReply, type HarnessId, type Heartbeat, type Release, type Submit, type SubmitReply, type TaskBundle, type Tier } from "./protocol.ts";
import { CALLER_STALE_MS } from "./room.ts";

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
export const REQUIRED_HELPER = "1.0.0";
/** Ended calls are kept this long (task status, follow-up lookups), then deleted. */
const KEEP_MS = 24 * 3600_000;
const LEASE_PREFIX = "aclease_";
const PROGRESS_MAX = 200;
const REPLY_MAX = 4_000_000;

/** Prompts that judge an item: their calls never go to an author or co-author of an item they judge. */
const JUDGING = new Set(["review.opus", "premerge.opus", "postmerge.opus", "fixup.check", "fixissue.check", "decide.prepare", "conversation.turn", "verify.compare"]);
export const judges = (promptId: string): boolean => JUDGING.has(promptId) || promptId.startsWith("dupes.compare-");

type Row = {
  id: number; job_id: number | null; step: string; stage: number; run_id: number | null; prompt_id: string; prompt_version: string;
  tier: Tier; effort: string; asked_model: string; bundle: string; state: "queued" | "leased" | "done" | "failed"; items: string; repo: string | null;
  cls: number; level: number; since: number; seen_at: number; queued_since: number | null; queued_ms: number;
  user_login: string | null; harness: string | null; model: string | null; leased_at: number | null; heartbeat_at: number | null;
  attempt: number; max_attempts: number; timeout_ms: number; parent_id: number | null; sticky_login: string | null; progress: string | null;
  reply: string | null; usage: string | null; turns: number | null; session_id: string | null; error: string | null;
};
const COLS = "id, job_id, step, stage, run_id, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class AS cls, level, since, seen_at, queued_since, queued_ms, user_login, harness, model, leased_at, heartbeat_at, attempt, max_attempts, timeout_ms, parent_id, sticky_login, progress, reply, usage, turns, session_id, error";
const rowOf = (db: DatabaseSync, id: number): Row | undefined => db.prepare(`SELECT ${COLS} FROM main.remote_calls WHERE id = ?`).get(id) as Row | undefined;

export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string;
  bundle: Omit<TaskBundle, "callId">; items: ItemRef[]; level: number; maxAttempts: number;
  /** A follow-up turn on the session of this call. */
  parentId?: number;
};

/** Queues a call for the current job and step; a follow-up is offered only to the helper of the parent's lease holder. */
export function enqueueCall(db: DatabaseSync, c: NewCall, nowMs: number = Date.now()): number {
  const s = stepOf(c.promptId), q = callQueue(c.promptId);
  const sticky = c.parentId === undefined ? null : (db.prepare("SELECT user_login FROM main.remote_calls WHERE id = ?").get(c.parentId) as { user_login: string | null } | undefined)?.user_login ?? null;
  return Number(db.prepare(`INSERT INTO main.remote_calls (job_id, step, stage, prompt_id, prompt_version, tier, effort, asked_model, bundle, state, items, repo, class, level, since, seen_at, queued_since, max_attempts, timeout_ms, parent_id, sticky_login)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.jobId, s.step, s.stage, c.promptId, c.promptVersion, c.tier, c.effort, c.askedModel, JSON.stringify(c.bundle), JSON.stringify(c.items), q.repo, q.cls, c.level, nowMs, nowMs, nowMs,
      Math.max(1, c.maxAttempts), c.bundle.timeoutSeconds * 1000, c.parentId ?? null, sticky).lastInsertRowid);
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
function requeue(db: DatabaseSync, r: Pick<Row, "id" | "run_id" | "attempt" | "max_attempts">, reason: string, nowMs: number): void {
  const fail = r.attempt >= r.max_attempts;
  const up = db.prepare(`UPDATE main.remote_calls SET state = ?, attempt = attempt + ?, lease_secret_hash = NULL, queued_since = ?, ended_at = ?, error = ?, progress = NULL
    WHERE id = ? AND state = 'leased'`).run(fail ? "failed" : "queued", fail ? 0 : 1, fail ? null : nowMs, fail ? nowMs : null, reason, r.id);
  if (Number(up.changes) === 1 && r.run_id !== null) finishRun(db, r.run_id, { state: "failed", error: reason, summary: "lease ended" });
}

/**
 * The failure backoff of remote calls (registered in src/stages/registry.ts): a lease with no heartbeat for LEASE_IDLE_MS, or past
 * its time limit plus LEASE_MARGIN_MS, goes back to the queue (attempt + 1, up to the prompt's attempts); a call whose caller
 * stopped polling fails. Run by each claim (every call, and old rows are pruned) and by the caller's poll (`id`: that call only).
 */
export function expireLeases(db: DatabaseSync, nowMs: number = Date.now(), id?: number): void {
  const one = id === undefined ? "" : " AND id = ?";
  const lost = db.prepare(`SELECT id, run_id, attempt, max_attempts, heartbeat_at, leased_at, timeout_ms FROM main.remote_calls
    WHERE state = 'leased' AND (heartbeat_at < ? OR leased_at + timeout_ms + ? < ?)${one}`).all(nowMs - LEASE_IDLE_MS, LEASE_MARGIN_MS, nowMs, ...(id === undefined ? [] : [id])) as (Row & { timeout_ms: number })[];
  for (const r of lost) {
    const why = Number(r.heartbeat_at) < nowMs - LEASE_IDLE_MS ? `lease expired: no heartbeat for ${LEASE_IDLE_MS / 60_000} min` : "lease expired: past the call's time limit";
    requeue(db, r, why, nowMs);
  }
  const gone = db.prepare(`SELECT id FROM main.remote_calls WHERE state IN ('queued', 'leased') AND seen_at < ?${one}`).all(nowMs - CALLER_GONE_MS, ...(id === undefined ? [] : [id])) as { id: number }[];
  for (const r of gone) withdrawCall(db, Number(r.id), "the caller stopped waiting", undefined, nowMs);
  if (id === undefined) db.prepare("DELETE FROM main.remote_calls WHERE state IN ('done', 'failed') AND COALESCE(ended_at, since) < ?").run(nowMs - KEEP_MS);
}

/** The call a lease secret belongs to while its lease is live (expired leases are ended first), or null. For the per-lease routes: bundle, heartbeat, submit, the task MCP servers and the tarball. */
export function liveLease(db: DatabaseSync, secret: string | undefined, nowMs: number = Date.now()): { id: number; jobId: number | null; runId: number | null; login: string; promptId: string; items: ItemRef[]; repo: string | null } | null {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const found = db.prepare("SELECT id FROM main.remote_calls WHERE lease_secret_hash = ? AND state = 'leased'").get(hash) as { id: number } | undefined;
  if (!found) return null;
  expireLeases(db, nowMs, Number(found.id));
  const r = db.prepare("SELECT id, job_id, run_id, user_login, prompt_id, items, repo FROM main.remote_calls WHERE id = ? AND lease_secret_hash = ? AND state = 'leased'").get(found.id, hash) as
    { id: number; job_id: number | null; run_id: number | null; user_login: string; prompt_id: string; items: string; repo: string | null } | undefined;
  return r ? { id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo } : null;
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

/** Whether `login` authored, or committed to, any of the items. */
export function authorOf(db: DatabaseSync, refs: ItemRef[], login: string): boolean {
  const item = db.prepare("SELECT 1 FROM main.items WHERE repo = ? AND number = ? AND author = ? COLLATE NOCASE");
  const commit = db.prepare("SELECT 1 FROM main.pr_commits WHERE repo = ? AND number = ? AND author = ? COLLATE NOCASE LIMIT 1");
  return refs.some((r) => item.get(r.repo, r.number, login) !== undefined || commit.get(r.repo, r.number, login) !== undefined);
}

/**
 * Who may take a call: a maintainer or operator with write permission on every repo of the call (which covers reading a
 * private one), not an author or co-author of an item a judging prompt judges; discord.* calls go to operators only, and a
 * call that names no repo goes to operators only.
 */
async function eligible(db: DatabaseSync, caller: Caller, r: Pick<Row, "prompt_id" | "items" | "repo">, canWrite: (repo: string) => Promise<boolean>): Promise<boolean> {
  if (caller.role !== "operator" && caller.role !== "maintainer") return false;
  if (r.prompt_id.startsWith("discord.") && caller.role !== "operator") return false;
  const refs = JSON.parse(r.items) as ItemRef[];
  const repos = [...new Set([...refs.map((x) => x.repo), ...(r.repo ? [r.repo] : [])])];
  if (!repos.length && caller.role !== "operator") return false;
  for (const repo of repos) if (!(await canWrite(repo))) return false;
  return !(judges(r.prompt_id) && authorOf(db, refs, caller.login));
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
  if (c.repos !== undefined && (!Array.isArray(c.repos) || c.repos.length > 500 || !c.repos.every((x) => short(x, 100)))) throw new HttpError(400, "repos must be a list of repo names");
  if (c.sessions !== undefined && (!Array.isArray(c.sessions) || c.sessions.length > 500 || !c.sessions.every((x) => Number.isInteger(x)))) throw new HttpError(400, "sessions must be a list of call ids");
  return { protocol: PROTOCOL_VERSION, helperVersion: c.helperVersion, harness: c.harness as HarnessId, harnessVersion: c.harnessVersion, tiers, ...(c.repos !== undefined && { repos: c.repos as string[] }), ...(c.sessions !== undefined && { sessions: c.sessions as number[] }) };
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
    const r = db.prepare(`UPDATE main.remote_calls SET state = 'leased', user_login = ?, harness = ?, harness_version = ?, model = ?, lease_secret_hash = ?, leased_at = ?, heartbeat_at = ?,
        queued_ms = queued_ms + CASE WHEN queued_since IS NULL THEN 0 ELSE MAX(0, ? - queued_since) END, queued_since = NULL, progress = NULL, error = NULL
      WHERE id = ? AND state = 'queued' RETURNING ${COLS}`).get(caller.login, claim.harness, claim.harnessVersion, model, sha256hex(secret), nowMs, nowMs, nowMs, id) as Row | undefined;
    if (!r) {
      db.exec("COMMIT");
      return null;
    }
    const b = JSON.parse(r.bundle) as Omit<TaskBundle, "callId">;
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
  const rows = (db.prepare("SELECT id, class AS cls, level, step, repo, since, prompt_id, tier, items, parent_id, sticky_login FROM main.remote_calls WHERE state = 'queued' AND seen_at >= ?").all(nowMs - CALLER_STALE_MS) as Cand[])
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
export async function claimableCalls(db: DatabaseSync, caller: Caller, opts: { tiers?: readonly Tier[] }, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<number> {
  expireLeases(db, nowMs);
  const accepted = acceptedModels(db);
  const tiers = new Set((opts.tiers ?? TIERS).filter((t) => accepted[t].length > 0));
  const can = memoWrite(canWrite);
  let n = 0;
  for (const r of claimOrder(db, caller, tiers, null, [], nowMs)) if (await eligible(db, caller, r, can)) n++;
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
 * write permission on a repo.
 */
export async function claimCall(db: DatabaseSync, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<ClaimReply> {
  expireLeases(db, nowMs);
  const accepted = acceptedModels(db);
  const tiers = new Set((Object.keys(claim.tiers) as Tier[]).filter((t) => familyOf(claim.tiers[t]!, accepted[t]) !== null));
  if (!tiers.size) throw new HttpError(400, `no tier of the claim has an accepted model; accepted: ${(Object.keys(accepted) as Tier[]).map((t) => `${t} ${accepted[t].join("/")}`).join(", ")}`);
  const can = memoWrite(canWrite);
  for (const r of claimOrder(db, caller, tiers, claim.repos ? new Set(claim.repos) : null, claim.sessions ?? [], nowMs)) {
    if (!(await eligible(db, caller, r, can))) continue;
    const lease = leaseCall(db, Number(r.id), caller, claim, claim.tiers[r.tier]!, Date.now());
    if (!lease) continue;
    db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = NULL WHERE id = ?").run(caller.tokenId);
    return { lease };
  }
  db.prepare("UPDATE main.mcp_tokens SET idle_claim_at = ? WHERE id = ?").run(nowMs, caller.tokenId);
  return { lease: null, retryAfter: CLAIM_RETRY_S };
}

// ---- lease routes ------------------------------------------------------------------

/** The task bundle of a live lease, or null. */
export function bundleOf(db: DatabaseSync, secret: string | undefined): TaskBundle | null {
  const l = liveLease(db, secret);
  if (!l) return null;
  const r = db.prepare("SELECT bundle FROM main.remote_calls WHERE id = ?").get(l.id) as { bundle: string };
  return { ...(JSON.parse(r.bundle) as Omit<TaskBundle, "callId">), callId: l.id };
}

/** A plain one-line progress text from the helper: control characters removed, scrubbed, cut. */
const progressLine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? scrub(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, PROGRESS_MAX) : null);

/** Records a heartbeat; false when the lease is gone (the route answers 410). */
export function heartbeat(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const line = progressLine((raw as Heartbeat | undefined)?.progress);
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
      .run(s.text, JSON.stringify({ ...(usage ?? usageOf({})), ...(Object.keys(byModel).length > 0 && { byModel }), ...(costUsd !== null && { costUsd }) }), turns, sessionId, duration, nowMs, l.id);
    return { accepted: true };
  }
  if (s.ok !== false || typeof s.error !== "string") throw new HttpError(400, "ok must be true with text and model, or false with error");
  db.prepare("UPDATE main.remote_calls SET state = 'failed', error = ?, usage = ?, duration_ms = ?, ended_at = ?, progress = NULL WHERE id = ? AND state = 'leased'")
    .run(scrubError(`helper: ${s.error}`), usage ? JSON.stringify(usage) : null, duration, nowMs, l.id);
  return { accepted: true };
}

/** The helper gives the lease back (too old, or its platform or harness login is missing): the call returns to the queue without using an attempt. False when the lease is gone. */
export function releaseCall(db: DatabaseSync, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): boolean {
  const l = liveLease(db, secret, nowMs);
  if (!l) return false;
  const reason = progressLine((raw as Release | undefined)?.reason) ?? "released by the helper";
  const up = db.prepare("UPDATE main.remote_calls SET state = 'queued', lease_secret_hash = NULL, queued_since = ?, error = ?, progress = NULL WHERE id = ? AND state = 'leased'").run(nowMs, `released: ${reason}`, l.id);
  if (Number(up.changes) === 1 && l.runId !== null) finishRun(db, l.runId, { state: "failed", error: `released by the helper: ${reason}`, summary: "released" });
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
 */
export async function awaitCall(db: DatabaseSync, id: number, opts: { onProgress?: (line: string) => void; maxWaitMs?: number; log?: (line: string) => void } = {}): Promise<Outcome> {
  const began = Date.now();
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
      if (opts.maxWaitMs !== undefined && nowMs - began >= opts.maxWaitMs) {
        if (withdrawCall(db, id, "no helper took the call in time", ["queued"])) throw new WaitLimitError("no user-local helper took the call in time");
        continue;
      }
      if (nowMs - lastLog >= allocation.logEveryMs) {
        lastLog = nowMs;
        log(`waiting for a user-local helper (${r.prompt_id}, ${r.tier} tier)`);
      }
    }
    if (r.progress && r.progress !== lastProgress) {
      lastProgress = r.progress;
      try { opts.onProgress?.(r.progress); } catch { /* progress is best effort */ }
    }
    await sleep(allocation.pollMs);
  }
}

/** For the runner: how long the job's remote calls have waited in the queue in all (not counted toward its deadline), whether one waits now, and when its latest lease began. */
export function jobRemoteWait(db: DatabaseSync, jobId: number, nowMs: number = Date.now()): { waitedMs: number; queued: boolean; lastLeaseAt: number | null } {
  const r = db.prepare(`SELECT COALESCE(SUM(queued_ms + CASE WHEN state = 'queued' AND queued_since IS NOT NULL THEN MAX(0, ? - queued_since) ELSE 0 END), 0) AS waited,
      COALESCE(MAX(state = 'queued'), 0) AS queued, MAX(leased_at) AS last FROM main.remote_calls WHERE job_id = ?`).get(nowMs, jobId) as { waited: number; queued: number; last: number | null };
  return { waitedMs: Number(r.waited), queued: Number(r.queued) === 1, lastLeaseAt: r.last === null ? null : Number(r.last) };
}
