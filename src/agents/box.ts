// What this machine offers, read from files named by environment variables so
// that paths stay outside the repository and never reach the API, the logs or
// the UI:
//   CRAFT_AUTO_ACCOUNTS       JSON file: [{ "id": "b", "configDir": "/path" }]
//   CRAFT_AUTO_USAGE_DIR      directory with one <id>.json usage reading per account
//   CRAFT_AUTO_USAGE_REFRESH  command that refreshes the readings (run by the runner)
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type BoxAccount = { id: string; configDir: string };

/** Accounts of the box config, in file order. An unreadable or malformed file yields none. */
export function boxAccounts(): BoxAccount[] {
  const file = process.env.CRAFT_AUTO_ACCOUNTS;
  if (!file) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: BoxAccount[] = [];
    for (const a of raw as { id?: unknown; configDir?: unknown }[]) {
      if (typeof a?.id !== "string" || !ACCOUNT_ID.test(a.id) || typeof a.configDir !== "string" || !a.configDir || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ id: a.id, configDir: a.configDir });
    }
    return out;
  } catch {
    return [];
  }
}

export type Reading = {
  writtenAt: number;                       // unix seconds
  fiveHour: { pct: number; resetsAt: number | null } | null;
  weekly: { pct: number; resetsAt: number | null } | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function window(w: unknown): { pct: number; resetsAt: number | null } | null {
  const o = w as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  const pct = num(o?.used_percentage);
  return pct === null ? null : { pct, resetsAt: num(o?.resets_at) };
}

/** The latest usage reading of one account: only `<id>.json` in the usage directory is read. */
export function readUsage(id: string): Reading | null {
  const dir = process.env.CRAFT_AUTO_USAGE_DIR;
  if (!dir || !ACCOUNT_ID.test(id)) return null;
  try {
    const j = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { written_at?: unknown; rate_limits?: { five_hour?: unknown; seven_day?: unknown } };
    const writtenAt = num(j.written_at);
    if (writtenAt === null) return null;
    return { writtenAt, fiveHour: window(j.rate_limits?.five_hour), weekly: window(j.rate_limits?.seven_day) };
  } catch {
    return null;
  }
}

export const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();
