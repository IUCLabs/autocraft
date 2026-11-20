// Takers in the user-local model queue: whether some Task Runner may take calls on a repo now, and what happens when none
// can. A taker is a fresh, ready Task Runner (helpers.ts) of a user who is not cooled off (cooloff.ts) and who may take the
// call (runnerTakes: role rules, write permission by the room's rule roomCanWrite, My repos narrowed by the runner's own
// list), busy or not. A Manual only user's runner (manual-only.ts) is a taker, since the user may pick the call, though it is
// no room. takerTest is the one taker rule: pools and the runner's job starts skip work without a taker, the
// dashboard's minute maintenance runs sweepTakers: a queued call with no taker for NO_TAKER_MS is withdrawn, and pipeline-on
// repos with no taker are recorded for the remote-no-taker health check. Follow-up turns and calls with a pick that counts
// keep their own rules (calls.ts awaitCall, picks).
import type { DatabaseSync } from "node:sqlite";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { prep } from "../sql-cache.ts";
import { NO_TAKER_PREFIX, pickCounts, pickerLogins, queueSnapshot, runnerTakes, withdrawCall } from "./calls.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { inferenceMode } from "./mode.ts";
import { claimRepos } from "./my-repos.ts";
import { SKIP_TASKS_KEY, TASK_CHOICES, taskOfStep, userSkips } from "./my-tasks.ts";
import { CALLER_STALE_MS, roomCanWrite } from "./room.ts";
import { scaled } from "./time-scale.ts";

/** How long a queued call may have no taker before it is withdrawn, and a pipeline-on repo before the health check warns. */
export const NO_TAKER_MS = scaled(10 * 60_000);

/** A call as the taker rule reads it: its prompt (role rules for discord.* calls) and the repos it names. */
/**
 * `step`: the call's step, for the takers' tasks (my-tasks.ts); left out, the question is about repos alone. `someTask`: with no
 * step, only a runner whose user takes at least one task counts (with none ticked a user takes only picks).
 */
export type TakerCall = { prompt_id: string; repos: readonly string[]; step?: string; someTask?: boolean };

/**
 * Whether some taker may take a call now, for many questions at one moment (a pool's round, the runner's pass over queued
 * jobs, a sweep): the runners, their repos and permissions are read once, on the first question.
 */
export function takerTest(db: DatabaseSync, nowMs: number): (c: TakerCall) => boolean {
  let test: ((c: TakerCall) => boolean) | null = null;
  return (c) => (test ??= readTakers(db, nowMs))(c);
}

/** SQL on a runner token `t` joined to its status `h`: the runner may be a taker (fresh, ready, its user not cooling off). Bind takerArgs. */
const TAKER_SQL = `t.kind = 'runner' AND t.expires_at > ? AND h.readiness = 'ready' AND h.reported_at >= ?
  AND NOT EXISTS (SELECT 1 FROM main.remote_cooloffs co WHERE co.login = t.login AND co.until > ?)`;
const takerArgs = (nowMs: number): [string, number, number] => [new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS, nowMs];

/**
 * The runners the taker rule reads, in a form that changes only when they or what decides their repos change: each one's
 * login, role, My repos and own repo list. The planner adds it to its input, so work left for want of a taker is planned
 * again when one connects or comes back, without every status report waking the planner. Of write permission it holds the
 * oldest check among their cached non-write permissions that still count (roomCanWrite), so it changes when that one expires.
 */
export function takerSignature(db: DatabaseSync, nowMs: number = Date.now()): string {
  const r = prep(db, `SELECT group_concat(k, ';') AS s FROM (SELECT DISTINCT lower(t.login) || ':' || COALESCE(a.role, '') || ':' || COALESCE(us.value, '') || ':' || COALESCE(t.idle_repos, '') || ':' || COALESCE(sk.value, '') AS k
      FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id LEFT JOIN main.access a ON a.login = t.login
      LEFT JOIN main.user_settings us ON us.login = t.login AND us.key = 'repos'
      LEFT JOIN main.user_settings sk ON sk.login = t.login AND sk.key = '${SKIP_TASKS_KEY}'
      WHERE ${TAKER_SQL} ORDER BY k)`).get(...takerArgs(nowMs)) as { s: string | null };
  if (!r.s) return "";
  const denied = prep(db, `SELECT MIN(p.checked_at) AS at FROM main.repo_permissions p WHERE p.permission NOT IN (SELECT value FROM json_each(?)) AND p.checked_at > ?
      AND p.login IN (SELECT t.login FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id WHERE ${TAKER_SQL})`)
    .get(JSON.stringify([...WRITE_PERMISSIONS]), new Date(nowMs - PERM_READ_TTL).toISOString(), ...takerArgs(nowMs)) as { at: string | null };
  return denied.at ? `${r.s}|${denied.at}` : r.s;
}

function readTakers(db: DatabaseSync, nowMs: number): (c: TakerCall) => boolean {
  const rows = prep(db, `SELECT t.login, a.role, t.idle_repos FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id JOIN main.access a ON a.login = t.login
    WHERE ${TAKER_SQL}`).all(...takerArgs(nowMs)) as { login: string; role: string; idle_repos: string | null }[];
  if (!rows.length) return () => false;
  const canWrite = roomCanWrite(db, rows.map((r) => r.login), nowMs);
  const runners = rows.map((h) => {
    let own: string[] | undefined;
    try { own = h.idle_repos ? JSON.parse(h.idle_repos) as string[] : undefined; } catch { /* every repo */ }
    return { login: h.login, role: h.role, repos: claimRepos(db, h.login, own), skip: userSkips(db, h.login) };
  });
  return (c) => runners.some((r) => !(c.someTask && r.skip.size >= TASK_CHOICES.length) && runnerTakes(r, c, canWrite));
}

/** The error of a call withdrawn for lack of a taker: its caller skips the work (NoTakerError). `step`: a taker may take calls on its repos, but none takes its task. */
export const noTakerReason = (repos: readonly string[], step?: string): string => {
  const task = step === undefined ? undefined : taskOfStep(step);
  return `${NO_TAKER_PREFIX} ${task !== undefined ? `of the ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} task (My tasks)` : repos.length ? `on ${repos.join(", ")}` : "that name no repo"}`;
};

/**
 * One maintenance pass at `nowMs`. Each pipeline-on repo with no taker whose user takes some task keeps the time it was first seen so
 * (remote_no_taker); one with a taker loses it. Each queued call with a live caller that is no follow-up and has no pick
 * that counts gets the same mark (no_taker_since), and is withdrawn once the mark is NO_TAKER_MS old. Returns the number of
 * calls withdrawn. Outside the user-local mode the repo marks are cleared.
 */
export function sweepTakers(db: DatabaseSync, nowMs: number = Date.now()): number {
  if (inferenceMode(db) !== "user-local") {
    prep(db, "DELETE FROM main.remote_no_taker").run();
    return 0;
  }
  const takes = takerTest(db, nowMs);
  const repos = (prep(db, "SELECT name FROM main.tracked_repos WHERE pipeline = 1").all() as { name: string }[]).map((r) => r.name);
  const untaken = repos.filter((repo) => !takes({ prompt_id: "", repos: [repo], someTask: true }));
  prep(db, "DELETE FROM main.remote_no_taker WHERE repo NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(untaken));
  const mark = prep(db, "INSERT OR IGNORE INTO main.remote_no_taker (repo, since) VALUES (?, ?)");
  for (const repo of untaken) mark.run(repo, nowMs);

  const marked = new Map((prep(db, "SELECT id, no_taker_since FROM main.remote_calls WHERE state = 'queued' AND no_taker_since IS NOT NULL").all() as { id: number; no_taker_since: number }[])
    .map((r) => [Number(r.id), Number(r.no_taker_since)]));
  const set = prep(db, "UPDATE main.remote_calls SET no_taker_since = ? WHERE id = ? AND state = 'queued'");
  let pickers: Set<string> | null = null;
  let withdrawn = 0;
  for (const c of queueSnapshot(db, nowMs)) {
    const since = marked.get(c.id);
    const own = c.parent_id !== null || c.seen_at < nowMs - CALLER_STALE_MS || pickCounts(c, nowMs, (who) => (pickers ??= pickerLogins(db, nowMs)).has(who));
    if (own || takes(c)) {
      if (since !== undefined) set.run(null, c.id);
    } else if (since === undefined) set.run(nowMs, c.id);
    else if (since <= nowMs - NO_TAKER_MS && withdrawCall(db, c.id, takes({ prompt_id: c.prompt_id, repos: c.repos }) ? noTakerReason(c.repos, c.step) : noTakerReason(c.repos), ["queued"], nowMs)) withdrawn++;
  }
  return withdrawn;
}
