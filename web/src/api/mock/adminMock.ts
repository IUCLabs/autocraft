// Mock Contributors, Repos and Access: deterministic fixtures and the same
// rules the server applies (operator-only writes, private override notes, the
// last operator stays).
import type { Api } from "../client";
import type {
  AccessEntry,
  AccessOverview,
  AuditEntry,
  Contributor,
  ContributorSort,
  OverrideStatus,
  Role,
  SessionInfo,
  Tier,
  TrackedRepo,
  User,
  WhitelistRule,
} from "../types";
import { AUTHORS, NOW, REPO_OPEN, REPOS, rng } from "./fixtures";

const H = 3600_000;
const D = 24 * H;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const wait = <T>(v: T, ms = 50) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

interface Author {
  login: string;
  merged: number;
  closed: number;
  open: number;
  lastMerge: string | null;
  repos: string[];
  override: OverrideStatus | null;
  note: string | null;
  by: string | null;
  at: string | null;
}

const SYL = ["ar", "bel", "cor", "dun", "eli", "fen", "gor", "hal", "ira", "jun", "kel", "lum", "mor", "nix", "oro", "pel", "qui", "ras", "sol", "tam", "ulf", "vey", "wen", "yar", "zed"];
const SUFFIX = ["", "-dev", "42", "-k", "_", "-ui", "codes", "-m", "7", "-art"];

function buildAuthors(): Author[] {
  const r = rng(424242);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const repos = (k: number) => [...new Set(Array.from({ length: k }, () => pick(REPOS.slice(0, 16))))].sort();
  const out: Author[] = AUTHORS.map(([login, tier, merged, closed]) => ({
    login, merged, closed, open: Math.floor(r() * 4), lastMerge: merged ? iso(r() * 40 * D) : null, repos: repos(1 + Math.floor(r() * 3)),
    override: tier === "override-allow" ? "allow" : tier === "override-deny" ? "deny" : null,
    note: tier === "override-allow" ? "Core maintainer of the plugin SDK; reviewed in person." : tier === "override-deny" ? "Mass-generated PRs without testing; see the September thread." : null,
    by: tier.startsWith("override") ? "ochre-fox" : null, at: tier.startsWith("override") ? iso(9 * D) : null,
  }));
  const seen = new Set(out.map((a) => a.login));
  while (out.length < 160) {
    const login = `${pick(SYL)}${pick(SYL)}${pick(SUFFIX)}`;
    if (seen.has(login)) continue;
    seen.add(login);
    const heavy = r() < 0.2;
    const merged = Math.floor(r() ** 2 * (heavy ? 60 : 8));
    const closed = Math.floor(r() ** 1.5 * (heavy ? 12 : 6));
    out.push({
      login, merged, closed, open: Math.floor(r() ** 3 * 9), lastMerge: merged ? iso(r() * 60 * D) : null, repos: repos(1 + Math.floor(r() * (heavy ? 5 : 2))),
      override: null, note: null, by: null, at: null,
    });
  }
  const allow = ["hal-orodev", "sunlit-q"];
  for (const login of allow) {
    out.push({ login, merged: 0, closed: 0, open: 1, lastMerge: null, repos: ["craft-libs"], override: "allow", note: "Invited contributor for the font pipeline.", by: "ochre-fox", at: iso(3 * D) });
  }
  return out;
}

const autoTier = (a: Author, rule: WhitelistRule): "whitelisted" | "not" => {
  const done = a.merged + a.closed;
  return a.merged >= rule.minMerged && done > 0 && a.merged / done >= rule.minRate ? "whitelisted" : "not";
};
const tierOf = (a: Author, rule: WhitelistRule): Tier => (a.override === "allow" ? "override-allow" : a.override === "deny" ? "override-deny" : autoTier(a, rule));
const allowed = (a: Author, rule: WhitelistRule) => {
  const t = tierOf(a, rule);
  return t === "whitelisted" || t === "override-allow";
};
const rate = (a: Author) => (a.merged + a.closed ? a.merged / (a.merged + a.closed) : null);

const SORTS: Record<ContributorSort, (a: Author, b: Author, rule: WhitelistRule) => number> = {
  login: (a, b) => a.login.localeCompare(b.login),
  tier: (a, b, r) => tierOf(a, r).localeCompare(tierOf(b, r)),
  merged: (a, b) => a.merged - b.merged,
  closed: (a, b) => a.closed - b.closed,
  open: (a, b) => a.open - b.open,
  rate: (a, b) => (rate(a) ?? -1) - (rate(b) ?? -1),
  last: (a, b) => (a.lastMerge ?? "").localeCompare(b.lastMerge ?? ""),
  repos: (a, b) => a.repos.length - b.repos.length,
};

const UNTRACKED = ["craft-website", "craft-ci-images", "craft-docs-archive", "artcraft-old-installer", "craft-design-tokens"];

function buildRepos(): TrackedRepo[] {
  const r = rng(77);
  const tracked = REPO_OPEN.map(([name, open]) => {
    const prs = Math.round(open * (0.3 + r() * 0.2));
    const toAdd = Math.round(prs * (0.4 + r() * 0.3));
    const labels = { approved: false, approvedBy: null, approvedAt: null, toAdd, skipped: Math.round(prs * 0.2), conflicts: r() < 0.3 ? Math.floor(r() * 4) : 0 };
    return { name, tracked: true, openPrs: prs, openIssues: open - prs, mirrored: Math.round(open * (3.5 + r())), syncedAt: iso((2 + r() * 40) * 60_000), labels, merging: { approved: false, approvedBy: null, approvedAt: null } };
  });
  const rest = UNTRACKED.map((name) => ({ name, tracked: false, openPrs: Math.floor(r() * 30), openIssues: Math.floor(r() * 80), mirrored: name === "craft-docs-archive" ? 412 : 0, syncedAt: name === "craft-docs-archive" ? iso(12 * D) : null, labels: null, merging: null }));
  return [...tracked, ...rest];
}

const ACCESS: Omit<AccessEntry, "sessions">[] = [
  { login: "ochre-fox", role: "operator", addedBy: "cli", addedAt: iso(30 * D), note: null },
  { login: "kiri-n", role: "maintainer", addedBy: "ochre-fox", addedAt: iso(21 * D), note: "Maintainer for the photo and vector apps." },
  { login: "mosswood", role: "maintainer", addedBy: "ochre-fox", addedAt: iso(21 * D), note: null },
  { login: "glasswing", role: "viewer", addedBy: "ochre-fox", addedAt: iso(12 * D), note: "Reads progress for the monthly report." },
  { login: "tidewater", role: "viewer", addedBy: "ochre-fox", addedAt: iso(5 * D), note: null },
  { login: "pixel-wrangler", role: "viewer", addedBy: "kiri-n", addedAt: iso(2 * D), note: "Frequent contributor; asked to follow the queue." },
];

const UA = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
];

function buildSessions(): Omit<SessionInfo, "current">[] {
  const rows: [string, number, number, number][] = [
    ["ochre-fox", 2 * D, 2 * 60_000, 0],
    ["ochre-fox", 6 * D, 9 * H, 1],
    ["kiri-n", 1 * D, 25 * 60_000, 1],
    ["mosswood", 3 * D, 5 * H, 2],
    ["glasswing", 8 * D, 2 * D, 0],
    ["tidewater", 4 * H, 3 * H, 1],
  ];
  return rows.map(([login, created, seen, ua], i) => ({ id: 101 + i, login, createdAt: iso(created), lastSeen: iso(seen), expiresAt: new Date(NOW - seen + 14 * D).toISOString(), userAgent: UA[ua]! }));
}

export const AUDIT_ACTIONS = [
  "answer", "undo", "adopt", "opinion", "opinion-retract", "comment", "override", "rule", "access-add", "access-remove", "access-role",
  "session-revoke", "sign-in", "sign-in-refused", "repo-track", "repo-untrack",
];

function buildAudit(): AuditEntry[] {
  const r = rng(9001);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: AuditEntry[] = [];
  let t = 20 * 60_000;
  for (let i = 0; i < 140; i++) {
    t += r() * 3 * H;
    const k = r();
    const repo = pick(REPOS.slice(0, 10));
    const ref = `${repo}#${1000 + Math.floor(r() * 4000)}`;
    if (k < 0.3) out.push({ at: iso(t), login: "ochre-fox", action: "answer", target: `${ref}:scope`, details: { answer: pick(["take", "small-extra", "plugin", "close"]) } });
    else if (k < 0.55) out.push({ at: iso(t), login: pick(["kiri-n", "mosswood", "glasswing"]), action: "opinion", target: `${ref}:scope`, details: { option: pick(["take", "plugin", null]) } });
    else if (k < 0.7) out.push({ at: iso(t), login: pick(["kiri-n", "mosswood"]), action: "comment", target: `${ref}:scope`, details: null });
    else if (k < 0.9) out.push({ at: iso(t), login: pick(ACCESS).login, action: "sign-in", target: null, details: { ip: "100.64.0.12" } });
    else if (k < 0.95) out.push({ at: iso(t), login: "ochre-fox", action: "override", target: pick(AUTHORS)[0], details: { status: pick(["allow", "deny", "clear"]) } });
    else out.push({ at: iso(t), login: "octo-stranger", action: "sign-in-refused", target: "octo-stranger", details: { ip: "100.64.0.40" } });
  }
  out.push({ at: iso(11 * D), login: "ochre-fox", action: "rule", target: "whitelist", details: { minMerged: 5, minRate: 0.6 } });
  out.push({ at: iso(12 * D), login: "ochre-fox", action: "access-add", target: "glasswing", details: { role: "viewer" } });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

type AdminApi = Pick<Api, "contributors" | "repoAdmin" | "access">;

export function createAdminMock(me: User, changed: () => void): AdminApi {
  const authors = buildAuthors();
  const repos = buildRepos();
  const access = structuredClone(ACCESS);
  let sessions = buildSessions();
  const auditLog = buildAudit();
  let rule: WhitelistRule = { minMerged: 5, minRate: 0.6 };
  const operator = me.role === "operator";
  const nowIso = () => new Date(NOW).toISOString();

  const requireOperator = (what: string) => {
    if (!operator) throw new Error(`only operators ${what}`);
  };
  const log = (action: string, target: string | null, details: Record<string, unknown> | null = null) => {
    auditLog.unshift({ at: nowIso(), login: me.login, action, target, details });
  };
  const write = <T>(v: T) => {
    changed();
    return wait(v, 40);
  };

  const view = (a: Author): Contributor => {
    const c: Contributor = {
      login: a.login, tier: tierOf(a, rule), autoTier: autoTier(a, rule), override: a.override, overrideBy: a.by, overrideAt: a.at,
      merged: a.merged, closedUnmerged: a.closed, open: a.open, mergeRate: rate(a), lastMerge: a.lastMerge, repos: a.repos,
    };
    if (operator) c.overrideNote = a.note;
    return c;
  };

  const overview = (): AccessOverview => ({
    entries: access.map((e) => ({ ...e, sessions: sessions.filter((s) => s.login === e.login).length })).sort((a, b) => a.role.localeCompare(b.role) || a.login.localeCompare(b.login)),
    sessions: sessions.map((s, i) => ({ ...s, current: s.login === me.login && i === sessions.findIndex((x) => x.login === me.login) })),
  });
  const entry = (login: string) => {
    const e = access.find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!e) throw new Error(`${login} is not on the access list`);
    return e;
  };
  const keepOperator = (e: { role: Role }) => {
    if (e.role === "operator" && access.filter((x) => x.role === "operator").length <= 1) throw new Error("That would leave no operator. Add another operator first.");
  };

  return {
    contributors: {
      list(f) {
        let rows = authors.filter((a) => (!f.repo || a.repos.includes(f.repo)) && (!f.q || a.login.toLowerCase().includes(f.q.trim().toLowerCase())));
        const byTier: Record<Tier, number> = { whitelisted: 0, not: 0, "override-allow": 0, "override-deny": 0 };
        for (const a of rows) byTier[tierOf(a, rule)]++;
        if (f.tier) rows = rows.filter((a) => tierOf(a, rule) === f.tier);
        const key = f.sort ?? "merged";
        const desc = f.desc ?? key !== "login";
        rows.sort((a, b) => (desc ? -1 : 1) * SORTS[key](a, b, rule) || a.login.localeCompare(b.login));
        const from = f.offset ?? 0;
        return wait({ rule, total: rows.length, byTier, contributors: rows.slice(from, from + (f.limit ?? 50)).map(view) });
      },
      previewRule(next) {
        requireOperator("change the whitelist rule");
        const sorted = [...authors].sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
        const gained = sorted.filter((a) => allowed(a, next) && !allowed(a, rule)).map((a) => a.login);
        const lost = sorted.filter((a) => !allowed(a, next) && allowed(a, rule)).map((a) => a.login);
        return wait({
          rule: next, authors: authors.length,
          allowedNow: authors.filter((a) => allowed(a, rule)).length, allowedAfter: authors.filter((a) => allowed(a, next)).length,
          gained: { count: gained.length, logins: gained.slice(0, 20) }, lost: { count: lost.length, logins: lost.slice(0, 20) },
        }, 120);
      },
      async setRule(next) {
        requireOperator("change the whitelist rule");
        if (!Number.isInteger(next.minMerged) || next.minMerged < 0) throw new Error("minMerged must be a whole number of at least 0");
        if (!(next.minRate >= 0 && next.minRate <= 1)) throw new Error("minRate must be between 0 and 1");
        rule = { ...next };
        log("rule", "whitelist", { ...next });
        return write(rule);
      },
      async override(login, input) {
        requireOperator("change the whitelist");
        let a = authors.find((x) => x.login === login);
        if (!a) {
          a = { login, merged: 0, closed: 0, open: 0, lastMerge: null, repos: [], override: null, note: null, by: null, at: null };
          authors.push(a);
        }
        if (input.status === null) Object.assign(a, { override: null, note: null, by: null, at: null });
        else Object.assign(a, { override: input.status, note: input.note === undefined ? a.note : input.note.trim() || null, by: me.login, at: nowIso() });
        log("override", login, { status: input.status ?? "clear", ...(a.note ? { note: true } : {}) });
        return write(view(a));
      },
    },
    repoAdmin: {
      list() {
        requireOperator("manage tracked repos");
        return wait([...repos].sort((a, b) => Number(b.tracked) - Number(a.tracked) || a.name.localeCompare(b.name)));
      },
      async track(name) {
        requireOperator("manage tracked repos");
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("Not a repo name.");
        let r = repos.find((x) => x.name === name);
        if (r?.tracked) throw new Error(`${name} is already tracked`);
        if (!r) repos.push((r = { name, tracked: true, openPrs: null, openIssues: null, mirrored: 0, syncedAt: null, labels: null, merging: null }));
        r.tracked = true;
        r.labels ??= { approved: false, approvedBy: null, approvedAt: null, toAdd: 0, skipped: 0, conflicts: 0 };
        r.merging ??= { approved: false, approvedBy: null, approvedAt: null };
        log("repo-track", name);
        changed();
        return this.list();
      },
      async untrack(name) {
        requireOperator("manage tracked repos");
        const r = repos.find((x) => x.name === name);
        if (!r?.tracked) throw new Error(`${name} is not tracked`);
        r.tracked = false;
        r.labels = null;
        r.merging = null;
        log("repo-untrack", name);
        changed();
        return this.list();
      },
      async approveMerging(name, approved) {
        requireOperator("approve merging");
        const r = repos.find((x) => x.name === name);
        if (!r?.merging) throw new Error(`${name} is not tracked`);
        if (r.merging.approved === approved) throw new Error(`${name} is ${approved ? "already" : "not"} approved for merging`);
        Object.assign(r.merging, approved ? { approved, approvedBy: me.login, approvedAt: nowIso() } : { approved, approvedBy: null, approvedAt: null });
        log(approved ? "merge-approve" : "merge-revoke", name);
        changed();
        return this.list();
      },
      async approveLabels(name, approved) {
        requireOperator("approve labelling");
        const r = repos.find((x) => x.name === name);
        if (!r?.labels) throw new Error(`${name} is not tracked`);
        if (r.labels.approved === approved) throw new Error(`${name} is ${approved ? "already" : "not"} approved for labelling`);
        Object.assign(r.labels, approved ? { approved, approvedBy: me.login, approvedAt: nowIso() } : { approved, approvedBy: null, approvedAt: null });
        log(approved ? "labels-approve" : "labels-revoke", name);
        changed();
        return this.list();
      },
    },
    access: {
      overview() {
        requireOperator("manage access");
        return wait(overview());
      },
      async add({ login, role, note }) {
        requireOperator("manage access");
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) throw new Error(`not a GitHub login: "${login}"`);
        if (access.some((x) => x.login.toLowerCase() === login.toLowerCase())) throw new Error(`${login} is already on the access list`);
        access.push({ login, role, addedBy: me.login, addedAt: nowIso(), note: note?.trim() || null });
        log("access-add", login, { role });
        return write(overview());
      },
      async remove(login) {
        requireOperator("manage access");
        const e = entry(login);
        keepOperator(e);
        access.splice(access.indexOf(e), 1);
        const n = sessions.filter((s) => s.login === e.login).length;
        sessions = sessions.filter((s) => s.login !== e.login);
        log("access-remove", e.login, { role: e.role, sessions: n });
        return write(overview());
      },
      async setRole(login, role) {
        requireOperator("manage access");
        const e = entry(login);
        if (e.role === role) throw new Error(`${login} already has that role`);
        keepOperator(e);
        const n = sessions.filter((s) => s.login === e.login).length;
        log("access-role", e.login, { from: e.role, to: role, sessions: n });
        e.role = role;
        sessions = sessions.filter((s) => s.login !== e.login);
        return write(overview());
      },
      async revokeSession(id) {
        requireOperator("manage access");
        const s = sessions.find((x) => x.id === id);
        if (!s) throw new Error("that session has already ended");
        sessions = sessions.filter((x) => x !== s);
        log("session-revoke", s.login, { created_at: s.createdAt });
        return write(overview());
      },
      audit(f) {
        requireOperator("read the audit log");
        const l = f.login?.trim().toLowerCase();
        const rows = auditLog.filter((e) => (!l || e.login.toLowerCase() === l || e.target?.toLowerCase() === l) && (!f.action || e.action === f.action));
        const from = f.offset ?? 0;
        return wait({ entries: rows.slice(from, from + (f.limit ?? 50)), total: rows.length, actions: AUDIT_ACTIONS });
      },
    },
  };
}
