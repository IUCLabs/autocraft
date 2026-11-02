// Static, read-only copy of the server-rendered pages for later public sharing. Pages
// render as a viewer with no write rights in export mode (no private fields),
// then every form and script is stripped.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res, User } from "../types.ts";
import { classifiers } from "./classifiers.ts";
import { cost } from "./cost.ts";
import type { PageReq } from "./layout.ts";

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
    ["classifiers/index.html", classifiers, req("/classifiers")],
    ["cost/index.html", cost, req("/cost")],
  ];
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
