// Protection of model spend from authors outside the team (docs/pipeline.md, "Outside authors").
//
// An outside author is an item's author who is not an operator or maintainer of the dashboard, not a GitHub Bot account (an app can open items only where it is installed),
// not a member, owner or collaborator of the repo (the mirror's author association), and not whitelisted (the Contributors page:
// an `allow` override or a whitelisted tier). Two protections, each off at 0:
//   - Daily budget: of one outside author's items created in the last 24 hours, only the first `outside_prs_per_day` PRs and the
//     first `outside_issues_per_day` issues get model work. Later open ones wait until the window frees.
//   - Surge breaker: more than `outside_surge_per_hour` new outside-author items in the last hour trips the stage_trips row
//     `outside-surge`. Outside-author items created from an hour before the trip hold until an operator resumes it.
// An operator's Release exempts one item (or every held item of one author) from both holds.
//
// The planner calls refreshOutsideHolds() once per pass; it rewrites outside_holds. pilotSqlFor (src/pilot.ts) leaves a held item
// out of scope, so every stage that reads candidates through the pilot condition skips it. Sync, Embed and Rank do not use it.
import type { DatabaseSync } from "node:sqlite";
import { listAccess } from "./access.ts";
import { audit } from "./dash/audit.ts";
import { allOwnLogins } from "./github/identity.ts";
import type { OutsideHoldInfo } from "./core/plan.ts";
import { sinceOf, trip, tripRow } from "./push-outcomes.ts";
import { isWhitelisted } from "./whitelist.ts";

export const OUTSIDE_SURGE = "outside-surge";
export const KEYS = { prsPerDay: "outside_prs_per_day", issuesPerDay: "outside_issues_per_day", surgePerHour: "outside_surge_per_hour" } as const;
export type OutsideLimits = { prsPerDay: number; issuesPerDay: number; surgePerHour: number };
export const DEFAULT_LIMITS: OutsideLimits = { prsPerDay: 5, issuesPerDay: 5, surgePerHour: 30 };
const MAX = 100_000;
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

export class OutsideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function outsideLimits(db: DatabaseSync): OutsideLimits {
  const rows = db.prepare("SELECT key, value FROM main.settings WHERE key IN (?, ?, ?)").all(KEYS.prsPerDay, KEYS.issuesPerDay, KEYS.surgePerHour) as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const get = (k: string, d: number): number => { const v = m.get(k); return v !== undefined && Number.isInteger(v) && v >= 0 ? v : d; };
  return { prsPerDay: get(KEYS.prsPerDay, DEFAULT_LIMITS.prsPerDay), issuesPerDay: get(KEYS.issuesPerDay, DEFAULT_LIMITS.issuesPerDay), surgePerHour: get(KEYS.surgePerHour, DEFAULT_LIMITS.surgePerHour) };
}

/** Stores the three numbers (0 turns a protection off) and audits the change. */
export function setOutsideLimits(db: DatabaseSync, by: string, input: unknown): OutsideLimits {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const was = outsideLimits(db);
  const next = { ...was };
  for (const k of Object.keys(KEYS) as (keyof OutsideLimits)[]) {
    if (b[k] === undefined) continue;
    const v = b[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX) throw new OutsideError(`${k} must be a whole number from 0 to ${MAX}`);
    next[k] = v;
  }
  const set = db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  for (const k of Object.keys(KEYS) as (keyof OutsideLimits)[]) set.run(KEYS[k], String(next[k]));
  if (JSON.stringify(was) !== JSON.stringify(next)) audit(db, by, "abuse-limits", "pipeline", { ...next, was });
  return next;
}

type Row = { repo: string; number: number; kind: string; author: string; state: string; created_at: string; author_association: string | null; author_type: string | null };
export type Hold = { repo: string; number: number; author: string; kind: "pr" | "issue"; reason: "limit" | "surge" };

const INSIDE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Logins that are never outside authors: the dashboard's operators and maintainers and the pipeline's own accounts (lowercase). */
function insiders(db: DatabaseSync): Set<string> {
  const out = new Set<string>();
  for (const a of listAccess(db)) if (a.role === "operator" || a.role === "maintainer") out.add(a.login.toLowerCase());
  for (const l of allOwnLogins(db)) out.add(l.toLowerCase());
  return out;
}

export type OutsideRefresh = { holds: Hold[]; tripped: boolean; wakeAt: number | null };

/**
 * Recomputes the holds from the items created in the last 24 hours, evaluates the surge breaker and rewrites outside_holds
 * (only when the set changed). Returns the holds and the time the first hold can lapse.
 */
export function refreshOutsideHolds(db: DatabaseSync, now: number = Date.now()): OutsideRefresh {
  const lim = outsideLimits(db);
  const enabled = lim.prsPerDay > 0 || lim.issuesPerDay > 0 || lim.surgePerHour > 0;
  const holds: Hold[] = [];
  let wakeAt: number | null = null;
  const released = new Set((db.prepare("SELECT repo, number FROM main.outside_released").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
  if (enabled) {
    const rows = db.prepare("SELECT repo, number, kind, author, state, created_at, author_association, author_type FROM items WHERE created_at >= ? AND author IS NOT NULL")
      .all(new Date(now - DAY_MS).toISOString()) as Row[];
    const inside = insiders(db);
    const memo = new Map<string, boolean>();
    const whitelisted = (login: string): boolean => {
      const k = login.toLowerCase();
      let v = memo.get(k);
      if (v === undefined) { v = isWhitelisted(db, login).ok; memo.set(k, v); }
      return v;
    };
    const cheap = rows.filter((r) => !INSIDE_ASSOCIATIONS.has(r.author_association ?? "") && r.author_type !== "Bot" && !r.author.endsWith("[bot]") && !inside.has(r.author.toLowerCase()));

    // Surge: outside-author items of the last hour since the last resume.
    if (lim.surgePerHour > 0 && !tripRow(db, OUTSIDE_SURGE)?.active) {
      const since = Math.max(now - HOUR_MS, Date.parse(sinceOf(db, OUTSIDE_SURGE)) || 0);
      const recent = cheap.filter((r) => Date.parse(r.created_at) > since);
      // The whitelist is read only when the cheap count already passes the threshold.
      const real = recent.length > lim.surgePerHour ? recent.filter((r) => !whitelisted(r.author)) : [];
      if (real.length > lim.surgePerHour) {
        const byAuthor = new Map<string, number>();
        for (const r of real) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
        const top = [...byAuthor].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}: ${n}`);
        trip(db, OUTSIDE_SURGE, `${real.length} new items from outside authors in the last hour (more than ${lim.surgePerHour})`, top, new Date(now).toISOString());
      }
    }
    // The whitelist check runs for the authors the rules may hold.
    const surge = lim.surgePerHour > 0 ? tripRow(db, OUTSIDE_SURGE) : undefined;
    const surgeFrom = surge?.active ? Date.parse(surge.tripped_at) - HOUR_MS : null;
    const groups = new Map<string, Row[]>();
    for (const r of cheap) {
      const k = `${r.author.toLowerCase()}|${r.kind}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    for (const rs of groups.values()) {
      rs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
      const kind = rs[0]!.kind === "pr" ? "pr" as const : "issue" as const;
      const limit = kind === "pr" ? lim.prsPerDay : lim.issuesPerDay;
      const overLimit = limit > 0 && rs.length > limit;
      const inSurge = surgeFrom !== null && rs.some((r) => Date.parse(r.created_at) >= surgeFrom);
      if (!overLimit && !inSurge) continue;
      if (whitelisted(rs[0]!.author)) continue;
      rs.forEach((r, i) => {
        if (r.state !== "OPEN" || released.has(`${r.repo}#${r.number}`)) return;
        const surged = surgeFrom !== null && Date.parse(r.created_at) >= surgeFrom;
        if (surged) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "surge" });
        else if (overLimit && i >= limit) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "limit" });
      });
      if (overLimit) { const t = Date.parse(rs[0]!.created_at) + DAY_MS; wakeAt = wakeAt === null ? t : Math.min(wakeAt, t); }
    }
  }
  const have = db.prepare("SELECT repo, number, author, kind, reason FROM main.outside_holds").all() as Hold[];
  const key = (h: Hold) => `${h.repo}#${h.number}|${h.author}|${h.kind}|${h.reason}`;
  const want = new Set(holds.map(key));
  if (have.length !== holds.length || have.some((h) => !want.has(key(h)))) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM main.outside_holds");
      const ins = db.prepare("INSERT INTO main.outside_holds (repo, number, author, kind, reason) VALUES (?, ?, ?, ?, ?)");
      for (const h of holds) ins.run(h.repo, h.number, h.author, h.kind, h.reason);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { holds, tripped: !!tripRow(db, OUTSIDE_SURGE)?.active, wakeAt };
}

/** The wait text of a held item (the registered wait "author over daily limit", and the surge variant). */
export function holdWait(h: Pick<OutsideHoldInfo, "reason" | "kind" | "limit">): string {
  return h.reason === "surge" ? "the outside-surge breaker, until an operator resumes it" : `author's daily limit (${h.limit} new ${h.kind === "pr" ? "PRs" : "issues"} a day)`;
}

/** The holds as `repo#number` to their reason. */
export function holdMap(db: DatabaseSync): Map<string, OutsideHoldInfo> {
  const rows = db.prepare("SELECT repo, number, author, kind, reason FROM main.outside_holds").all() as Hold[];
  if (!rows.length) return new Map();
  const lim = outsideLimits(db);
  return new Map(rows.map((h) => [`${h.repo}#${h.number}`, { reason: h.reason, author: h.author, kind: h.kind, limit: h.kind === "pr" ? lim.prsPerDay : lim.issuesPerDay }]));
}

/** An operator exempts one held item from both holds. */
export function releaseOutside(db: DatabaseSync, by: string, repo: string, number: number): void {
  const h = db.prepare("SELECT author FROM main.outside_holds WHERE repo = ? AND number = ?").get(repo, number) as { author: string } | undefined;
  if (!h) throw new OutsideError(`${repo}#${number} is not held for its author`, 409);
  const at = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO main.outside_released (repo, number, by, at) VALUES (?, ?, ?, ?)").run(repo, number, by, at);
  db.prepare("DELETE FROM main.outside_holds WHERE repo = ? AND number = ?").run(repo, number);
  audit(db, by, "outside-release", `${repo}#${number}`, { author: h.author });
}

/** An operator exempts every item now held for one author. Returns how many. */
export function releaseAuthor(db: DatabaseSync, by: string, author: string): number {
  const rows = db.prepare("SELECT repo, number FROM main.outside_holds WHERE author = ? COLLATE NOCASE").all(author) as { repo: string; number: number }[];
  if (!rows.length) throw new OutsideError(`nothing is held for ${author}`, 409);
  const at = new Date().toISOString();
  const ins = db.prepare("INSERT OR IGNORE INTO main.outside_released (repo, number, by, at) VALUES (?, ?, ?, ?)");
  for (const r of rows) ins.run(r.repo, r.number, by, at);
  db.prepare("DELETE FROM main.outside_holds WHERE author = ? COLLATE NOCASE").run(author);
  audit(db, by, "outside-release-author", author, { items: rows.length });
  return rows.length;
}

export type OutsideState = OutsideLimits & { heldByLimit: number; heldBySurge: number; authors: number; tripped: { reason: string; since: string } | null };

export function outsideState(db: DatabaseSync): OutsideState {
  const c = db.prepare("SELECT SUM(reason = 'limit') AS l, SUM(reason = 'surge') AS s, COUNT(DISTINCT author) AS a FROM main.outside_holds").get() as { l: number | null; s: number | null; a: number };
  const t = tripRow(db, OUTSIDE_SURGE);
  return { ...outsideLimits(db), heldByLimit: c.l ?? 0, heldBySurge: c.s ?? 0, authors: c.a, tripped: t?.active ? { reason: t.reason, since: t.tripped_at } : null };
}
