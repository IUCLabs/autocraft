// Each user's "Manual only" switch for their Task Runners, stored in `user_settings` under `manual_only` ('1' when on): the
// runners take only the calls the user picked ("Run on my Task Runner", picks.ts) and follow-ups of the user's own sessions
// (calls.ts claimOrder). The planner's room (room.ts), the authors' give-way rule (calls.ts idleOthers) and the
// `remote-starved` health check leave such runners out. No row means off.
import type { DatabaseSync } from "node:sqlite";
import { prep } from "../sql-cache.ts";
import { audit } from "../dash/audit.ts";

export const MANUAL_ONLY_KEY = "manual_only";

/** SQL that is true when the login in column `col` has Manual only on. */
export const manualSql = (col: string): string =>
  `EXISTS (SELECT 1 FROM main.user_settings mo WHERE mo.login = ${col} AND mo.key = '${MANUAL_ONLY_KEY}' AND mo.value = '1')`;

export function manualOnly(db: DatabaseSync, login: string): boolean {
  return prep(db, "SELECT 1 FROM main.user_settings WHERE login = ? AND key = ? AND value = '1'").get(login, MANUAL_ONLY_KEY) !== undefined;
}

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseManualOnly(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("manualOnly must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export function setManualOnly(db: DatabaseSync, login: string, on: boolean): boolean {
  const was = manualOnly(db, login);
  if (!on) prep(db, "DELETE FROM main.user_settings WHERE login = ? AND key = ?").run(login, MANUAL_ONLY_KEY);
  else prep(db, "INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, '1', ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(login, MANUAL_ONLY_KEY, new Date().toISOString());
  if (was !== on) audit(db, login, "manual-only", login, { manualOnly: on });
  return on;
}
