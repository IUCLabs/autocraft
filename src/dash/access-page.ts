// Access page (admins): the access list, active sessions and the audit log.
import type { DatabaseSync } from "node:sqlite";
import { AccessError, addLogin, adminCount, getAccess, listAccess, removeLogin, setRole } from "../access.ts";
import { audit } from "./audit.ts";
import type { Req, Res, Role, Route } from "./types.ts";
import { esc } from "./server/util.ts";

const PAGE = 50;
const ACTIONS = ["answer", "undo", "override", "rule", "access-add", "access-remove", "access-role", "session-revoke", "sign-in", "sign-in-refused"];

function layout(req: Req, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style nonce="${req.nonce}">
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--link:#0b5cad;--warn:#a40000}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--muted:#aaa;--line:#333;--link:#7ab4f5;--warn:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:1rem 16px;max-width:64rem}
a{color:var(--link)}.muted{color:var(--muted)}.warn{color:var(--warn)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
form.inline{display:inline}input,select,button{font:inherit;min-height:44px;padding:0 10px;box-sizing:border-box}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
</style></head><body><p><a href="/">Dashboard</a></p><h1>${esc(title)}</h1>${body}</body></html>`;
}

const csrf = (req: Req) => `<input type="hidden" name="csrf" value="${esc(req.csrf)}">`;
const when = (iso: string | null) => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "-");

function accessPage(db: DatabaseSync, req: Req): Res {
  const rows = listAccess(db);
  const accessRows = rows.map((r) => `<tr><td>${esc(r.login)}</td><td>
<form class="inline row" method="post" action="/access/role">${csrf(req)}<input type="hidden" name="login" value="${esc(r.login)}">
<select name="role" aria-label="Role of ${esc(r.login)}">${(["viewer", "admin"] as Role[]).map((x) => `<option${x === r.role ? " selected" : ""}>${x}</option>`).join("")}</select>
<button>Change</button></form></td>
<td>${when(r.added_at)} by ${esc(r.added_by ?? "-")}</td><td>${esc(r.note ?? "")}</td>
<td><form class="inline" method="post" action="/access/remove">${csrf(req)}<input type="hidden" name="login" value="${esc(r.login)}"><button>Remove</button></form></td></tr>`).join("");

  const sessions = db.prepare(`SELECT rowid, login, created_at, last_seen, expires_at, user_agent FROM sessions
                               WHERE expires_at > ? ORDER BY last_seen DESC`).all(new Date().toISOString()) as
    { rowid: number; login: string; created_at: string; last_seen: string; expires_at: string; user_agent: string | null }[];
  const sessionRows = sessions.map((s) => `<tr><td>${esc(s.login)}</td><td>${when(s.created_at)}</td><td>${when(s.last_seen)}</td>
<td>${when(s.expires_at)}</td><td class="muted">${esc((s.user_agent ?? "").slice(0, 80))}</td>
<td><form class="inline" method="post" action="/access/revoke">${csrf(req)}<input type="hidden" name="id" value="${s.rowid}"><button>Revoke</button></form></td></tr>`).join("");

  const fLogin = (req.query.get("login") ?? "").trim();
  const fAction = req.query.get("action") ?? "";
  const page = Math.max(0, Math.floor(Number(req.query.get("page") ?? 0)) || 0);
  const where: string[] = [];
  const args: string[] = [];
  if (fLogin) {
    where.push("(login = ? COLLATE NOCASE OR target = ? COLLATE NOCASE)");
    args.push(fLogin, fLogin);
  }
  if (ACTIONS.includes(fAction)) {
    where.push("action = ?");
    args.push(fAction);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM audit ${sqlWhere}`).get(...args) as { n: number }).n);
  const entries = db.prepare(`SELECT at, login, action, target, details FROM audit ${sqlWhere} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...args, PAGE, page * PAGE) as { at: string; login: string; action: string; target: string | null; details: string | null }[];
  const auditRows = entries.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.login)}</td><td>${esc(e.action)}</td>
<td>${esc(e.target ?? "")}</td><td class="muted">${esc(e.details ?? "")}</td></tr>`).join("");
  const link = (p: number) => `/access?${new URLSearchParams({ ...(fLogin && { login: fLogin }), ...(fAction && { action: fAction }), page: String(p) })}#audit`;
  const pager = [page > 0 ? `<a href="${esc(link(page - 1))}">Newer</a>` : "", (page + 1) * PAGE < total ? `<a href="${esc(link(page + 1))}">Older</a>` : ""]
    .filter(Boolean).join(" · ");

  return {
    html: layout(req, "Access", `
<h2>Access list</h2>
<p>${rows.length} logins: ${rows.filter((r) => r.role === "admin").length} admins, ${rows.filter((r) => r.role === "viewer").length} viewers. Removing a login or changing its role ends its sessions.</p>
<form class="row" method="post" action="/access/add">${csrf(req)}
<input name="login" placeholder="GitHub login" required aria-label="GitHub login">
<select name="role" aria-label="Role"><option>viewer</option><option>admin</option></select>
<input name="note" placeholder="Note (private)" aria-label="Note">
<button>Add</button></form>
<div class="scroll"><table><thead><tr><th>Login</th><th>Role</th><th>Added</th><th>Note</th><th></th></tr></thead><tbody>${accessRows}</tbody></table></div>

<h2>Active sessions</h2>
<p>${sessions.length} active.</p>
<div class="scroll"><table><thead><tr><th>Login</th><th>Signed in</th><th>Last seen</th><th>Expires</th><th>Browser</th><th></th></tr></thead><tbody>${sessionRows}</tbody></table></div>

<h2 id="audit">Audit log</h2>
<form class="row" method="get" action="/access">
<input name="login" value="${esc(fLogin)}" placeholder="Login" aria-label="Filter by login">
<select name="action" aria-label="Filter by action"><option value="">All actions</option>${ACTIONS.map((a) => `<option${a === fAction ? " selected" : ""}>${a}</option>`).join("")}</select>
<button>Filter</button></form>
<p>${total} entries${total > PAGE ? `, showing ${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}` : ""}.</p>
<div class="scroll"><table><thead><tr><th>When (UTC)</th><th>By</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>${auditRows}</tbody></table></div>
<p>${pager}</p>`),
  };
}

function refuse(req: Req, message: string): Res {
  return { status: 400, html: layout(req, "Not changed", `<p class="warn">${esc(message)}</p><p><a href="/access">Back to Access</a></p>`) };
}

// Wraps a write: AccessError messages are for the admin; the page refuses any
// change that would leave the dashboard without an admin.
function write(f: (db: DatabaseSync, req: Req) => void) {
  return (db: DatabaseSync, req: Req): Res => {
    try {
      f(db, req);
      return { redirect: "/access" };
    } catch (e) {
      if (e instanceof AccessError) return refuse(req, e.message);
      throw e;
    }
  };
}

function guardLastAdmin(db: DatabaseSync, login: string): void {
  if (getAccess(db, login)?.role === "admin" && adminCount(db) <= 1) {
    throw new AccessError("That would leave no admin. Add another admin first.");
  }
}

const role = (v: string | null): Role => {
  if (v !== "admin" && v !== "viewer") throw new AccessError("Role must be admin or viewer.");
  return v;
};

export const accessRoutes: Route[] = [
  { method: "GET", pattern: "/access", admin: true, handler: accessPage },
  {
    method: "POST", pattern: "/access/add", admin: true,
    handler: write((db, req) => addLogin(db, req.user.login, (req.form.get("login") ?? "").trim(), role(req.form.get("role")),
      (req.form.get("note") ?? "").trim().slice(0, 500) || null)),
  },
  {
    method: "POST", pattern: "/access/remove", admin: true,
    handler: write((db, req) => {
      const login = req.form.get("login") ?? "";
      guardLastAdmin(db, login);
      removeLogin(db, req.user.login, login);
    }),
  },
  {
    method: "POST", pattern: "/access/role", admin: true,
    handler: write((db, req) => {
      const login = req.form.get("login") ?? "";
      const r = role(req.form.get("role"));
      if (r === "viewer") guardLastAdmin(db, login);
      setRole(db, req.user.login, login, r);
    }),
  },
  {
    method: "POST", pattern: "/access/revoke", admin: true,
    handler: write((db, req) => {
      const id = Number(req.form.get("id"));
      const s = Number.isInteger(id) ? db.prepare("DELETE FROM sessions WHERE rowid = ? RETURNING login, created_at").get(id) as
        { login: string; created_at: string } | undefined : undefined;
      if (!s) throw new AccessError("That session has already ended.");
      audit(db, req.user.login, "session-revoke", s.login, { created_at: s.created_at });
    }),
  },
];
