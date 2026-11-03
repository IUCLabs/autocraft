// The pilot: an operator setting that limits the whole pipeline to a list of items ("repo#number") and whole repos ("repo").
// Empty or absent means no pilot. A Fix PR the pipeline opened for a pilot issue counts as a pilot item.
// No Node imports besides the type, so candidate queries can use the SQL fragments.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";

export const PILOT_KEY = "pilot_items";

export class PilotError extends Error {
  status = 400;
}

const REF = /^([A-Za-z0-9._-]+)(?:#([1-9][0-9]*))?$/;

/** The stored list; an unreadable value counts as no pilot. */
export function pilotItems(db: DatabaseSync): string[] {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(PILOT_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The repos the pilot names (by item or whole), or null when no pilot is set. */
export function pilotRepos(db: DatabaseSync): Set<string> | null {
  const items = pilotItems(db);
  return items.length ? new Set(items.map((i) => i.split("#")[0]!)) : null;
}

/** Parses refs separated by whitespace or commas; throws on a malformed one or an untracked repo. */
export function parsePilotRefs(db: DatabaseSync, input: unknown): string[] {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/).filter(Boolean) : null;
  if (!parts || parts.some((p) => typeof p !== "string")) throw new PilotError("items must be a list of repo#number or repo");
  const tracked = new Set((db.prepare("SELECT name FROM main.tracked_repos").all() as { name: string }[]).map((r) => r.name));
  const out: string[] = [];
  for (const p of parts as string[]) {
    const m = REF.exec(p);
    if (!m) throw new PilotError(`not a repo#number or repo: ${p}`);
    if (!tracked.has(m[1]!)) throw new PilotError(`${m[1]} is not tracked`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 200) throw new PilotError("at most 200 items");
  return out;
}

/** Replaces the list; an empty list clears the pilot. Returns the stored list. */
export function setPilot(db: DatabaseSync, by: string, input: unknown): string[] {
  const refs = parsePilotRefs(db, input);
  if (refs.length) db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(PILOT_KEY, JSON.stringify(refs));
  else db.prepare("DELETE FROM main.settings WHERE key = ?").run(PILOT_KEY);
  audit(db, by, refs.length ? "pilot-set" : "pilot-clear", PILOT_KEY, { items: refs });
  return refs;
}

const LIST = `(SELECT CASE WHEN json_valid(ps.value) THEN ps.value ELSE '[]' END FROM main.settings ps WHERE ps.key = '${PILOT_KEY}')`;

/** SQL condition on an item given by its repo and number expressions: true with no pilot, else when it is a pilot item, in a pilot repo, or the Fix PR of a pilot issue. */
export const pilotSqlFor = (repo: string, number: string): string =>
  `(COALESCE(json_array_length(${LIST}), 0) = 0
    OR EXISTS (SELECT 1 FROM json_each(${LIST}) pj WHERE pj.value = ${repo} || '#' || ${number} OR pj.value = ${repo})
    OR EXISTS (SELECT 1 FROM main.fix_attempts pf, json_each(${LIST}) pj WHERE pf.repo = ${repo} AND pf.pr_url LIKE '%/pull/' || ${number}
      AND pj.value = pf.repo || '#' || pf.number))`;

/** The same for a row `alias` of items. */
export const pilotSql = (alias: string): string => pilotSqlFor(`${alias}.repo`, `${alias}.number`);

/** True when the item is in the pilot, or no pilot is set. */
export function inPilot(db: DatabaseSync, repo: string, number: number): boolean {
  return !!db.prepare(`SELECT 1 WHERE ${pilotSqlFor("?1", "CAST(?2 AS INTEGER)")}`).get(repo, number);
}
