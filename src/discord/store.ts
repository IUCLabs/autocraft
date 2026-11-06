// Mention rows: which tracked items a Discord message refers to. A row holds the item (plain, for counting) and the
// message's guild, channel, id and time sealed with the key file. No text and no author id is kept; an author is
// kept only as a keyed hash that serves a deletion request.
import type { DatabaseSync } from "node:sqlite";
import type { DiscordKeys } from "./keys.ts";
import { parseRefs, type TrackedRepo } from "./refs.ts";

export type DiscordMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; timestamp?: string;
  author?: { id: string; bot?: boolean };
};

export const trackedRepos = (db: DatabaseSync): TrackedRepo[] =>
  db.prepare(`SELECT t.name AS name, COALESCE(r.owner, 'storytold') AS owner FROM main.tracked_repos t LEFT JOIN main.repos r ON r.name = t.name`).all() as TrackedRepo[];

export const isWatched = (db: DatabaseSync, channelId: string): boolean =>
  !!db.prepare("SELECT 1 FROM discord_channels WHERE channel_id = ? AND watched = 1").get(channelId);

/** Sets a message's rows to exactly the items its text names. Returns the number of items it now counts for. */
export function recordMessage(db: DatabaseSync, keys: DiscordKeys, m: DiscordMessage, guildId: string | undefined): number {
  if (m.content === undefined || !guildId) return -1;
  const msgHash = keys.hash("message", m.id);
  const refs = m.author?.bot ? [] : parseRefs(m.content, trackedRepos(db));
  const have = (db.prepare("SELECT repo, number FROM discord_mentions WHERE msg_hash = ?").all(msgHash) as { repo: string; number: number }[]);
  const want = new Set(refs.map((r) => `${r.repo}#${r.number}`));
  const del = db.prepare("DELETE FROM discord_mentions WHERE msg_hash = ? AND repo = ? AND number = ?");
  const ins = db.prepare("INSERT OR IGNORE INTO discord_mentions (msg_hash, repo, number, author_hash, sealed) VALUES (?, ?, ?, ?, ?)");
  const sealed = keys.seal({ guildId, channelId: m.channel_id, messageId: m.id, at: m.timestamp ?? new Date().toISOString() }, msgHash);
  const author = m.author?.id ? keys.hash("author", m.author.id) : null;
  db.exec("BEGIN");
  try {
    for (const h of have) if (!want.has(`${h.repo}#${h.number}`)) del.run(msgHash, h.repo, h.number);
    for (const r of refs) ins.run(msgHash, r.repo, r.number, author, sealed);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return refs.length;
}

export function forgetMessages(db: DatabaseSync, keys: DiscordKeys, ids: string[]): number {
  const del = db.prepare("DELETE FROM discord_mentions WHERE msg_hash = ?");
  let n = 0;
  for (const id of ids) n += Number(del.run(keys.hash("message", id)).changes);
  return n;
}

export function forgetAuthor(db: DatabaseSync, keys: DiscordKeys, userId: string): number {
  return Number(db.prepare("DELETE FROM discord_mentions WHERE author_hash = ?").run(keys.hash("author", userId)).changes);
}

/** Gateway events that change mention rows. Only watched channels are looked at; anything else is dropped unread. */
export function handleDispatch(db: DatabaseSync, keys: DiscordKeys, type: string, d: unknown): void {
  const x = d as Record<string, unknown> & Partial<DiscordMessage>;
  if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") {
    if (typeof x.id !== "string" || typeof x.channel_id !== "string" || !isWatched(db, x.channel_id)) return;
    recordMessage(db, keys, x as DiscordMessage, typeof x.guild_id === "string" ? x.guild_id : channelGuild(db, x.channel_id));
  } else if (type === "MESSAGE_DELETE") {
    if (typeof x.id === "string" && typeof x.channel_id === "string" && isWatched(db, x.channel_id)) forgetMessages(db, keys, [x.id]);
  } else if (type === "MESSAGE_DELETE_BULK") {
    const ids = x.ids;
    if (typeof x.channel_id === "string" && Array.isArray(ids) && isWatched(db, x.channel_id)) forgetMessages(db, keys, ids.filter((i): i is string => typeof i === "string"));
  }
}

const channelGuild = (db: DatabaseSync, channelId: string): string | undefined =>
  (db.prepare("SELECT guild_id FROM discord_channels WHERE channel_id = ?").get(channelId) as { guild_id: string } | undefined)?.guild_id;

export type DiscordLink = { url: string; at: string };

/** Message links of an item, newest first. Empty when the key is missing or a row does not open. */
export function linksOf(db: DatabaseSync, keys: DiscordKeys | null, repo: string, number: number): DiscordLink[] {
  if (!keys) return [];
  const rows = db.prepare("SELECT msg_hash, sealed FROM discord_mentions WHERE repo = ? AND number = ?").all(repo, number) as { msg_hash: string; sealed: string }[];
  return rows.flatMap((r) => {
    const v = keys.open(r.sealed, r.msg_hash);
    return v ? [{ url: `https://discord.com/channels/${v.guildId}/${v.channelId}/${v.messageId}`, at: v.at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export const countOf = (db: DatabaseSync, repo: string, number: number): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM discord_mentions WHERE repo = ? AND number = ?").get(repo, number) as { n: number }).n;

/** What the bot reports about a guild and its text channels, for the admin page. The watched flag is kept across updates. */
export function upsertChannel(db: DatabaseSync, c: { channelId: string; guildId: string; guildName: string | null; name: string | null }): void {
  db.prepare(`INSERT INTO discord_channels (channel_id, guild_id, guild_name, name) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, guild_name = COALESCE(excluded.guild_name, guild_name), name = COALESCE(excluded.name, name)`)
    .run(c.channelId, c.guildId, c.guildName, c.name);
}

export function setStatus(db: DatabaseSync, state: string, detail: string | null): void {
  db.prepare(`INSERT INTO discord_status (id, state, detail, at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, detail = excluded.detail, at = excluded.at`).run(state, detail, new Date().toISOString());
}
