// A PR whose mergeable state GitHub keeps reporting as unknown. The checks step reads every waiting PR each minute; when a read still
// shows UNKNOWN after UNKNOWN_AFTER_MS, the PR is read again (GitHub computes the merge state when a PR is requested), at most
// UNKNOWN_REREADS times with UNKNOWN_GAP_MS between tries. The merge queue then asks a person (src/core/decide.ts).
import type { DatabaseSync } from "node:sqlite";
import type { Querier } from "../mirror.ts";
import { refreshChecks, type PrChecks } from "../review/checks.ts";

import { UNKNOWN_AFTER_MS, UNKNOWN_GAP_MS, UNKNOWN_REREADS } from "../core/rules.ts";

export { UNKNOWN_AFTER_MS, UNKNOWN_GAP_MS, UNKNOWN_REREADS };

const PREFIX = "mergeable_unknown:";
const keyOf = (repo: string, n: number) => `${PREFIX}${repo}#${n}`;

export type UnknownState = { head: string; since: string; rereads: number; lastAt: string | null };

const parse = (v: string): UnknownState | null => { try { const x = JSON.parse(v) as UnknownState; return typeof x.since === "string" && typeof x.head === "string" ? x : null; } catch { return null; } };

/** Keeps the first time a head was seen with an unknown mergeable state; a known state forgets it. */
export function noteMergeable(db: DatabaseSync, rows: PrChecks[], at: string): void {
  const get = db.prepare("SELECT value FROM main.settings WHERE key = ?");
  const set = db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM main.settings WHERE key = ?");
  for (const r of rows) {
    const k = keyOf(r.repo, r.number);
    const cur = get.get(k) as { value: string } | undefined;
    if (r.mergeable === "MERGEABLE" || r.mergeable === "CONFLICTING" || r.state !== "OPEN") { if (cur) del.run(k); continue; }
    const prev = cur ? parse(cur.value) : null;
    if (!prev || prev.head !== r.head_oid) set.run(k, JSON.stringify({ head: r.head_oid, since: at, rereads: 0, lastAt: null } satisfies UnknownState));
  }
}

/** What the planner needs for one PR at a head, or null when its state is not unknown (or not noted yet). */
export function unknownOf(db: DatabaseSync, repo: string, n: number, head: string): UnknownState | null {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(keyOf(repo, n)) as { value: string } | undefined;
  const s = row ? parse(row.value) : null;
  return s && s.head === head ? s : null;
}

/** Reads the repo's long-unknown PRs again, one try each per UNKNOWN_GAP_MS. Returns the numbers read. */
export async function rereadUnknown(db: DatabaseSync, client: Querier, repo: string, log: (line: string) => void = () => {}, nowMs: number = Date.now()): Promise<number[]> {
  const rows = db.prepare("SELECT key, value FROM main.settings WHERE key LIKE ?").all(`${PREFIX}${repo}#%`) as { key: string; value: string }[];
  const due: { n: number; s: UnknownState }[] = [];
  for (const r of rows) {
    const s = parse(r.value);
    const n = Number(r.key.slice(r.key.lastIndexOf("#") + 1));
    if (!s || !Number.isInteger(n) || s.rereads >= UNKNOWN_REREADS) continue;
    if (Date.parse(s.since) + UNKNOWN_AFTER_MS > nowMs || (s.lastAt !== null && Date.parse(s.lastAt) + UNKNOWN_GAP_MS > nowMs)) continue;
    due.push({ n, s });
  }
  if (!due.length) return [];
  // The count is stored before the read: a failing read still uses up its try.
  const set = db.prepare("UPDATE main.settings SET value = ? WHERE key = ?");
  for (const d of due) set.run(JSON.stringify({ ...d.s, rereads: d.s.rereads + 1, lastAt: new Date(nowMs).toISOString() } satisfies UnknownState), keyOf(repo, d.n));
  await refreshChecks(db, client, repo, due.map((d) => d.n), log);
  log(`checks: ${repo}: read ${due.length} PR${due.length === 1 ? "" : "s"} with an unknown mergeable state again (${due.map((d) => `#${d.n}`).join(", ")})`);
  return due.map((d) => d.n);
}
