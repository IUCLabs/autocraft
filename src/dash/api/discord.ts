// Discord mentions: the admin page's data and writes, and what the item page shows. The channel list and the
// connection state are written by the runner's gateway client (src/discord/); this file only reads them.
import type { DatabaseSync } from "node:sqlite";
import type { DiscordInfo, DiscordSetup } from "../../../web/src/api/types.ts";
import { envVar } from "../../env.ts";
import { audit } from "../audit.ts";
import { HttpError } from "../server/util.ts";
import { DISCORD_PRIVACY_PATH } from "../server/discord-privacy.ts";
import { readKeyFile, type DiscordKeys } from "../../discord/keys.ts";
import { countOf, linksOf } from "../../discord/store.ts";
import type { Req } from "../types.ts";

const PRIVACY_PATH = DISCORD_PRIVACY_PATH;

let cached: { file: string; keys: DiscordKeys | null } | null = null;
/** The key file's keys, when this process has AUTOCRAFT_DISCORD_KEY_FILE and the file is sound; message links need them. */
export function discordKeys(): DiscordKeys | null {
  const file = envVar("DISCORD_KEY_FILE");
  if (!file) return null;
  if (cached?.file === file) return cached.keys;
  let keys: DiscordKeys | null = null;
  try {
    keys = readKeyFile(file);
  } catch { /* the page shows counts without links */ }
  cached = { file, keys };
  return keys;
}

export const contactOf = (db: DatabaseSync): string =>
  (db.prepare("SELECT value FROM settings WHERE key = 'discord_contact'").get() as { value: string } | undefined)?.value ?? "";

/** Count for everyone who sees the item; message links only with the key. */
export function discordOf(db: DatabaseSync, repo: string, n: number): DiscordInfo {
  return { count: countOf(db, repo, n), links: linksOf(db, discordKeys(), repo, n) };
}

const operator = (req: Req): void => {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change the Discord settings");
};
const body = (req: Req): Record<string, unknown> => (req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {});

export function setup(db: DatabaseSync, _req: Req): DiscordSetup {
  const st = db.prepare("SELECT state, detail, at FROM discord_status WHERE id = 1").get() as { state: DiscordSetup["state"]; detail: string | null; at: string } | undefined;
  const channels = db.prepare("SELECT channel_id AS channelId, guild_id AS guildId, guild_name AS guildName, name, watched FROM discord_channels ORDER BY guild_name, name, channel_id").all() as
    { channelId: string; guildId: string; guildName: string | null; name: string | null; watched: number }[];
  return {
    state: st?.state ?? "off", detail: st?.detail ?? null, at: st?.at ?? null,
    channels: channels.map((c) => ({ ...c, watched: !!c.watched })),
    contact: contactOf(db), privacyPath: PRIVACY_PATH,
  };
}

export function putChannel(db: DatabaseSync, req: Req): DiscordSetup {
  operator(req);
  const id = body(req).channelId, watched = body(req).watched;
  if (typeof id !== "string" || typeof watched !== "boolean") throw new HttpError(400, "channelId and watched are required");
  const r = db.prepare("UPDATE discord_channels SET watched = ? WHERE channel_id = ?").run(watched ? 1 : 0, id);
  if (!r.changes) throw new HttpError(404, "the bot has not reported that channel");
  audit(db, req.user.login, watched ? "discord-watch" : "discord-unwatch", id);
  return setup(db, req);
}

export function putContact(db: DatabaseSync, req: Req): DiscordSetup {
  operator(req);
  const c = body(req).contact;
  if (typeof c !== "string" || c.length > 300) throw new HttpError(400, "contact must be text of at most 300 characters");
  db.prepare("INSERT INTO settings (key, value) VALUES ('discord_contact', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(c.trim());
  audit(db, req.user.login, "discord-contact", null);
  return setup(db, req);
}
