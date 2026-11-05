// Personal tokens for the Inbox MCP server. A signed-in user makes one on the
// Connect page and gives it to their own agent; the agent calls POST /mcp with
// it as a bearer token and acts as that user. Only the token's hash is stored,
// and a token counts only while its login is on the access list: the role is
// read from the list on every call, so a role change applies at once.
import type { DatabaseSync } from "node:sqlite";
import type { Role } from "../types.ts";
import { randomToken, sha256hex } from "../server/crypto.ts";
import { HttpError } from "../server/util.ts";

const DAY = 86_400_000;
export const MCP_TOKEN_TTL = 90 * DAY;
export const MCP_TOKENS_PER_LOGIN = 5;
export const MCP_TOKEN_PREFIX = "acmcp_";
const LABEL_MAX = 60;
const TOUCH_EVERY = 60_000;

export type McpTokenRow = { id: number; label: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string };
export type McpCaller = { tokenId: number; login: string; role: Role };

const toRow = (r: { id: number; label: string | null; created_at: string; last_used_at: string | null; expires_at: string }): McpTokenRow =>
  ({ id: Number(r.id), label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at });

/** The login's live tokens, newest first. */
export function listTokens(db: DatabaseSync, login: string): McpTokenRow[] {
  return (db.prepare("SELECT id, label, created_at, last_used_at, expires_at FROM mcp_tokens WHERE login = ? AND expires_at > ? ORDER BY created_at DESC, id DESC")
    .all(login, new Date().toISOString()) as { id: number; label: string | null; created_at: string; last_used_at: string | null; expires_at: string }[]).map(toRow);
}

/** A new token for `login`; the plain value is returned once and never stored. */
export function createToken(db: DatabaseSync, login: string, rawLabel: unknown): { token: string; row: McpTokenRow } {
  if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== "string") throw new HttpError(400, "label must be a string");
  const label = (rawLabel ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LABEL_MAX) || null;
  if (listTokens(db, login).length >= MCP_TOKENS_PER_LOGIN) throw new HttpError(409, `you have ${MCP_TOKENS_PER_LOGIN} tokens; revoke one first`);
  const token = `${MCP_TOKEN_PREFIX}${randomToken(32)}`;
  const now = new Date();
  const r = db.prepare("INSERT INTO mcp_tokens (login, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?) RETURNING id, label, created_at, last_used_at, expires_at")
    .get(login, sha256hex(token), label, now.toISOString(), new Date(now.getTime() + MCP_TOKEN_TTL).toISOString()) as Parameters<typeof toRow>[0];
  return { token, row: toRow(r) };
}

/** Revokes one of the login's own tokens; false when it has no such token. */
export function revokeToken(db: DatabaseSync, login: string, id: number): boolean {
  return db.prepare("DELETE FROM mcp_tokens WHERE id = ? AND login = ?").run(id, login).changes === 1;
}

/** Ends every token of a login (it left the access list). */
export function endTokens(db: DatabaseSync, login: string): number {
  return Number(db.prepare("DELETE FROM mcp_tokens WHERE login = ?").run(login).changes);
}

/** The caller a bearer token stands for, or null when it is unknown, expired or its login is off the access list. */
export function loadToken(db: DatabaseSync, token: string | undefined): McpCaller | null {
  if (!token || token.length > 200 || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const now = new Date();
  const row = db.prepare(`SELECT t.id, t.login, t.last_used_at, a.role FROM mcp_tokens t JOIN access a ON a.login = t.login
    WHERE t.token_hash = ? AND t.expires_at > ?`).get(sha256hex(token), now.toISOString()) as
    { id: number; login: string; last_used_at: string | null; role: Role } | undefined;
  if (!row) return null;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > TOUCH_EVERY) db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  return { tokenId: Number(row.id), login: row.login, role: row.role };
}

export function pruneTokens(db: DatabaseSync): void {
  db.prepare("DELETE FROM mcp_tokens WHERE expires_at <= ?").run(new Date().toISOString());
}
