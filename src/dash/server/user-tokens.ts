// user_tokens: the GitHub App user token of each login, written at every
// sign-in while AUTOCRAFT_LOGIN_APP=github-app. It holds the sealed JSON of
// the whole token set, like sessions.token_enc, but is keyed by login so a later
// step can act for a login without a live session. Refresh, revocation and the
// vault around it come later.
import type { DatabaseSync } from "node:sqlite";
import type { TokenBox } from "./crypto.ts";
import type { Tokens } from "./provider.ts";

const aad = (login: string): string => `user_tokens:${login.toLowerCase()}`;

export function saveUserTokens(db: DatabaseSync, box: TokenBox, login: string, githubId: number, tokens: Tokens): void {
  db.prepare(`INSERT INTO user_tokens (login, github_id, token_enc, version, updated_at, status) VALUES (?, ?, ?, 1, ?, 'ok')
              ON CONFLICT (login) DO UPDATE SET github_id = excluded.github_id, token_enc = excluded.token_enc,
                version = user_tokens.version + 1, updated_at = excluded.updated_at, status = 'ok'`)
    .run(login, githubId, box.seal(JSON.stringify(tokens), aad(login)), new Date().toISOString());
}

export function loadUserTokens(db: DatabaseSync, box: TokenBox, login: string): Tokens | null {
  const row = db.prepare("SELECT token_enc FROM user_tokens WHERE login = ? AND status = 'ok'").get(login) as { token_enc: string } | undefined;
  const plain = row ? box.open(row.token_enc, aad(login)) : null;
  try {
    return plain ? (JSON.parse(plain) as Tokens) : null;
  } catch {
    return null;
  }
}
