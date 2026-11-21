// The GitHub App slugs ever seen, kept in settings so the bot stays ours after the app is replaced or its secrets cannot be read.
import type { DatabaseSync } from "node:sqlite";
import { setting, writeSetting } from "../settings-read.ts";

const SLUGS_KEY = "app_slugs";

const parseSlugs = (v: string | undefined): string[] => {
  try {
    const a = JSON.parse(v ?? "[]") as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** Every app slug ever seen (a slug can only be ours), oldest first. */
export const knownSlugs = (db: DatabaseSync): string[] => parseSlugs(setting(db, SLUGS_KEY));

/** Records `slug` in the persisted list when it is new. */
export function rememberSlug(db: DatabaseSync, slug: string): void {
  // Read from the table, not a pass snapshot: another connection may have recorded a slug since the pass began.
  const known = parseSlugs((db.prepare("SELECT value FROM main.settings WHERE key = ?").get(SLUGS_KEY) as { value: string } | undefined)?.value);
  if (known.includes(slug)) return;
  writeSetting(db, SLUGS_KEY, JSON.stringify([...known, slug]));
}

/** The names a comment can address the pipeline by: the pipeline login (when recorded) and every known app slug. Mentioning `@<slug>` also covers `@<slug>[bot]`. */
export function mentionNames(db: DatabaseSync, extra: string | null = null): string[] {
  const box = setting(db, "pipeline_login");
  return [...new Set([...(box ? [box] : []), ...knownSlugs(db), ...(extra ? [extra] : [])])];
}
