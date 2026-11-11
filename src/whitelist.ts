// Contributor whitelist: an automatic tier from merge history, with owner
// overrides that always win.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";
import { connect } from "./db.ts";

export type Tier = "whitelisted" | "not" | "allow" | "deny";

export const TIER_LABEL: Record<Tier, string> = {
  whitelisted: "whitelisted",
  not: "not whitelisted",
  allow: "override allow",
  deny: "override deny",
};

export type Rule = { minMerged: number; minRate: number };

export type Contributor = {
  login: string;
  merged: number;
  closed: number;          // closed without merge
  open: number;
  rate: number | null;     // merged / (merged + closed); null with no finished PRs
  last_merge: string | null;
  repos: string;           // comma-separated
  override: "allow" | "deny" | null;
  note: string | null;     // private
  override_by: string | null;
  override_at: string | null;
  tier: Tier;
};

export function getRule(db: DatabaseSync): Rule {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('whitelist_min_merged','whitelist_min_merge_rate')").all() as { key: string; value: string }[];
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { minMerged: Number(m.whitelist_min_merged ?? 5), minRate: Number(m.whitelist_min_merge_rate ?? 0.6) };
}

export function setRule(db: DatabaseSync, rule: Rule, by: string): void {
  if (!Number.isInteger(rule.minMerged) || rule.minMerged < 0) throw new Error("min merged must be a whole number ≥ 0");
  if (!(rule.minRate >= 0 && rule.minRate <= 1)) throw new Error("min merge rate must be between 0 and 1");
  const set = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  set.run("whitelist_min_merged", String(rule.minMerged));
  set.run("whitelist_min_merge_rate", String(rule.minRate));
  audit(db, by, "rule", "whitelist", rule);
}

export function tierOf(merged: number, closed: number, override: string | null, rule: Rule): Tier {
  if (override === "allow" || override === "deny") return override;
  const done = merged + closed;
  return merged >= rule.minMerged && done > 0 && merged / done >= rule.minRate ? "whitelisted" : "not";
}

// SQL for per-author PR stats; the `items_pr_author` index covers it.
export const STATS_SQL = `
  SELECT author AS login,
         SUM(state = 'MERGED') AS merged,
         SUM(state = 'CLOSED') AS closed,
         SUM(state = 'OPEN') AS open,
         MAX(merged_at) AS last_merge
  FROM items WHERE kind = 'pr' AND author IS NOT NULL`;

export type AuthorRef = { login: string; id: number | null };
export const tierKey = (a: AuthorRef): string => `${a.login}\0${a.id ?? ""}`;

/**
 * Tiers of the given authors, from one stats query. A login string can pass to another GitHub account: when the account id differs
 * from the one first seen under the login, the history and an allow override are not this account's, so the tier is "not" (a deny still holds).
 */
export function tiersOf(db: DatabaseSync, authors: AuthorRef[]): Map<string, Tier> {
  const out = new Map<string, Tier>();
  if (!authors.length) return out;
  const logins = [...new Set(authors.map((a) => a.login))];
  const rule = getRule(db);
  const marks = logins.map(() => "?").join(",");
  const stats = new Map((db.prepare(`${STATS_SQL} AND author IN (${marks}) GROUP BY author`).all(...logins) as { login: string; merged: number; closed: number }[]).map((r) => [r.login, r]));
  const over = new Map((db.prepare(`SELECT login, status FROM whitelist_overrides WHERE login IN (${marks})`).all(...logins) as { login: string; status: string }[]).map((r) => [r.login, r.status]));
  const bound = new Map((db.prepare(`SELECT login, id FROM author_ids WHERE login IN (${marks})`).all(...logins) as { login: string; id: number }[]).map((r) => [r.login, r.id]));
  for (const a of authors) {
    const owner = bound.get(a.login);
    const other = a.id !== null && owner !== undefined && owner !== a.id;
    const s = other ? undefined : stats.get(a.login);
    const o = over.get(a.login) ?? null;
    out.set(tierKey(a), tierOf(s?.merged ?? 0, s?.closed ?? 0, other && o === "allow" ? null : o, rule));
  }
  return out;
}

// SQL expression for the tier, given columns merged, closed, override and
// bound parameters :min_merged, :min_rate.
export const TIER_SQL = `CASE
  WHEN override IN ('allow','deny') THEN override
  WHEN merged >= :min_merged AND merged + closed > 0 AND CAST(merged AS REAL) / (merged + closed) >= :min_rate THEN 'whitelisted'
  ELSE 'not' END`;

export function contributors(db: DatabaseSync, opts: { repo?: string; login?: string } = {}): Contributor[] {
  const rule = getRule(db);
  const where = [opts.repo ? "AND repo = :repo" : "", opts.login ? "AND author = :login" : ""].join(" ");
  const params: Record<string, string | number> = { min_merged: rule.minMerged, min_rate: rule.minRate };
  if (opts.repo) params.repo = opts.repo;
  if (opts.login) params.login = opts.login;
  // Stats always come from every repo; the repo filter only picks who is listed.
  const rows = db.prepare(`
    WITH s AS (${STATS_SQL} GROUP BY author),
    r AS (SELECT author, GROUP_CONCAT(DISTINCT repo) AS repos FROM items WHERE kind = 'pr' AND author IS NOT NULL ${where} GROUP BY author),
    j AS (
      SELECT r.author AS login, COALESCE(s.merged,0) AS merged, COALESCE(s.closed,0) AS closed, COALESCE(s.open,0) AS open,
             s.last_merge, r.repos, o.status AS override, o.note, o.by AS override_by, o.at AS override_at
      FROM r LEFT JOIN s ON s.login = r.author LEFT JOIN whitelist_overrides o ON o.login = r.author
      UNION ALL
      SELECT o.login, 0, 0, 0, NULL, '', o.status, o.note, o.by, o.at FROM whitelist_overrides o
      WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.kind = 'pr' AND i.author = o.login) ${opts.repo ? "AND 0" : ""} ${opts.login ? "AND o.login = :login" : ""}
    )
    SELECT j.*, ${TIER_SQL} AS tier FROM j`).all(params) as Omit<Contributor, "rate">[];
  return rows.map((r) => ({ ...r, rate: r.merged + r.closed > 0 ? r.merged / (r.merged + r.closed) : null }));
}

export function isWhitelisted(db: DatabaseSync, login: string): { ok: boolean; reason: string } {
  const rule = getRule(db);
  const o = db.prepare("SELECT status FROM whitelist_overrides WHERE login = ?").get(login) as { status: string } | undefined;
  if (o?.status === "allow") return { ok: true, reason: "override: allow" };
  if (o?.status === "deny") return { ok: false, reason: "override: deny" };
  const s = db.prepare(`${STATS_SQL} AND author = ?`).get(login) as { merged: number | null; closed: number | null };
  const merged = s.merged ?? 0;
  const closed = s.closed ?? 0;
  const rate = merged + closed > 0 ? merged / (merged + closed) : 0;
  const ok = tierOf(merged, closed, null, rule) === "whitelisted";
  const facts = `${merged} merged, merge rate ${Math.round(rate * 100)}%; rule: ≥ ${rule.minMerged} merged and ≥ ${Math.round(rule.minRate * 100)}%`;
  return { ok, reason: facts };
}

export function setOverride(db: DatabaseSync, login: string, status: "allow" | "deny" | null, note: string | null, by: string): void {
  if (!/^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(login)) throw new Error(`not a GitHub login: ${login}`);
  if (status === null) {
    db.prepare("DELETE FROM whitelist_overrides WHERE login = ?").run(login);
  } else {
    db.prepare("INSERT OR REPLACE INTO whitelist_overrides (login, status, note, by, at) VALUES (?, ?, ?, ?, ?)")
      .run(login, status, note || null, by, new Date().toISOString());
  }
  // The note is private: the audit row records only that one was given.
  audit(db, by, "override", login, { status: status ?? "clear", note: note ? true : undefined });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function list(args: string[]): void {
  const tier = flag(args, "--tier");
  const repo = flag(args, "--repo");
  const rows = contributors(connect(), { repo }).filter((c) => !tier || c.tier === tier)
    .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
  console.log(`${"login".padEnd(28)} ${"tier".padEnd(16)} ${"merged".padStart(6)} ${"closed".padStart(6)} ${"open".padStart(5)} ${"rate".padStart(5)}`);
  for (const c of rows) {
    console.log(`${c.login.padEnd(28)} ${TIER_LABEL[c.tier].padEnd(16)} ${String(c.merged).padStart(6)} ${String(c.closed).padStart(6)} ${String(c.open).padStart(5)} ${(c.rate === null ? "-" : `${Math.round(c.rate * 100)}%`).padStart(5)}`);
  }
}

function show(args: string[]): void {
  const login = args[0];
  if (!login) throw new Error("usage: whitelist show <login>");
  const db = connect();
  const c = contributors(db, { login })[0];
  const w = isWhitelisted(db, login);
  if (!c) {
    console.log(`${login}: no PRs in the mirror; ${w.ok ? "allowed" : "not allowed"} (${w.reason})`);
    return;
  }
  console.log(`${c.login}\n  tier: ${TIER_LABEL[c.tier]} (${w.reason})\n  merged ${c.merged}, closed unmerged ${c.closed}, open ${c.open}\n  last merge: ${c.last_merge ?? "-"}\n  repos: ${c.repos}`);
  if (c.override) console.log(`  override: ${c.override}${c.note ? ` — ${c.note}` : ""}`);
}

function override(status: "allow" | "deny" | null) {
  return (args: string[]): void => {
    const note = flag(args, "--note") ?? null;
    const login = args[0];
    if (!login) throw new Error(`usage: whitelist ${status ?? "clear"} <login>${status ? " [--note TEXT]" : ""}`);
    setOverride(connect(), login, status, note, "cli");
    console.log(`${login}: ${status ?? "override cleared"}`);
  };
}

function rule(args: string[]): void {
  const db = connect();
  const cur = getRule(db);
  const m = flag(args, "--min-merged");
  const r = flag(args, "--min-rate");
  if (m !== undefined || r !== undefined) {
    setRule(db, { minMerged: m === undefined ? cur.minMerged : Number(m), minRate: r === undefined ? cur.minRate : Number(r) }, "cli");
  }
  const now = getRule(db);
  console.log(`whitelisted: at least ${now.minMerged} merged PRs and a merge rate of at least ${now.minRate}`);
}

const SUB: Record<string, (args: string[]) => void> = {
  list, show, allow: override("allow"), deny: override("deny"), clear: override(null), rule,
};

export const commands = {
  whitelist: {
    summary: "contributor whitelist: list [--tier T] [--repo R] | show LOGIN | allow|deny LOGIN [--note T] | clear LOGIN | rule [--min-merged N] [--min-rate R]",
    run(args: string[]): void {
      const [sub, ...rest] = args;
      const fn = sub ? SUB[sub] : undefined;
      if (!fn) {
        console.log(`usage: autocraft whitelist ${Object.keys(SUB).join("|")} ...`);
        process.exit(sub ? 1 : 0);
      }
      fn(rest);
    },
  },
};
