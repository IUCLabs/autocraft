// Optional Discord mention counting. It runs only when AUTOCRAFT_DISCORD_TOKEN_FILE and AUTOCRAFT_DISCORD_KEY_FILE
// are set; the runner starts it next to the worker server. See docs/pipeline.md.
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../db.ts";
import { audit } from "../dash/audit.ts";
import { envVar } from "../env.ts";
import { Gateway } from "./gateway.ts";
import { DiscordConfigError, readKeyFile, readTokenFile, type DiscordKeys } from "./keys.ts";
import { forgetAuthor, forgetMessages, handleDispatch, setStatus, upsertChannel } from "./store.ts";

type Channel = { id: string; name?: string; type?: number };
const TEXT_CHANNEL = new Set([0, 5]);

/** Keeps the channel list the admin page shows; no message is involved. */
export function handleMeta(db: DatabaseSync, type: string, d: unknown): void {
  const x = d as { id?: string; name?: string; guild_id?: string; type?: number; channels?: Channel[] };
  if (type === "GUILD_CREATE" && x.id) {
    for (const c of x.channels ?? []) if (c.type === undefined || TEXT_CHANNEL.has(c.type)) upsertChannel(db, { channelId: c.id, guildId: x.id, guildName: x.name ?? null, name: c.name ?? null });
  } else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && x.id && x.guild_id && (x.type === undefined || TEXT_CHANNEL.has(x.type))) {
    upsertChannel(db, { channelId: x.id, guildId: x.guild_id, guildName: null, name: x.name ?? null });
  } else if (type === "CHANNEL_DELETE" && x.id) {
    db.prepare("DELETE FROM discord_channels WHERE channel_id = ?").run(x.id);
  } else if (type === "GUILD_DELETE" && x.id && !(d as { unavailable?: boolean }).unavailable) {
    db.prepare("DELETE FROM discord_channels WHERE guild_id = ?").run(x.id);
  }
}

/** Starts the gateway when configured. A bad configuration or a failed connection is logged and never stops the caller. */
export function startDiscord(db: DatabaseSync, signal: AbortSignal, log: (l: string) => void): void {
  const tokenFile = envVar("DISCORD_TOKEN_FILE");
  if (!tokenFile) return;
  let token: string, keys: DiscordKeys;
  try {
    token = readTokenFile(tokenFile);
    const keyFile = envVar("DISCORD_KEY_FILE");
    if (!keyFile) throw new DiscordConfigError("AUTOCRAFT_DISCORD_KEY_FILE is not set");
    keys = readKeyFile(keyFile);
  } catch (e) {
    log(`runner: Discord not started: ${(e as Error).message}`);
    setStatus(db, "failed", (e as Error).message);
    return;
  }
  const gw = new Gateway({
    token,
    log,
    onState: (state, detail) => setStatus(db, state, detail),
    onDispatch: (type, d) => {
      handleMeta(db, type, d);
      handleDispatch(db, keys, type, d);
    },
  });
  log("runner: Discord mention counting started");
  void gw.run(signal).catch((e: Error) => log(`runner: Discord stopped: ${e.message}`));
}

const USAGE = `usage: autocraft discord forget --message <message link or id> | --user <user id>
       autocraft discord channels
       autocraft discord watch <channel id> | unwatch <channel id>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function keysOrDie(): DiscordKeys {
  const f = envVar("DISCORD_KEY_FILE");
  if (!f) die("AUTOCRAFT_DISCORD_KEY_FILE is not set");
  try {
    return readKeyFile(f);
  } catch (e) {
    return die((e as Error).message);
  }
}

// Recorded in the audit log as `cli`: only someone with a shell on the host can run this.
function discord(args: string[]): void {
  const [sub, a, b] = args;
  const db = connect();
  if (sub === "forget" && (a === "--message" || a === "--user") && b) {
    const keys = keysOrDie();
    const id = a === "--message" ? (/\/channels\/\d+\/\d+\/(\d+)\/?(?:[?#].*)?$/.exec(b)?.[1] ?? (/^\d+$/.test(b) ? b : die("not a Discord message link or id"))) : /^\d+$/.test(b) ? b : die("not a Discord user id");
    const n = a === "--message" ? forgetMessages(db, keys, [id]) : forgetAuthor(db, keys, id);
    audit(db, "cli", "discord-forget", a === "--message" ? "message" : "user", { rows: n });
    console.log(`deleted ${n} mention ${n === 1 ? "row" : "rows"}`);
  } else if (sub === "channels") {
    for (const c of db.prepare("SELECT channel_id, guild_name, name, watched FROM discord_channels ORDER BY guild_name, name").all() as { channel_id: string; guild_name: string | null; name: string | null; watched: number }[])
      console.log(`${c.watched ? "watched " : "-       "} ${c.channel_id} ${c.guild_name ?? "?"} / #${c.name ?? "?"}`);
  } else if ((sub === "watch" || sub === "unwatch") && a) {
    const r = db.prepare("UPDATE discord_channels SET watched = ? WHERE channel_id = ?").run(sub === "watch" ? 1 : 0, a);
    if (!r.changes) die("no such channel; the bot has not reported it");
    audit(db, "cli", sub === "watch" ? "discord-watch" : "discord-unwatch", a);
    console.log(`${sub === "watch" ? "watching" : "no longer watching"} ${a}`);
  } else die(USAGE);
}

export const commands = {
  discord: { summary: "Discord mentions: forget --message|--user | channels | watch | unwatch", run: (args: string[]) => discord(args) },
};
