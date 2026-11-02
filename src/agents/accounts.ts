// Claude accounts: which ones an operator enabled, how busy and how full they
// are, and the choice of an account for the next model call.
//
// Only accounts present in the box config (box.ts) are listed. Their config
// directories stay in this process: nothing here returns one.
import type { DatabaseSync } from "node:sqlite";
import type { AccountInput, ClaudeAccount } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { boxAccounts, iso, readUsage, type BoxAccount, type Reading } from "./box.ts";

export const FIVE_HOUR_LIMIT = 90;
export const WEEKLY_LIMIT = 95;
/** A reading older than this counts as unknown, and unknown is allowed. */
export const STALE_MS = 30 * 60_000;
/** A run still "running" after this long belongs to a process that is gone; it no longer takes a slot. */
export const RUN_SLOT_MS = 60 * 60_000;
export const MAX_CONCURRENT_LIMIT = 20;
export const LABEL_MAX = 40;

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = { id: string; label: string; enabled: number; max_concurrent: number };

/** Adds a row (disabled, labelled with its id) for each account of the box config that has none. */
export function syncAccounts(db: DatabaseSync, box: BoxAccount[] = boxAccounts()): void {
  const ins = db.prepare("INSERT OR IGNORE INTO claude_accounts (id, label) VALUES (?, ?)");
  for (const a of box) ins.run(a.id, a.id);
}

const fresh = (r: Reading | null, nowMs: number): Reading | null => (r && nowMs - r.writtenAt * 1000 <= STALE_MS ? r : null);

/** Why a fresh reading blocks new calls, or null. */
export function headroomReason(r: Reading | null, nowMs: number = Date.now()): string | null {
  const f = fresh(r, nowMs);
  if (!f) return null;
  if (f.fiveHour && f.fiveHour.pct >= FIVE_HOUR_LIMIT) return `5-hour use ${Math.round(f.fiveHour.pct)} % (pauses at ${FIVE_HOUR_LIMIT} %)`;
  if (f.weekly && f.weekly.pct >= WEEKLY_LIMIT) return `weekly use ${Math.round(f.weekly.pct)} % (pauses at ${WEEKLY_LIMIT} %)`;
  return null;
}

function runningCounts(db: DatabaseSync, nowMs: number): Map<string, number> {
  const since = new Date(nowMs - RUN_SLOT_MS).toISOString();
  const rows = db.prepare("SELECT account_id AS id, COUNT(*) AS n FROM agent_runs WHERE state = 'running' AND account_id IS NOT NULL AND started_at >= ? GROUP BY account_id")
    .all(since) as { id: string; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

function rows(db: DatabaseSync, box: BoxAccount[]): Row[] {
  if (!box.length) return [];
  const all = db.prepare("SELECT id, label, enabled, max_concurrent FROM claude_accounts").all() as Row[];
  const byId = new Map(all.map((r) => [r.id, r]));
  return box.flatMap((b) => (byId.has(b.id) ? [byId.get(b.id)!] : []));
}

function toAccount(r: Row, running: number, reading: Reading | null, nowMs: number): ClaudeAccount {
  return {
    id: r.id, label: r.label, enabled: r.enabled === 1, maxConcurrent: r.max_concurrent, running,
    usage: {
      fiveHourPct: reading?.fiveHour?.pct ?? null,
      fiveHourResetsAt: reading?.fiveHour?.resetsAt != null ? iso(reading.fiveHour.resetsAt) : null,
      weeklyPct: reading?.weekly?.pct ?? null,
      weeklyResetsAt: reading?.weekly?.resetsAt != null ? iso(reading.weekly.resetsAt) : null,
      readAt: reading ? iso(reading.writtenAt) : null,
    },
    pausedReason: r.enabled === 1 ? headroomReason(reading, nowMs) : null,
  };
}

/** Every account of the box config, enabled or not, in config order. */
export function listAccounts(db: DatabaseSync, nowMs: number = Date.now()): ClaudeAccount[] {
  const box = boxAccounts();
  syncAccounts(db, box);
  const counts = runningCounts(db, nowMs);
  return rows(db, box).map((r) => toAccount(r, counts.get(r.id) ?? 0, readUsage(r.id), nowMs));
}

export function updateAccount(db: DatabaseSync, id: unknown, input: unknown, by: string): ClaudeAccount {
  const box = boxAccounts();
  if (typeof id !== "string" || !box.some((b) => b.id === id)) throw new AccountError(404, "no such account");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountError(400, "the body must be a JSON object");
  const o = input as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => !["label", "enabled", "maxConcurrent"].includes(k));
  if (bad) throw new AccountError(400, `${bad} cannot be set`);
  if (o.label !== undefined) {
    if (typeof o.label !== "string") throw new AccountError(400, "label must be text");
    const l = o.label.trim();
    if (!l || l.length > LABEL_MAX || /[\u0000-\u001f<>@]/.test(l)) throw new AccountError(400, `label must be 1 to ${LABEL_MAX} characters without @, < or > (never an email address)`);
    o.label = l;
  }
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") throw new AccountError(400, "enabled must be true or false");
  if (o.maxConcurrent !== undefined && (typeof o.maxConcurrent !== "number" || !Number.isInteger(o.maxConcurrent) || o.maxConcurrent < 1 || o.maxConcurrent > MAX_CONCURRENT_LIMIT)) {
    throw new AccountError(400, `maxConcurrent must be a whole number from 1 to ${MAX_CONCURRENT_LIMIT}`);
  }
  syncAccounts(db, box);
  const before = rows(db, box).find((r) => r.id === id)!;
  const next = {
    label: (o.label as string | undefined) ?? before.label,
    enabled: (o.enabled as boolean | undefined) ?? before.enabled === 1,
    maxConcurrent: (o.maxConcurrent as number | undefined) ?? before.max_concurrent,
  };
  db.prepare("UPDATE claude_accounts SET label = ?, enabled = ?, max_concurrent = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .run(next.label, next.enabled ? 1 : 0, next.maxConcurrent, by, new Date().toISOString(), id);
  audit(db, by, "account-change", `account:${id}`, {
    ...(next.label !== before.label && { label: next.label, was: before.label }),
    ...(next.enabled !== (before.enabled === 1) && { enabled: next.enabled }),
    ...(next.maxConcurrent !== before.max_concurrent && { maxConcurrent: next.maxConcurrent }),
  });
  return listAccounts(db).find((a) => a.id === id)!;
}

export type Choice =
  | { account: { id: string; configDir: string } }
  | { wait: string }          // enabled accounts exist, none can take a call now
  | { none: true };           // no account is enabled

/** The enabled account with a free slot and headroom that has the lowest weekly use. */
export function chooseAccount(db: DatabaseSync, nowMs: number = Date.now()): Choice {
  const box = boxAccounts();
  syncAccounts(db, box);
  const enabled = rows(db, box).filter((r) => r.enabled === 1);
  if (!enabled.length) return { none: true };
  const counts = runningCounts(db, nowMs);
  const reasons: string[] = [];
  const ok: { r: Row; weekly: number; running: number }[] = [];
  for (const r of enabled) {
    const reading = readUsage(r.id), running = counts.get(r.id) ?? 0;
    const why = headroomReason(reading, nowMs);
    if (why) reasons.push(`${r.label}: ${why}`);
    else if (running >= r.max_concurrent) reasons.push(`${r.label}: ${running} of ${r.max_concurrent} slots in use`);
    else ok.push({ r, weekly: fresh(reading, nowMs)?.weekly?.pct ?? 0, running });
  }
  if (!ok.length) return { wait: reasons.join("; ") };
  ok.sort((a, b) => a.weekly - b.weekly || a.running - b.running || a.r.id.localeCompare(b.r.id));
  const pick = ok[0]!.r;
  return { account: { id: pick.id, configDir: box.find((b) => b.id === pick.id)!.configDir } };
}

/**
 * Why Claude-model stages are paused, or null: no account is enabled, or every
 * enabled account is out of headroom. A busy account is not a pause; calls wait for a slot.
 */
export function claudePauseReason(db: DatabaseSync, nowMs: number = Date.now()): string | null {
  const box = boxAccounts();
  syncAccounts(db, box);
  const enabled = rows(db, box).filter((r) => r.enabled === 1);
  if (!enabled.length) return "paused: no Claude account is enabled";
  const reasons: string[] = [];
  for (const r of enabled) {
    const why = headroomReason(readUsage(r.id), nowMs);
    if (!why) return null;
    reasons.push(`${r.label}: ${why}`);
  }
  return `paused: no Claude account has headroom (${reasons.join("; ")})`;
}

// ---- usage samples ---------------------------------------------------------------

export const SAMPLE_KEEP_MS = 30 * 86_400_000;

/** Records each account's current reading once (keyed by the reading's time). Returns how many were new. */
export function recordUsageSamples(db: DatabaseSync, nowMs: number = Date.now()): number {
  const ins = db.prepare("INSERT OR IGNORE INTO account_usage_samples (account_id, t, five_hour_pct, weekly_pct) VALUES (?, ?, ?, ?)");
  let n = 0;
  for (const a of boxAccounts()) {
    const r = readUsage(a.id);
    if (!r) continue;
    n += Number(ins.run(a.id, iso(r.writtenAt), r.fiveHour?.pct ?? null, r.weekly?.pct ?? null).changes);
  }
  db.prepare("DELETE FROM account_usage_samples WHERE t < ?").run(new Date(nowMs - SAMPLE_KEEP_MS).toISOString());
  return n;
}
