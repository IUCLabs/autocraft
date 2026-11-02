// Contributors: merge history, the whitelist tier, owner overrides and the rule.
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res } from "../types.ts";
import { contributors, getRule, setOverride, setRule, TIER_LABEL, type Contributor, type Tier } from "../../whitelist.ts";
import { badRequest, chips, selectFilter, csrfField, day, esc, exporting, forbidden, num, page, pageNo, pager, PAGE_SIZE, pct, sortHeader } from "./layout.ts";

const SORTS: Record<string, (a: Contributor, b: Contributor) => number> = {
  login: (a, b) => a.login.localeCompare(b.login),
  tier: (a, b) => a.tier.localeCompare(b.tier),
  merged: (a, b) => b.merged - a.merged,
  closed: (a, b) => b.closed - a.closed,
  open: (a, b) => b.open - a.open,
  rate: (a, b) => (b.rate ?? -1) - (a.rate ?? -1),
  last: (a, b) => (b.last_merge ?? "").localeCompare(a.last_merge ?? ""),
  repos: (a, b) => b.repos.split(",").length - a.repos.split(",").length,
};

const isOperator = (req: Req): boolean => req.user.role === "operator" && !exporting(req);

function ruleBlock(db: DatabaseSync, req: Req): string {
  const r = getRule(db);
  const text = `Whitelisted: at least ${r.minMerged} merged PRs and a merge rate of at least ${Math.round(r.minRate * 100)}%. An override always wins.`;
  if (!isOperator(req)) return `<p class=summary>${esc(text)}</p>`;
  return `<p class=summary>${esc(text)}</p><form method=post action="/contributors/rule" class=row>${csrfField(req)}
    <label>Min merged <input type=number name=min_merged min=0 step=1 value="${r.minMerged}" required></label>
    <label>Min merge rate (%) <input type=number name=min_rate min=0 max=100 step=1 value="${Math.round(r.minRate * 100)}" required></label>
    <button type=submit>Save rule</button></form>`;
}

function overrideForm(req: Req, c: Contributor): string {
  const btn = (v: string, l: string) => `<button type=submit name=status value="${v}">${l}</button>`;
  return `<form method=post action="/contributors/override" class=row>${csrfField(req)}<input type=hidden name=login value="${esc(c.login)}"><input type=hidden name=back value="${esc(req.path + (req.query.toString() ? `?${req.query}` : ""))}">` +
    `<input type=text name=note maxlength=300 placeholder="Note (private)" aria-label="Note for ${esc(c.login)}" value="${esc(c.note ?? "")}">` +
    (c.override !== "allow" ? btn("allow", "Allow") : "") + (c.override !== "deny" ? btn("deny", "Deny") : "") + (c.override ? btn("clear", "Clear") : "") + `</form>`;
}

export function contributorsPage(db: DatabaseSync, req: Req): Res {
  const repo = req.query.get("repo") || undefined;
  const tier = req.query.get("tier") as Tier | null;
  const login = req.query.get("login") || undefined;
  let rows = contributors(db, { repo, login });
  const counts = new Map<string, number>();
  for (const c of rows) counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);
  if (tier && tier in TIER_LABEL) rows = rows.filter((c) => c.tier === tier);
  const sort = SORTS[req.query.get("sort") ?? ""] ?? SORTS.merged;
  rows.sort((a, b) => sort(a, b) || a.login.localeCompare(b.login));
  const total = rows.length;
  const shown = rows.slice((pageNo(req) - 1) * PAGE_SIZE, pageNo(req) * PAGE_SIZE);
  const admin = isOperator(req);
  const summary = `${num([...counts.values()].reduce((s, n) => s + n, 0))} contributors: ${(Object.keys(TIER_LABEL) as Tier[]).map((t) => `${num(counts.get(t) ?? 0)} ${TIER_LABEL[t]}`).join(", ")}.`;
  const repos = (db.prepare("SELECT name FROM repos ORDER BY name").all() as { name: string }[]).map((r) => ({ value: r.name, label: r.name }));
  const table = `<div class=scroll><table><thead><tr>${sortHeader(req, "login", "Login", false)}${sortHeader(req, "tier", "Tier", false)}${sortHeader(req, "merged", "Merged")}${sortHeader(req, "closed", "Closed unmerged")}${sortHeader(req, "open", "Open")}${sortHeader(req, "rate", "Merge rate")}${sortHeader(req, "last", "Last merge")}${sortHeader(req, "repos", "Repos", false)}</tr></thead><tbody>` +
    shown.map((c) => `<tr><td><a href="https://github.com/${encodeURIComponent(c.login)}">${esc(c.login)}</a></td><td>${esc(TIER_LABEL[c.tier])}${admin && c.note ? `<div class="small muted">${esc(c.note)}</div>` : ""}${admin ? overrideForm(req, c) : ""}</td>` +
      `<td class=n>${num(c.merged)}</td><td class=n>${num(c.closed)}</td><td class=n>${num(c.open)}</td><td class=n>${pct(c.rate)}</td><td class=n>${esc(day(c.last_merge))}</td><td class=small>${esc(c.repos.split(",").filter(Boolean).join(", "))}</td></tr>`).join("") +
    `</tbody></table></div>`;
  const body = `<h1>Contributors</h1>${ruleBlock(db, req)}<p class=summary>${esc(summary)}</p>` +
    chips(req, "tier", "Tier", (Object.keys(TIER_LABEL) as Tier[]).map((t) => ({ value: t, label: TIER_LABEL[t] }))) +
    selectFilter(req, "repo", "Repo", repos) + table + pager(req, total);
  return page(req, "Contributors", body);
}

function back(req: Req): string {
  const b = req.form.get("back") ?? "/contributors";
  return b.startsWith("/contributors") ? b : "/contributors";
}

export function override(db: DatabaseSync, req: Req): Res {
  if (req.user.role !== "operator") return forbidden(req, "Only operators can change the whitelist.");
  const login = req.form.get("login") ?? "";
  const status = req.form.get("status");
  if (status !== "allow" && status !== "deny" && status !== "clear") return badRequest(req, "Choose allow, deny or clear.");
  try {
    setOverride(db, login, status === "clear" ? null : status, (req.form.get("note") ?? "").trim().slice(0, 300) || null, req.user.login);
  } catch (e) {
    return badRequest(req, (e as Error).message);
  }
  return { redirect: back(req) };
}

export function rule(db: DatabaseSync, req: Req): Res {
  if (req.user.role !== "operator") return forbidden(req, "Only operators can change the whitelist rule.");
  const minMerged = Number(req.form.get("min_merged"));
  const minRate = Number(req.form.get("min_rate")) / 100;
  try {
    setRule(db, { minMerged, minRate }, req.user.login);
  } catch (e) {
    return badRequest(req, (e as Error).message);
  }
  return { redirect: "/contributors" };
}
