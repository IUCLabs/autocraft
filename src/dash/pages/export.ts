// Static, read-only copy of the dashboard for later public sharing. Pages
// render as a viewer with no write rights in export mode (no private fields),
// then every form and script is stripped.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res, User } from "../types.ts";
import { itemsOf, type DecisionRow } from "../../decisions.ts";
import { classifiers } from "./classifiers.ts";
import { contributorsPage } from "./contributors.ts";
import { cost } from "./cost.ts";
import { answeredTab, home } from "./decisions.ts";
import { item } from "./item.ts";
import type { PageReq } from "./layout.ts";
import { progress, repo } from "./progress.ts";

const viewer: User = { login: "viewer", role: "viewer", canWrite: async () => false };

function req(path: string, params: Record<string, string> = {}): PageReq {
  return { method: "GET", path, params, query: new URLSearchParams(), form: new URLSearchParams(), user: viewer, csrf: "", nonce: "static", exporting: true };
}

export function stripControls(html: string): string {
  return html
    .replace(/<form\b[\s\S]*?<\/form>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<(input|button|select|textarea)\b[^>]*>/gi, "")
    .replace(/<\/(button|select|textarea)>/gi, "");
}

export async function exportSite(db: DatabaseSync, dir: string): Promise<{ pages: number }> {
  const pages: [string, (db: DatabaseSync, r: Req) => Res | Promise<Res>, PageReq][] = [
    ["index.html", home, req("/")],
    ["answered/index.html", answeredTab, req("/answered")],
    ["progress/index.html", progress, req("/progress")],
    ["contributors/index.html", contributorsPage, req("/contributors")],
    ["classifiers/index.html", classifiers, req("/classifiers")],
    ["cost/index.html", cost, req("/cost")],
  ];
  const repos = db.prepare("SELECT name FROM repos UNION SELECT DISTINCT repo FROM items").all() as { name: string }[];
  for (const r of repos) pages.push([`repo/${r.name}/index.html`, repo, req(`/repo/${r.name}`, { name: r.name })]);
  // Item pages for everything a decision is about; other items link to GitHub.
  const seen = new Set<string>();
  for (const d of db.prepare("SELECT * FROM decisions").all() as DecisionRow[]) {
    for (const ref of itemsOf(d)) {
      const k = `${ref.repo}/${ref.number}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pages.push([`item/${k}/index.html`, item, req(`/item/${k}`, { repo: ref.repo, n: String(ref.number) })]);
    }
  }
  let n = 0;
  for (const [file, handler, r] of pages) {
    if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.includes("..")) continue;
    const res = await handler(db, r);
    if ((res.status ?? 200) !== 200 || !res.html) continue;
    const out = join(dir, file);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, stripControls(res.html));
    n++;
  }
  return { pages: n };
}
