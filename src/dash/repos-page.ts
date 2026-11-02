// Repos page (admins): choose which org repos are tracked. Reads use `main.`
// names because the dashboard connection shows tracked repos only.
import type { DatabaseSync } from "node:sqlite";
import { listAll, RepoError, trackRepo, untrackRepo } from "../repos.ts";
import { ago, csrfField, esc, num, page } from "./pages/layout.ts";
import type { Req, Res, Route } from "./types.ts";

function reposPage(db: DatabaseSync, req: Req): Res {
  const rows = listAll(db);
  const tracked = rows.filter((r) => r.tracked).length;
  const body = rows.map((r) => `<tr><td>${esc(r.name)}${r.tracked ? "" : ` <span class=muted>(untracked)</span>`}</td>
<td class=n>${r.open_prs === null ? "–" : num(r.open_prs)}</td><td class=n>${r.open_issues === null ? "–" : num(r.open_issues)}</td>
<td class=n>${num(r.rows)}</td><td>${r.synced_at ? `${esc(ago(r.synced_at))} ago` : "–"}</td>
<td><form method=post action="/repos/${r.tracked ? "untrack" : "track"}">${csrfField(req)}<input type=hidden name=name value="${esc(r.name)}">
<button type=submit>${r.tracked ? "Untrack" : "Track"}</button></form></td></tr>`).join("");
  return page(req, "Repos", `<h1>Repos</h1>
<p class=summary>Switching a repo on takes effect at the next sync. ${tracked} of ${rows.length} repos are tracked; rows of untracked repos stay in the mirror but are hidden.</p>
<div class=scroll><table><thead><tr><th>Repo</th><th class=n>Open PRs</th><th class=n>Open issues</th><th class=n>Rows in mirror</th><th>Last synced</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`);
}

const change = (f: (db: DatabaseSync, by: string, name: string) => unknown) => (db: DatabaseSync, req: Req): Res => {
  try {
    f(db, req.user.login, (req.form.get("name") ?? "").trim());
  } catch (e) {
    if (!(e instanceof RepoError)) throw e;
    return { status: 400, html: page(req, "Not changed", `<h1>Not changed</h1><p>${esc(e.message)}</p><p><a href="/repos">Back to Repos</a></p>`).html };
  }
  return { redirect: "/repos" };
};

export const reposRoutes: Route[] = [
  { method: "GET", pattern: "/repos", admin: true, handler: reposPage },
  { method: "POST", pattern: "/repos/track", admin: true, handler: change(trackRepo) },
  { method: "POST", pattern: "/repos/untrack", admin: true, handler: change(untrackRepo) },
];
