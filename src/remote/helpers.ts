// The readiness of the user-local helpers: each helper sends its status (POST ROUTES.status) on every change and at least
// every STATUS_EVERY_S while it runs; the last one is kept per agent token. The planner's room counts only helpers whose
// last status is `ready` and fresh (room.ts); the Connect page and my_work list the user's own.
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../dash/server/util.ts";
import { cooloffOf } from "./cooloff.ts";
import { isTier } from "./mode.ts";
import { READINESS, STATUS_EVERY_S, type HarnessId, type HelperInfo, type HelperStatus, type Readiness, type Reserve, type Tier, type UsageReading, type UsageWindow } from "./protocol.ts";

/** The session route listing the signed-in user's helpers (GET, reply `{ helpers: HelperInfo[] }`). */
export const HELPERS_PATH = "/api/remote/helpers";

/** A status this old no longer counts: one report interval and a minute of slack. */
export const STATUS_FRESH_MS = (STATUS_EVERY_S + 60) * 1000;

const HARNESSES: HarnessId[] = ["claude", "codex"];
const REASON_MAX = 300;

const isoTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const percent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

function parseWindow(v: unknown, name: string): UsageWindow | null {
  if (v === null || v === undefined) return null;
  const w = v as Record<string, unknown>;
  if (typeof v !== "object" || !percent(w.usedPercent) || !(w.resetsAt === null || isoTime(w.resetsAt))) throw new HttpError(400, `usage.${name} must be { usedPercent: 0-100, resetsAt: ISO time or null }`);
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt as string | null };
}

/** The status body, checked; throws HttpError 400 for a malformed one. */
export function parseStatus(raw: unknown): HelperStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a HelperStatus object");
  const s = raw as Record<string, unknown>;
  if (!READINESS.includes(s.readiness as Readiness)) throw new HttpError(400, `readiness must be one of ${READINESS.join(", ")}`);
  if (s.until !== undefined && s.until !== null && !isoTime(s.until)) throw new HttpError(400, "until must be an ISO time");
  if (s.reason !== undefined && typeof s.reason !== "string") throw new HttpError(400, "reason must be a string");
  if (!HARNESSES.includes(s.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  const models: Partial<Record<Tier, string>> = {};
  if (!s.models || typeof s.models !== "object" || Array.isArray(s.models)) throw new HttpError(400, "models must map a tier to a model");
  for (const [t, m] of Object.entries(s.models as Record<string, unknown>)) {
    if (!isTier(t) || typeof m !== "string" || !m || m.length > 100) throw new HttpError(400, `models.${t}: a known tier with a model name`);
    models[t] = m;
  }
  const r = s.reserve as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !percent(r.fiveHour) || !percent(r.weekly)) throw new HttpError(400, "reserve must be { fiveHour, weekly }, each 0-100");
  let usage: UsageReading | undefined;
  if (s.usage !== undefined && s.usage !== null) {
    const u = s.usage as Record<string, unknown>;
    if (typeof u !== "object" || !isoTime(u.at)) throw new HttpError(400, "usage must be { fiveHour, weekly, at }");
    usage = { fiveHour: parseWindow(u.fiveHour, "fiveHour"), weekly: parseWindow(u.weekly, "weekly"), at: u.at };
  }
  const reason = typeof s.reason === "string" ? s.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX) : "";
  const count = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 64) throw new HttpError(400, `${name} must be a whole number from 0 to 64`);
    return v;
  };
  const slots = count(s.slots, "slots"), busy = count(s.busy, "busy");
  let lastError: HelperStatus["lastError"];
  if (s.lastError !== undefined && s.lastError !== null) {
    const e = s.lastError as Record<string, unknown>;
    if (typeof e !== "object" || typeof e.text !== "string" || !isoTime(e.at)) throw new HttpError(400, "lastError must be { text, at }");
    lastError = { text: e.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX), at: e.at };
  }
  return {
    slots, busy: Math.min(busy, slots), ...(lastError && { lastError }),
    readiness: s.readiness as Readiness, ...(isoTime(s.until) && { until: s.until }), ...(reason && { reason }),
    harness: s.harness as HarnessId, models, reserve: { fiveHour: r.fiveHour as number, weekly: r.weekly as number }, ...(usage && { usage }),
  };
}

/** Keeps a helper's status as the last one of its token; rows of deleted tokens go. */
export function storeStatus(db: DatabaseSync, tokenId: number, login: string, s: HelperStatus, nowMs: number = Date.now()): void {
  db.prepare(`INSERT INTO main.remote_helpers (token_id, login, readiness, until, reason, harness, models, reserve, usage, reported_at, slots, busy, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_id) DO UPDATE SET login = excluded.login, readiness = excluded.readiness, until = excluded.until, reason = excluded.reason, harness = excluded.harness,
      models = excluded.models, reserve = excluded.reserve, usage = excluded.usage, reported_at = excluded.reported_at,
      slots = excluded.slots, busy = excluded.busy, last_error = excluded.last_error`)
    .run(tokenId, login, s.readiness, s.until ?? null, s.reason ?? null, s.harness, JSON.stringify(s.models), JSON.stringify(s.reserve), s.usage ? JSON.stringify(s.usage) : null, nowMs, s.slots, s.busy, s.lastError ? JSON.stringify(s.lastError) : null);
  db.prepare("DELETE FROM main.remote_helpers WHERE token_id NOT IN (SELECT id FROM main.mcp_tokens)").run();
}

/** The login's helpers: every live token that may run tasks, with its last status. */
export function listHelpers(db: DatabaseSync, login: string, nowMs: number = Date.now()): HelperInfo[] {
  const rows = db.prepare(`SELECT t.id, t.label, t.last_used_at, h.readiness, h.until, h.reason, h.harness, h.models, h.reserve, h.usage, h.reported_at, h.slots, h.busy, h.last_error
      FROM main.mcp_tokens t LEFT JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.login = ? AND t.can_run = 1 AND t.expires_at > ? ORDER BY t.created_at DESC, t.id DESC`).all(login, new Date(nowMs).toISOString()) as
    { id: number; label: string | null; last_used_at: string | null; readiness: Readiness | null; until: string | null; reason: string | null; harness: HarnessId | null; models: string | null; reserve: string | null; usage: string | null; reported_at: number | null; slots: number | null; busy: number | null; last_error: string | null }[];
  const cooloff = cooloffOf(db, login, nowMs);
  return rows.map((r) => {
    const reported = r.reported_at === null ? null : Number(r.reported_at);
    const used = r.last_used_at ? Date.parse(r.last_used_at) : null;
    const seen = Math.max(reported ?? -Infinity, used ?? -Infinity);
    // The server's own cool-off of the login shows even before the helper has reported it.
    const cooled = cooloff !== null && r.readiness !== "cooled-off";
    return {
      tokenId: Number(r.id), label: r.label, slots: r.slots === null ? null : Number(r.slots), busy: r.busy === null ? null : Number(r.busy),
      lastError: r.last_error ? JSON.parse(r.last_error) as { text: string; at: string } : null,
      ...(cooled ? { readiness: "cooled-off" as const, until: new Date(cooloff.until).toISOString(), reason: cooloff.reason } : { readiness: r.readiness, until: r.until, reason: r.reason }),
      fresh: reported !== null && nowMs - reported <= STATUS_FRESH_MS,
      lastSeen: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
      harness: r.harness, models: r.models ? JSON.parse(r.models) as Partial<Record<Tier, string>> : {},
      reserve: r.reserve ? JSON.parse(r.reserve) as Reserve : null, usage: r.usage ? JSON.parse(r.usage) as UsageReading : null,
    };
  });
}
