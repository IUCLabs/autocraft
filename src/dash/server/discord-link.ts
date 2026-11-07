// The dashboard side of linking a Discord account: a confirm page for a link token the bot handed out, and the POST that
// stores the link. Both need a dashboard session; an anonymous visitor is sent to sign in and comes back to the same address.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../audit.ts";
import { consumeLinkToken, checkLinkToken, LINK_PATH } from "../../discord/links.ts";
import type { DiscordKeys } from "../../discord/keys.ts";
import type { Res } from "../types.ts";
import { DISCORD_PRIVACY_PATH } from "./discord-privacy.ts";
import { esc, plainPage } from "./util.ts";

const WHY: Record<string, string> = {
  invalid: "This link is not valid. Ask the bot for a new one.",
  expired: "This link has expired. Ask the bot for a new one.",
  used: "This link was already used. Ask the bot for a new one.",
};

const fail = (nonce: string, status: number, text: string): Res => ({ status, html: plainPage(nonce, "Link Discord", `<p>${esc(text)}</p>`) });

export function linkConfirmPage(db: DatabaseSync, keys: DiscordKeys | null, nonce: string, login: string, csrf: string, token: string | null): Res {
  if (!keys) return fail(nonce, 503, "Linking Discord accounts is not set up on this server.");
  const c = token ? checkLinkToken(db, keys, token) : ({ ok: false, reason: "invalid" } as const);
  if (!c.ok) return fail(nonce, 400, WHY[c.reason]!);
  return {
    html: plainPage(nonce, `Link this Discord account to ${login}`, `<p class="muted">The bot will know your Discord account as this GitHub login. Only a keyed hash of your Discord user ID is stored. <a href="${DISCORD_PRIVACY_PATH}">Privacy</a></p>
<form method="post" action="${LINK_PATH}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="t" value="${esc(token)}"><button>Link account</button></form>`),
  };
}

export function linkSubmit(db: DatabaseSync, keys: DiscordKeys | null, nonce: string, login: string, token: string): Res {
  if (!keys) return fail(nonce, 503, "Linking Discord accounts is not set up on this server.");
  const r = consumeLinkToken(db, keys, token, login);
  if (!r.ok) return fail(nonce, 400, WHY[r.reason]!);
  audit(db, login, "discord-link", login);
  return { html: plainPage(nonce, "Discord account linked", `<p>This Discord account is now linked to ${esc(login)}. You can close this page and go back to Discord.</p><p class="muted">To remove the link, choose Unlink Discord in the account menu.</p><p><a class="button" href="/">Open the dashboard</a></p>`) };
}
