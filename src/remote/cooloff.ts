// Flap cool-off of the user-local mode: a token whose leases keep ending without a release or a reply (the helper lost its
// heartbeat, or ran past the call's time limit) gets no calls for a while, so a helper that keeps dropping them stops
// holding calls other helpers could run. Drops are not call failures: the call's attempt counting is unchanged (calls.ts).
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";

/** Lease drops of one token within DROP_WINDOW_MS that start a cool-off. */
export const DROP_LIMIT = 3;
export const DROP_WINDOW_MS = 2 * 3600_000;
/** How long a cooled-off token gets nothing. */
export const COOLOFF_MS = 6 * 3600_000;

/** Records a dropped lease of `tokenId`; starts the cool-off (and counts afresh afterwards) when it is the DROP_LIMIT-th within the window. */
export function noteDrop(db: DatabaseSync, tokenId: number, nowMs: number): void {
  db.prepare("DELETE FROM main.remote_lease_drops WHERE token_id = ? AND at < ?").run(tokenId, nowMs - DROP_WINDOW_MS);
  db.prepare("INSERT INTO main.remote_lease_drops (token_id, at) VALUES (?, ?)").run(tokenId, nowMs);
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM main.remote_lease_drops WHERE token_id = ?").get(tokenId) as { n: number }).n);
  if (n < DROP_LIMIT) return;
  const t = db.prepare("SELECT login FROM main.mcp_tokens WHERE id = ?").get(tokenId) as { login: string } | undefined;
  if (!t) return;
  db.prepare("UPDATE main.mcp_tokens SET cooloff_until = ? WHERE id = ?").run(nowMs + COOLOFF_MS, tokenId);
  db.prepare("DELETE FROM main.remote_lease_drops WHERE token_id = ?").run(tokenId);
  audit(db, t.login, "remote-cooloff", String(tokenId), { until: nowMs + COOLOFF_MS });
}

/** When the token may claim again, or null when it is not cooling off. */
export function cooloffUntil(db: DatabaseSync, tokenId: number, nowMs: number): number | null {
  const r = db.prepare("SELECT cooloff_until FROM main.mcp_tokens WHERE id = ?").get(tokenId) as { cooloff_until: number | null } | undefined;
  return r?.cooloff_until != null && r.cooloff_until > nowMs ? Number(r.cooloff_until) : null;
}

export const COOLOFF_REASON = `its leases were lost ${DROP_LIMIT} times within ${DROP_WINDOW_MS / 3600_000} hours (no heartbeat, or past the call's time limit)`;

/** Clears the cool-off of the tokens matching an id or a login; returns how many were cooling off. */
export function clearCooloff(db: DatabaseSync, who: string, by: string, nowMs: number = Date.now()): number {
  const rows = (/^\d+$/.test(who)
    ? db.prepare("SELECT id, login FROM main.mcp_tokens WHERE id = ? AND cooloff_until > ?").all(Number(who), nowMs)
    : db.prepare("SELECT id, login FROM main.mcp_tokens WHERE login = ? COLLATE NOCASE AND cooloff_until > ?").all(who, nowMs)) as { id: number; login: string }[];
  for (const r of rows) {
    db.prepare("UPDATE main.mcp_tokens SET cooloff_until = NULL WHERE id = ?").run(r.id);
    db.prepare("DELETE FROM main.remote_lease_drops WHERE token_id = ?").run(r.id);
    audit(db, by, "remote-cooloff-clear", String(r.id), { login: r.login });
  }
  return rows.length;
}
