// Cool-off of the user-local mode, per login: a login whose helpers keep losing leases (no heartbeat, past a time limit) or
// keep failing calls (`ok: false` replies in a row) gets no calls for a while, so a broken helper stops holding and failing
// calls other helpers could run. Revoking a token does not end it; an operator does (`autocraft remote cooloff clear`).
import type { DatabaseSync } from "node:sqlite";
import { scaled } from "./time-scale.ts";
import { audit } from "../dash/audit.ts";

/** Lease drops of one login within DROP_WINDOW_MS that start a cool-off. */
export const DROP_LIMIT = 3;
export const DROP_WINDOW_MS = scaled(2 * 3600_000);
/** A token's drops count at most once in this long: one outage or one stuck machine is one drop. */
export const DROP_DEDUPE_MS = scaled(10 * 60_000);
/** How long lost leases cool a login off. */
export const COOLOFF_MS = scaled(6 * 3600_000);
/** Failed replies in a row, within FAILURE_WINDOW_MS of the first, that start a cool-off. */
export const FAILURE_LIMIT = 5;
export const FAILURE_WINDOW_MS = scaled(30 * 60_000);
/** How long failed replies cool a login off. */
export const FAILURE_COOLOFF_MS = scaled(3600_000);

export const DROP_REASON = `its leases were lost ${DROP_LIMIT} times within 2 hours (no heartbeat, or past the call's time limit)`;
export const FAILURE_REASON = `its helpers failed ${FAILURE_LIMIT} calls in a row within 30 minutes`;

function coolOff(db: DatabaseSync, login: string, until: number, reason: string): void {
  db.prepare(`INSERT INTO main.remote_cooloffs (login, until, reason, failures, failures_since) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT (login) DO UPDATE SET until = excluded.until, reason = excluded.reason, failures = 0, failures_since = NULL`).run(login, until, reason);
  db.prepare("DELETE FROM main.remote_lease_drops WHERE login = ?").run(login);
  audit(db, login, "remote-cooloff", login, { until, reason });
}

/** Records a lost lease of `tokenId`, held by `login`; the DROP_LIMIT-th drop of the login within the window starts the cool-off. */
export function noteDrop(db: DatabaseSync, tokenId: number, login: string, nowMs: number): void {
  if (db.prepare("SELECT 1 FROM main.remote_lease_drops WHERE token_id = ? AND at > ?").get(tokenId, nowMs - DROP_DEDUPE_MS)) return;
  db.prepare("INSERT INTO main.remote_lease_drops (token_id, login, at) VALUES (?, ?, ?)").run(tokenId, login, nowMs);
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM main.remote_lease_drops WHERE login = ? AND at >= ?").get(login, nowMs - DROP_WINDOW_MS) as { n: number }).n);
  if (n >= DROP_LIMIT) coolOff(db, login, nowMs + COOLOFF_MS, DROP_REASON);
}

/** Records a failed reply of `login`'s helper; the FAILURE_LIMIT-th in a row within the window starts the cool-off. */
export function noteFailure(db: DatabaseSync, login: string, nowMs: number): void {
  const r = db.prepare("SELECT failures, failures_since FROM main.remote_cooloffs WHERE login = ?").get(login) as { failures: number; failures_since: number | null } | undefined;
  const fresh = !r || r.failures_since === null || Number(r.failures_since) < nowMs - FAILURE_WINDOW_MS;
  const failures = fresh ? 1 : Number(r.failures) + 1;
  if (failures >= FAILURE_LIMIT) return coolOff(db, login, nowMs + FAILURE_COOLOFF_MS, FAILURE_REASON);
  db.prepare(`INSERT INTO main.remote_cooloffs (login, failures, failures_since) VALUES (?, ?, ?)
    ON CONFLICT (login) DO UPDATE SET failures = excluded.failures, failures_since = excluded.failures_since`).run(login, failures, fresh ? nowMs : r!.failures_since);
}

/** An accepted reply ends the login's run of failures. */
export function noteSuccess(db: DatabaseSync, login: string): void {
  db.prepare("UPDATE main.remote_cooloffs SET failures = 0, failures_since = NULL WHERE login = ? AND failures > 0").run(login);
}

/** When the login's helpers may claim again and why they may not now, or null when the login is not cooling off. */
export function cooloffOf(db: DatabaseSync, login: string, nowMs: number): { until: number; reason: string } | null {
  const r = db.prepare("SELECT until, reason FROM main.remote_cooloffs WHERE login = ?").get(login) as { until: number | null; reason: string | null } | undefined;
  return r?.until != null && Number(r.until) > nowMs ? { until: Number(r.until), reason: r.reason ?? DROP_REASON } : null;
}

/** Deletes drops older than the window and cool-off rows that neither hold a login nor count failures (calls.ts pruneRemote). */
export function pruneCooloffs(db: DatabaseSync, nowMs: number): void {
  db.prepare("DELETE FROM main.remote_lease_drops WHERE at < ?").run(nowMs - DROP_WINDOW_MS);
  db.prepare("DELETE FROM main.remote_cooloffs WHERE COALESCE(until, 0) <= ? AND (failures = 0 OR failures_since < ?)").run(nowMs, nowMs - FAILURE_WINDOW_MS);
}

/** Ends the login's cool-off and forgets its drops and failures; false when it was not cooling off. */
export function clearCooloff(db: DatabaseSync, login: string, by: string, nowMs: number = Date.now()): boolean {
  const was = cooloffOf(db, login, nowMs) !== null;
  db.prepare("DELETE FROM main.remote_cooloffs WHERE login = ?").run(login);
  db.prepare("DELETE FROM main.remote_lease_drops WHERE login = ?").run(login);
  if (was) audit(db, by, "remote-cooloff-clear", login, {});
  return was;
}
