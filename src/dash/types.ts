// The contract between the server (auth, sessions, routing: src/dash/server/)
// and the pages (src/dash/pages/). The server authenticates every request and
// checks CSRF on every POST before a handler runs.
import type { DatabaseSync } from "node:sqlite";

export type Role = "admin" | "viewer";

export type User = {
  login: string;
  role: Role;
  // write, maintain or admin on storytold/<repo>, checked against GitHub
  // (cached; re-checked when older than a minute). Handlers call this
  // before every decision write.
  canWrite(repo: string): Promise<boolean>;
};

export type Req = {
  method: "GET" | "POST";
  path: string;
  params: Record<string, string>;   // from the route pattern, e.g. /item/:repo/:n
  query: URLSearchParams;
  form: URLSearchParams;            // POST body (application/x-www-form-urlencoded)
  json?: unknown;                   // POST body of an /api/ route (application/json)
  user: User;
  csrf: string;                     // put in every form as <input type=hidden name=csrf>
  nonce: string;                    // put on every <script> and <style> as nonce="..."
};

export type Res = {
  status?: number;                  // default 200
  html?: string;
  redirect?: string;                // 303 for POSTs
  json?: unknown;
  headers?: Record<string, string>;
};

export type Route = {
  method: "GET" | "POST";
  pattern: string;                  // "/", "/repo/:name", "/item/:repo/:n"
  admin?: boolean;                  // server returns 403 unless user.role is admin
  handler: (db: DatabaseSync, req: Req) => Res | Promise<Res>;
};
