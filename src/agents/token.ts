// The long-lived token of an account (`claude setup-token`): a secret kept only
// in `<configDir>/oauth-token` (mode 0600). The database holds when it was set
// and when it was rejected, never the value. The value is read only to build
// the environment of a claude child; nothing here logs or returns it.
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { tokenNearExpiry } from "../sandbox/index.ts";

export const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** The CLI states a validity of one year. */
export const TOKEN_LIFE_MS = 365 * 86_400_000;
const TOKEN_CHARS = "[A-Za-z0-9_-]";
/** A complete token: the match ends before a character that cannot belong to it, or at `end`. */
const TOKEN = new RegExp(`sk-ant-oat01-${TOKEN_CHARS}{20,}(?=[^A-Za-z0-9_-])`);
const TOKEN_AT_END = new RegExp(`sk-ant-oat01-${TOKEN_CHARS}{20,}$`);
/** What the CLI prints when the credential it was given does not work. */
const AUTH_FAILURE = /authentication_error|\b401\b|invalid (?:api key|bearer token|x-api-key)|oauth token (?:has )?(?:expired|revoked|invalid)|token (?:has been )?revoked|please run \/login|not logged in/i;

export const tokenFile = (configDir: string): string => join(configDir, "oauth-token");

/** The token in setup-token output (control codes already removed), or null. With `final`, the output has ended and a token at its end is complete. */
export function extractToken(out: string, final = false): string | null {
  return out.match(TOKEN)?.[0] ?? (final ? out.match(TOKEN_AT_END)?.[0] ?? null : null);
}

/** The CLI's own error text in its output events: error results and error system events, never assistant or tool content. */
export function cliErrorText(parsed: unknown): string {
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const out: string[] = [];
  for (const e of events as { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; error?: unknown; error_status?: unknown }[]) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "result" && e.is_error === true && typeof e.result === "string") out.push(e.result);
    else if (e.type === "system" && /error/i.test(String(e.subtype ?? ""))) out.push(String(e.error ?? ""), String(e.error_status ?? ""));
    else if (e.type === "assistant" && typeof e.error === "string") out.push(e.error);
  }
  return out.join(" ");
}

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}

/** Writes the token through a temporary file in the same directory, then renames it into place. */
export function writeToken(configDir: string, token: string): void {
  const file = tokenFile(configDir), tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* not written */ }
    throw e;
  }
}

export function readToken(configDir: string): string | null {
  try {
    const t = readFileSync(tokenFile(configDir), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export function deleteToken(configDir: string): void {
  try { unlinkSync(tokenFile(configDir)); } catch { /* none there */ }
}

type Row = { set_at: string; rejected_at: string | null };
const rowOf = (db: DatabaseSync, id: string) => db.prepare("SELECT set_at, rejected_at FROM claude_account_tokens WHERE account_id = ?").get(id) as Row | undefined;

/** Records a new token (clearing any rejection). */
export function recordTokenSet(db: DatabaseSync, id: string, now = new Date()): void {
  db.prepare("INSERT INTO claude_account_tokens (account_id, set_at, rejected_at) VALUES (?, ?, NULL) ON CONFLICT (account_id) DO UPDATE SET set_at = excluded.set_at, rejected_at = NULL").run(id, now.toISOString());
}

export function recordTokenRemoved(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM claude_account_tokens WHERE account_id = ?").run(id);
}

/** Marks the token rejected; calls then take the regular sign-in path. */
export function markTokenRejected(db: DatabaseSync, id: string, now = new Date()): void {
  db.prepare("UPDATE claude_account_tokens SET rejected_at = ? WHERE account_id = ?").run(now.toISOString(), id);
}

/** Whether model calls on this account carry its token: the file exists and the token is not marked rejected. */
export function usesToken(db: DatabaseSync, id: string, configDir: string): boolean {
  return !rowOf(db, id)?.rejected_at && readToken(configDir) !== null;
}

/** The extra environment of a model call on this account: its token, when it uses one. */
export function tokenEnv(db: DatabaseSync, id: string, configDir: string): Record<string, string> {
  if (!usesToken(db, id, configDir)) return {};
  const t = readToken(configDir);
  return t ? { [TOKEN_ENV]: t } : {};
}

/** The token state shown on the Accounts page. */
export function tokenView(db: DatabaseSync, id: string, configDir: string): { state: "none" | "set" | "rejected"; setAt: string | null; expiresAt: string | null; rejectedAt: string | null } {
  if (!existsSync(tokenFile(configDir))) return { state: "none", setAt: null, expiresAt: null, rejectedAt: null };
  const r = rowOf(db, id);
  const expiresAt = r ? new Date(Date.parse(r.set_at) + TOKEN_LIFE_MS).toISOString() : null;
  return { state: r?.rejected_at ? "rejected" : "set", setAt: r?.set_at ?? null, expiresAt, rejectedAt: r?.rejected_at ?? null };
}

/**
 * Whether a sandboxed call on this account must wait for a token refresh: never
 * for an account whose token is in use (it needs no refresh), else the login's
 * access token expiring within `marginMs`.
 */
export function credentialsNearExpiry(db: DatabaseSync, id: string, configDir: string, now: number, marginMs: number): boolean {
  return !usesToken(db, id, configDir) && tokenNearExpiry(join(configDir, ".credentials.json"), now, marginMs);
}
