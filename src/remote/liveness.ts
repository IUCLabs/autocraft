// The dashboard's liveness stamp. Helpers reach the server only through the dashboard, so while it is down, stalled or
// restarting no heartbeat can arrive, and a lease must not be counted as lost for that. The dashboard stamps the
// `remote_liveness` row every ALIVE_EVERY_MS; job processes, which expire leases (calls.ts expireLeases), read it.
import type { DatabaseSync } from "node:sqlite";

export const ALIVE_EVERY_MS = 5_000;
/** A stamp older than this means the dashboard is not serving: down, stalled or restarting. */
export const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS;

/**
 * Writes the stamp. After a gap (the previous stamp is stale) every leased call's heartbeat, lease and run start move
 * forward by the gap, capped at now, so neither the idle window nor the time limit counts the time no helper could reach
 * the server; the unbroken run of stamps then starts afresh.
 */
export function stampAlive(db: DatabaseSync, nowMs: number = Date.now()): void {
  // Another request's transaction is open on this connection (across an await): the next tick stamps.
  if (db.isTransaction) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare("SELECT alive_at FROM main.remote_liveness WHERE id = 1").get() as { alive_at: number } | undefined;
    if (!r) db.prepare("INSERT INTO main.remote_liveness (id, alive_at, since) VALUES (1, ?, ?)").run(nowMs, nowMs);
    else if (nowMs - Number(r.alive_at) > ALIVE_STALE_MS) {
      const gap = nowMs - Number(r.alive_at);
      db.prepare(`UPDATE main.remote_calls SET heartbeat_at = MIN(heartbeat_at + ?1, ?2), leased_at = MIN(leased_at + ?1, ?2),
          started_at = CASE WHEN started_at IS NULL THEN NULL ELSE MIN(started_at + ?1, ?2) END
        WHERE state = 'leased'`).run(gap, nowMs);
      db.prepare("UPDATE main.remote_liveness SET alive_at = ?, since = ? WHERE id = 1").run(nowMs, nowMs);
    } else db.prepare("UPDATE main.remote_liveness SET alive_at = ? WHERE id = 1").run(nowMs);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already ended */ }
    throw e;
  }
}

/**
 * Whether the dashboard is serving now, and since when without a gap. A database the dashboard never stamped (no
 * dashboard has run against it) counts as always alive.
 */
export function dashboardAlive(db: DatabaseSync, nowMs: number): { alive: boolean; since: number } {
  const r = db.prepare("SELECT alive_at, since FROM main.remote_liveness WHERE id = 1").get() as { alive_at: number; since: number } | undefined;
  if (!r) return { alive: true, since: -Infinity };
  return { alive: nowMs - Number(r.alive_at) <= ALIVE_STALE_MS, since: Number(r.since) };
}

/** Starts the stamp timer in the dashboard process; returns the function that stops it. */
export function startLiveness(db: DatabaseSync): () => void {
  const tick = (): void => {
    try { stampAlive(db); } catch (e) { console.log(`liveness stamp not written: ${(e as Error).message}`); }
  };
  tick();
  const t = setInterval(tick, ALIVE_EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}
