// Contributors (the whitelist), tracked repos and the access list over JSON.
// Reads of contributors are open to anyone signed in, without override notes;
// every other read and every write here is for operators. The server has
// already checked the Origin, the CSRF header and the body size on POSTs.
import type { DatabaseSync } from "node:sqlite";
import type {
  AccessOverview, AuditEntry, AuditPage, Contributor, ContributorList, ContributorSort, RulePreview, RepoApproval, RepoLabels, Tier, TrackedRepo, WhitelistRule,
} from "../../../web/src/api/types.ts";
import { AccessError, addLogin, isRole, listAccess, removeLogin, ROLES, setRole } from "../../access.ts";
import { approvalOf, setApproval } from "../../labels/approval.ts";
import { mergeApprovalOf, setMergeApproval } from "../../merge/approval.ts";
import { countPlan, planLabels } from "../../labels/plan.ts";
import { listAll, RepoError, trackRepo, untrackRepo } from "../../repos.ts";
import { contributors, getRule, setOverride, setRule, tierOf, type Contributor as Row, type Rule } from "../../whitelist.ts";
import { audit } from "../audit.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

const NOTE_MAX = 300;
const ACCESS_NOTE_MAX = 500;
const AUDIT_PAGE = 50;
export const AUDIT_ACTIONS = [
  "answer", "undo", "adopt", "opinion", "opinion-retract", "comment", "override", "rule", "access-add", "access-remove", "access-role",
  "session-revoke", "sign-in", "sign-in-refused", "repo-track", "repo-untrack", "labels-approve", "labels-revoke", "labels-apply", "merge-approve", "merge-revoke",
  "job-request", "job-cancel", "pipeline-switch", "stage-limit",
];

const isOperator = (req: Req): boolean => req.user.role === "operator";

function requireOperator(req: Req, what: string): void {
  if (!isOperator(req)) throw new HttpError(403, `only operators ${what}`);
}

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

function text(v: unknown, max: number, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t || null;
}

const required = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${what} is required`);
  return v.trim();
};

// Library errors (AccessError, RepoError, setRule's range checks) are messages
// for the operator.
function refused<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof AccessError || e instanceof RepoError) throw new HttpError(400, e.message);
    throw e;
  }
}

// ---- contributors ----------------------------------------------------------

const TIER: Record<Row["tier"], Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };
const TIERS = Object.values(TIER);

function toContributor(c: Row, rule: Rule, operator: boolean): Contributor {
  const out: Contributor = {
    login: c.login, tier: TIER[c.tier], autoTier: tierOf(c.merged, c.closed, null, rule) === "whitelisted" ? "whitelisted" : "not",
    override: c.override, overrideBy: c.override_by, overrideAt: c.override_at,
    merged: c.merged, closedUnmerged: c.closed, open: c.open, mergeRate: c.rate, lastMerge: c.last_merge,
    repos: c.repos.split(",").filter(Boolean),
  };
  if (operator) out.overrideNote = c.note;
  return out;
}

const SORTS: Record<ContributorSort, (a: Row, b: Row) => number> = {
  login: (a, b) => a.login.localeCompare(b.login),
  tier: (a, b) => a.tier.localeCompare(b.tier),
  merged: (a, b) => a.merged - b.merged,
  closed: (a, b) => a.closed - b.closed,
  open: (a, b) => a.open - b.open,
  rate: (a, b) => (a.rate ?? -1) - (b.rate ?? -1),
  last: (a, b) => (a.last_merge ?? "").localeCompare(b.last_merge ?? ""),
  repos: (a, b) => a.repos.split(",").length - b.repos.split(",").length,
};

function int(v: string | null, def: number, min: number, max: number, what: string): number {
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}`);
  return n;
}

export function listContributors(db: DatabaseSync, req: Req): ContributorList {
  const q = req.query;
  const repo = q.get("repo") || undefined;
  const tier = q.get("tier") || undefined;
  if (tier !== undefined && !TIERS.includes(tier as Tier)) throw new HttpError(400, `tier must be one of ${TIERS.join(", ")}`);
  const sortKey = (q.get("sort") || "merged") as ContributorSort;
  const sort = SORTS[sortKey];
  if (!sort) throw new HttpError(400, `sort must be one of ${Object.keys(SORTS).join(", ")}`);
  const desc = q.get("desc") === null ? sortKey !== "login" : q.get("desc") === "1";
  const limit = int(q.get("limit"), 50, 1, 500, "limit");
  const offset = int(q.get("offset"), 0, 0, 1e9, "offset");
  const needle = (q.get("q") ?? "").trim().toLowerCase().slice(0, 100);

  const rule = getRule(db);
  let rows = contributors(db, { repo });
  if (needle) rows = rows.filter((c) => c.login.toLowerCase().includes(needle));
  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const c of rows) byTier[TIER[c.tier]]++;
  if (tier) rows = rows.filter((c) => TIER[c.tier] === tier);
  rows.sort((a, b) => (desc ? -sort(a, b) : sort(a, b)) || a.login.localeCompare(b.login));
  const operator = isOperator(req);
  return { rule, total: rows.length, byTier, contributors: rows.slice(offset, offset + limit).map((c) => toContributor(c, rule, operator)) };
}

function ruleOf(v: Record<string, unknown>): WhitelistRule {
  const minMerged = Number(v.minMerged);
  const minRate = Number(v.minRate);
  if (!Number.isInteger(minMerged) || minMerged < 0 || minMerged > 100_000) throw new HttpError(400, "minMerged must be a whole number of at least 0");
  if (!(minRate >= 0 && minRate <= 1)) throw new HttpError(400, "minRate must be between 0 and 1");
  return { minMerged, minRate };
}

export function previewRule(db: DatabaseSync, req: Req): RulePreview {
  requireOperator(req, "change the whitelist rule");
  const next = ruleOf({ minMerged: req.query.get("minMerged"), minRate: req.query.get("minRate") });
  const now = getRule(db);
  const rows = contributors(db).sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
  const allowed = (c: Row, r: Rule) => {
    const t = tierOf(c.merged, c.closed, c.override, r);
    return t === "whitelisted" || t === "allow";
  };
  const gained: string[] = [], lost: string[] = [];
  let allowedNow = 0, allowedAfter = 0;
  for (const c of rows) {
    const a = allowed(c, now), b = allowed(c, next);
    if (a) allowedNow++;
    if (b) allowedAfter++;
    if (b && !a) gained.push(c.login);
    if (a && !b) lost.push(c.login);
  }
  return {
    rule: next, authors: rows.length, allowedNow, allowedAfter,
    gained: { count: gained.length, logins: gained.slice(0, 20) }, lost: { count: lost.length, logins: lost.slice(0, 20) },
  };
}

export function saveRule(db: DatabaseSync, req: Req): WhitelistRule {
  requireOperator(req, "change the whitelist rule");
  const r = ruleOf(body(req));
  setRule(db, r, req.user.login);
  return getRule(db);
}

export function override(db: DatabaseSync, req: Req): Contributor {
  requireOperator(req, "change the whitelist");
  const login = req.params.login!;
  const b = body(req);
  const status = b.status;
  if (status !== "allow" && status !== "deny" && status !== null) throw new HttpError(400, "status must be allow, deny or null");
  // Without a note field the override keeps the note it has.
  const kept = () => (db.prepare("SELECT note FROM whitelist_overrides WHERE login = ?").get(login) as { note: string | null } | undefined)?.note ?? null;
  const note = status === null ? null : b.note === undefined ? kept() : text(b.note, NOTE_MAX, "note");
  try {
    setOverride(db, login, status, note, req.user.login);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const rule = getRule(db);
  const c = contributors(db, { login }).find((x) => x.login === login);
  return c ? toContributor(c, rule, true) : {
    login, tier: "not", autoTier: "not", override: null, overrideNote: null, overrideBy: null, overrideAt: null,
    merged: 0, closedUnmerged: 0, open: 0, mergeRate: null, lastMerge: null, repos: [],
  };
}

// ---- tracked repos ---------------------------------------------------------

export function allRepos(db: DatabaseSync, req: Req): TrackedRepo[] {
  requireOperator(req, "manage tracked repos");
  return listAll(db).map((r) => ({
    name: r.name, tracked: !!r.tracked, openPrs: r.open_prs, openIssues: r.open_issues, mirrored: r.rows, syncedAt: r.synced_at,
    labels: r.tracked ? labelsInfo(db, r.name) : null,
    merging: r.tracked ? mergeInfo(db, r.name) : null,
  }));
}

function mergeInfo(db: DatabaseSync, repo: string): RepoApproval {
  const a = mergeApprovalOf(db, repo);
  return { approved: !!a, approvedBy: a?.by ?? null, approvedAt: a?.at ?? null };
}

function labelsInfo(db: DatabaseSync, repo: string): RepoLabels {
  const a = approvalOf(db, repo);
  const c = countPlan(planLabels(db, repo));
  return { approved: !!a, approvedBy: a?.by ?? null, approvedAt: a?.at ?? null, toAdd: c.toAdd, skipped: c.already + c.unsettled, conflicts: c.conflicts };
}

// Only an operator lets the Label stage write to a repo on GitHub.
export function labelsApproval(db: DatabaseSync, req: Req, approved: boolean): TrackedRepo[] {
  requireOperator(req, "approve labelling");
  const name = required(body(req).name, "name");
  const changed = refused(() => {
    try {
      return setApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for labelling`);
  return allRepos(db, req);
}

// Only an operator lets the pipeline merge pull requests in a repo.
export function mergeApproval(db: DatabaseSync, req: Req, approved: boolean): TrackedRepo[] {
  requireOperator(req, "approve merging");
  const name = required(body(req).name, "name");
  const changed = refused(() => {
    try {
      return setMergeApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for merging`);
  return allRepos(db, req);
}

export function track(db: DatabaseSync, req: Req, on: boolean): TrackedRepo[] {
  requireOperator(req, "manage tracked repos");
  const name = required(body(req).name, "name");
  const changed = refused(() => (on ? trackRepo : untrackRepo)(db, req.user.login, name));
  if (!changed) throw new HttpError(409, `${name} is ${on ? "already" : "not"} tracked`);
  return allRepos(db, req);
}

// ---- access, sessions, audit -----------------------------------------------

export function accessOverview(db: DatabaseSync, req: Req): AccessOverview {
  requireOperator(req, "manage access");
  const sessions = db.prepare(`SELECT rowid AS id, login, csrf, created_at, last_seen, expires_at, user_agent FROM sessions
    WHERE expires_at > ? ORDER BY last_seen DESC`).all(new Date().toISOString()) as
    { id: number; login: string; csrf: string; created_at: string; last_seen: string; expires_at: string; user_agent: string | null }[];
  const perLogin = new Map<string, number>();
  for (const s of sessions) perLogin.set(s.login.toLowerCase(), (perLogin.get(s.login.toLowerCase()) ?? 0) + 1);
  return {
    entries: listAccess(db).map((r) => ({
      login: r.login, role: r.role, addedBy: r.added_by, addedAt: r.added_at, note: r.note, sessions: perLogin.get(r.login.toLowerCase()) ?? 0,
    })),
    sessions: sessions.map((s) => ({
      id: s.id, login: s.login, createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at,
      userAgent: s.user_agent ? s.user_agent.slice(0, 200) : null, current: s.csrf === req.csrf,
    })),
  };
}

const roleOf = (v: unknown) => {
  if (!isRole(v)) throw new HttpError(400, `role must be ${ROLES.join(", ")}`);
  return v;
};

export function accessAdd(db: DatabaseSync, req: Req): AccessOverview {
  requireOperator(req, "manage access");
  const b = body(req);
  refused(() => addLogin(db, req.user.login, required(b.login, "login"), roleOf(b.role), text(b.note, ACCESS_NOTE_MAX, "note")));
  return accessOverview(db, req);
}

export function accessRemove(db: DatabaseSync, req: Req): AccessOverview {
  requireOperator(req, "manage access");
  refused(() => removeLogin(db, req.user.login, required(body(req).login, "login"), { keepOperator: true }));
  return accessOverview(db, req);
}

export function accessRole(db: DatabaseSync, req: Req): AccessOverview {
  requireOperator(req, "manage access");
  const b = body(req);
  const login = required(b.login, "login");
  const changed = refused(() => setRole(db, req.user.login, login, roleOf(b.role), { keepOperator: true }));
  if (!changed) throw new HttpError(409, `${login} already has that role`);
  return accessOverview(db, req);
}

export function revokeSession(db: DatabaseSync, req: Req): AccessOverview {
  requireOperator(req, "manage access");
  const id = body(req).id;
  if (!Number.isInteger(id)) throw new HttpError(400, "id must be a session id");
  const s = db.prepare("DELETE FROM sessions WHERE rowid = ? RETURNING login, created_at").get(id as number) as
    { login: string; created_at: string } | undefined;
  if (!s) throw new HttpError(404, "that session has already ended");
  audit(db, req.user.login, "session-revoke", s.login, { created_at: s.created_at });
  return accessOverview(db, req);
}

export function auditLog(db: DatabaseSync, req: Req): AuditPage {
  requireOperator(req, "read the audit log");
  const q = req.query;
  const login = (q.get("login") ?? "").trim().slice(0, 100);
  const action = q.get("action") ?? "";
  if (action && !AUDIT_ACTIONS.includes(action)) throw new HttpError(400, "unknown action");
  const limit = int(q.get("limit"), AUDIT_PAGE, 1, 500, "limit");
  const offset = int(q.get("offset"), 0, 0, 1e9, "offset");
  const where: string[] = [];
  const args: string[] = [];
  if (login) {
    where.push("(login = ? COLLATE NOCASE OR target = ? COLLATE NOCASE)");
    args.push(login, login);
  }
  if (action) {
    where.push("action = ?");
    args.push(action);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM audit ${w}`).get(...args) as { n: number }).n);
  const rows = db.prepare(`SELECT at, login, action, target, details FROM audit ${w} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as { at: string; login: string; action: string; target: string | null; details: string | null }[];
  const entries: AuditEntry[] = rows.map((r) => {
    let details: Record<string, unknown> | null = null;
    try {
      const d = JSON.parse(r.details ?? "null") as unknown;
      if (d && typeof d === "object" && !Array.isArray(d)) details = d as Record<string, unknown>;
    } catch { /* not JSON: shown without details */ }
    return { at: r.at, login: r.login, action: r.action, target: r.target, details };
  });
  return { entries, total, actions: AUDIT_ACTIONS };
}
