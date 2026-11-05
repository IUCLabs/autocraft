// The user-token vault: a usable GitHub App access token for a login, for the dashboard and the runner process alike
// (both open the same database and derive the same TokenBox from the secrets file's session_key).
//
// Refresh protocol. GitHub refresh tokens are single use, and the token set lives in several copies: the login's
// user_tokens row and each session from the same sign-in. Any process may refresh:
//  1. read the row and its `version`; a fresh access token is returned as is;
//  2. otherwise call the refresh endpoint with the row's refresh token;
//  3. store the new pair only if `version` is unchanged (compare-and-swap), then copy it into every other stored
//     copy of the old refresh token (sessions keep running, see shareRefresh);
//  4. a refresh the endpoint rejects may mean another process used the token first: reread a few times, and only
//     when the row stays unchanged mark it `refresh-failed`, also by compare-and-swap.
// There is never a fallback to another identity: a final failure answers "needs sign-in".
import type { DatabaseSync } from "node:sqlite";
import { envVar } from "../env.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import { readSecrets } from "../dash/server/config.ts";
import { GitHubProvider, type Provider, type Tokens } from "../dash/server/provider.ts";
import { failUserTokens, readUserTokens, revocationAad, shareRefresh, swapUserTokens } from "../dash/server/user-tokens.ts";

export type NeedsSignIn = { ok: false; needsSignIn: true; why: "no-token" | "refresh-failed" | "expired" };
/** A transient failure (GitHub unreachable): try again later, the token set is untouched. */
export type Unavailable = { ok: false; needsSignIn: false };
export type UserTokenResult = { ok: true; access: string } | NeedsSignIn | Unavailable;

const EXPIRY_MARGIN = 60_000;
const REREADS = 4;

export class Vault {
  #db: DatabaseSync;
  #box: TokenBox;
  #provider: Provider;
  #inflight = new Map<string, Promise<UserTokenResult>>();
  /** Pause between rereads after a rejected refresh; tests set it to 0. */
  waitMs = 300;

  constructor(db: DatabaseSync, box: TokenBox, provider: Provider) {
    this.#db = db;
    this.#box = box;
    this.#provider = provider;
  }

  /** A usable access token for `login`, refreshed when it is within a minute of expiry or `rejected` (a token GitHub answered 401 to). */
  userToken(login: string, rejected?: string): Promise<UserTokenResult> {
    const key = login.toLowerCase();
    let p = this.#inflight.get(key);
    if (!p) {
      p = this.#obtain(login, rejected).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    return p;
  }

  async #obtain(login: string, rejected: string | undefined): Promise<UserTokenResult> {
    for (let attempt = 0; attempt < REREADS; attempt++) {
      const row = readUserTokens(this.#db, this.#box, login);
      if (!row?.tokens) return { ok: false, needsSignIn: true, why: "no-token" };
      if (row.status !== "ok") return { ok: false, needsSignIn: true, why: "refresh-failed" };
      const t = row.tokens;
      if (t.access !== rejected && (t.expiresAt === null || t.expiresAt - EXPIRY_MARGIN > Date.now())) return { ok: true, access: t.access };
      if (!t.refresh || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= Date.now())) {
        failUserTokens(this.#db, login, row.version);
        return { ok: false, needsSignIn: true, why: "expired" };
      }
      let next: Tokens | null;
      try {
        next = await this.#provider.refresh(t.refresh);
      } catch (e) {
        console.error(`user token refresh: ${(e as Error).message}`);
        return { ok: false, needsSignIn: false };
      }
      if (next) {
        if (swapUserTokens(this.#db, this.#box, login, row.version, next)) {
          shareRefresh(this.#db, this.#box, login, t.refresh, next);
          return { ok: true, access: next.access };
        }
        // Another writer stored a pair first; its pair is the one to use.
        continue;
      }
      // Rejected: either the refresh token is dead, or another process just used it and is about to store the new pair.
      if (this.waitMs) await new Promise((r) => setTimeout(r, this.waitMs));
      const again = readUserTokens(this.#db, this.#box, login);
      if (again && again.version !== row.version) continue;
      if (attempt < REREADS - 1 && this.waitMs) continue;
      if (failUserTokens(this.#db, login, row.version)) return { ok: false, needsSignIn: true, why: "refresh-failed" };
    }
    return { ok: false, needsSignIn: true, why: "refresh-failed" };
  }

  /** Revokes the grants of removed rows (user_tokens deleted with a removed login, revoked session or demotion). Failures are ignored. */
  async sweepRevocations(): Promise<number> {
    const rows = this.#db.prepare("SELECT id, login, token_enc FROM user_token_revocations ORDER BY id").all() as { id: number; login: string; token_enc: string }[];
    for (const r of rows) {
      this.#db.prepare("DELETE FROM user_token_revocations WHERE id = ?").run(r.id);
      try {
        const plain = this.#box.open(r.token_enc, revocationAad(r.login));
        const t = plain ? (JSON.parse(plain) as Tokens) : null;
        if (t) await this.#provider.revokeGrant(t.access);
      } catch { /* best effort */ }
    }
    return rows.length;
  }
}

/** The runner's vault: the app's client credentials and the session key from the secrets file, as the dashboard reads them. Null without the GitHub App secrets. */
export function openVault(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): Vault | null {
  const secrets = readSecrets(envVar("SECRETS_FILE", env));
  if (!secrets.app) return null;
  return new Vault(db, new TokenBox(secrets.sessionKey), new GitHubProvider(secrets.app.clientId, secrets.app.clientSecret));
}
