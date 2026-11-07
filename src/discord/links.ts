// Links between a Discord account and a dashboard login. The Discord user id is never stored: a link holds its keyed hash.
// The bot hands out a signed, single-use token; opening it while signed in to the dashboard and confirming stores the link.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeEqual } from "../dash/server/crypto.ts";
import type { DiscordKeys } from "./keys.ts";

export const LINK_PATH = "/link/discord";
export const TOKEN_TTL_MS = 10 * 60_000;

type Claims = { u: string; e: number; n: string };

const userHash = (keys: DiscordKeys, discordUserId: string): string => keys.hash("author", discordUserId);

/** A token that lets whoever holds it link `discordUserId` to their login for ten minutes, once. */
export function createLinkToken(keys: DiscordKeys, discordUserId: string, now = Date.now()): string {
  const claims: Claims = { u: userHash(keys, discordUserId), e: now + TOKEN_TTL_MS, n: randomBytes(12).toString("base64url") };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${keys.sign("link", body)}`;
}

export const linkUrl = (baseUrl: string, token: string): string => `${baseUrl.replace(/\/+$/, "")}${LINK_PATH}?${new URLSearchParams({ t: token })}`;

export type TokenCheck = { ok: true; claims: Claims } | { ok: false; reason: "invalid" | "expired" | "used" };

/** Checks signature, expiry and that the token has not been used. Reads only. */
export function checkLinkToken(db: DatabaseSync, keys: DiscordKeys, token: string, now = Date.now()): TokenCheck {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || !safeEqual(sig, keys.sign("link", body))) return { ok: false, reason: "invalid" };
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof claims.u !== "string" || typeof claims.n !== "string" || typeof claims.e !== "number") return { ok: false, reason: "invalid" };
  if (claims.e <= now) return { ok: false, reason: "expired" };
  if (db.prepare("SELECT 1 FROM discord_link_nonces WHERE nonce = ?").get(claims.n)) return { ok: false, reason: "used" };
  return { ok: true, claims };
}

/** Spends the token and links its Discord account to `login`; a Discord account has one login, so an earlier link of it is replaced. */
export function consumeLinkToken(db: DatabaseSync, keys: DiscordKeys, token: string, login: string, now = Date.now()): TokenCheck {
  const c = checkLinkToken(db, keys, token, now);
  if (!c.ok) return c;
  const at = new Date(now).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM discord_link_nonces WHERE expires_at <= ?").run(at);
    const spent = db.prepare("INSERT OR IGNORE INTO discord_link_nonces (nonce, expires_at) VALUES (?, ?)").run(c.claims.n, new Date(c.claims.e).toISOString());
    if (!spent.changes) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "used" };
    }
    db.prepare(`INSERT INTO discord_links (user_hash, login, linked_at) VALUES (?, ?, ?)
      ON CONFLICT(user_hash) DO UPDATE SET login = excluded.login, linked_at = excluded.linked_at`).run(c.claims.u, login, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return c;
}

/** The dashboard login linked to a Discord user, or null. */
export const loginOf = (db: DatabaseSync, keys: DiscordKeys, discordUserId: string): string | null =>
  (db.prepare("SELECT login FROM discord_links WHERE user_hash = ?").get(userHash(keys, discordUserId)) as { login: string } | undefined)?.login ?? null;

/** Removes every link of a login; returns how many. */
export const unlinkLogin = (db: DatabaseSync, login: string): number =>
  Number(db.prepare("DELETE FROM discord_links WHERE login = ?").run(login).changes);

/** Removes one link by its row id (the keyed hash); returns the login it belonged to, or null. */
export function unlinkRow(db: DatabaseSync, id: string): string | null {
  const row = db.prepare("SELECT login FROM discord_links WHERE user_hash = ?").get(id) as { login: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM discord_links WHERE user_hash = ?").run(id);
  return row.login;
}

/** Part of a deletion request by Discord user id. */
export const forgetLink = (db: DatabaseSync, keys: DiscordKeys, discordUserId: string): number =>
  Number(db.prepare("DELETE FROM discord_links WHERE user_hash = ?").run(userHash(keys, discordUserId)).changes);

export type LinkRow = { id: string; login: string; linkedAt: string };
export const listLinks = (db: DatabaseSync): LinkRow[] =>
  db.prepare("SELECT user_hash AS id, login, linked_at AS linkedAt FROM discord_links ORDER BY login, linked_at").all() as LinkRow[];

export const linkedSince = (db: DatabaseSync, login: string): string | null =>
  (db.prepare("SELECT MIN(linked_at) AS at FROM discord_links WHERE login = ?").get(login) as { at: string | null }).at;
