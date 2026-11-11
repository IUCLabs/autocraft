// Binds each author login with PR history to the GitHub account id it belongs to, so a login that later passes to another account
// does not inherit the history (tiersOf reads author_ids). The sync binds ids as it writes rows; this step covers history written earlier.
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_OWNER } from "./owners.ts";
import type { Querier } from "./mirror.ts";

const BATCH = 40;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** Logins whose merged or closed PRs count toward a tier and that have no bound account id. */
export function unboundLogins(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT DISTINCT author FROM items WHERE kind = 'pr' AND author IS NOT NULL AND state IN ('MERGED','CLOSED')
    AND NOT EXISTS (SELECT 1 FROM author_ids a WHERE a.login = items.author) ORDER BY author`).all() as { author: string }[]).map((r) => r.author);
}

async function lookup(client: Querier, logins: string[], out: Map<string, number>): Promise<void> {
  if (!logins.length) return;
  const body = logins.map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) { databaseId }`).join(" ");
  try {
    const data = await client.query(`query($owner: String!) { rateLimit { cost remaining resetAt } ${body} }`, { owner: DEFAULT_OWNER });
    logins.forEach((l, i) => { const id = data?.[`u${i}`]?.databaseId; if (typeof id === "number") out.set(l, id); });
  } catch (e) {
    // GitHub answers NOT_FOUND for a deleted account and fails the whole query: split until the missing ones stand alone.
    if ((e as { type?: string })?.type !== "NOT_FOUND" || logins.length === 1) { if (logins.length === 1 && (e as { type?: string })?.type === "NOT_FOUND") return; throw e; }
    const mid = logins.length >> 1;
    await lookup(client, logins.slice(0, mid), out);
    await lookup(client, logins.slice(mid), out);
  }
}

/**
 * First binds ids already stored on item rows (no GitHub call), then asks GitHub once, in batches, for the logins still unbound.
 * Does nothing when every login is bound. Returns how many logins it bound.
 */
export async function backfillAuthorIds(db: DatabaseSync, client: Querier | null): Promise<number> {
  const bind = db.prepare("INSERT OR IGNORE INTO main.author_ids (login, id) VALUES (?, ?)");
  let n = 0;
  const known = db.prepare(`SELECT author, author_id FROM items WHERE author IS NOT NULL AND author_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM author_ids a WHERE a.login = items.author) GROUP BY author ORDER BY MIN(created_at)`).all() as { author: string; author_id: number }[];
  for (const r of known) n += Number(bind.run(r.author, r.author_id).changes);
  const missing = unboundLogins(db).filter((l) => LOGIN.test(l));
  if (!client || !missing.length) return n;
  const found = new Map<string, number>();
  for (let i = 0; i < missing.length; i += BATCH) await lookup(client, missing.slice(i, i + BATCH), found);
  for (const [login, id] of found) n += Number(bind.run(login, id).changes);
  return n;
}
