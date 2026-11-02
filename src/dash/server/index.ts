// HTTP server: sign-in, sessions, CSRF, rate limits, security headers and
// routing for the dashboard. Handlers only ever see authenticated requests.
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { LOGIN, getAccess } from "../../access.ts";
import { audit } from "../audit.ts";
import type { Req, Res, Route } from "../types.ts";
import type { Config } from "./config.ts";
import { pkceChallenge, randomToken, safeEqual, TokenBox } from "./crypto.ts";
import { ImageProxy } from "./images.ts";
import { FakeProvider, providerFor, type Provider, type Tokens } from "./provider.ts";
import { createSession, deleteSession, loadSession, makeUser, pruneExpired, SESSION_TTL, type Session } from "./sessions.ts";
import { esc, HttpError, parseCookies, plainPage, RateLimiter, safeReturnTo } from "./util.ts";

export const SESSION_COOKIE = "__Host-craft_session";
const STATE_COOKIE = "__Host-craft_oauth";
const BODY_LIMIT = 64 * 1024;
const FILE_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", ico: "image/x-icon", woff2: "font/woff2", json: "application/json",
  txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json",
};

// The one inline style the frontend needs: react-remove-scroll-bar (under
// Radix Dialog and DropdownMenu) injects a <style> while a modal is open. Its
// text depends only on the page scrollbar's width and the body's margins,
// which the app's CSS fixes at 0 (body has no margin and overflow: hidden),
// so the text is always the same. Recompute the hash if that package changes
// the text; Chrome's console names the expected hash on a violation.
const RADIX_SCROLL_LOCK_STYLE = "'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='";

// The React app (web/): scripts and styles from this origin only, no nonce.
export const APP_CSP = [
  "default-src 'none'", "script-src 'self'", `style-src 'self' ${RADIX_SCROLL_LOCK_STYLE}`,
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "form-action 'self'",
  "base-uri 'none'", "frame-ancestors 'none'",
].join("; ");

export type AppOptions = {
  config: Config;
  db: DatabaseSync;
  provider?: Provider;
  routes?: Route[];          // default: the JSON API
  images?: ImageProxy;       // default: fetches with global fetch and the bot's gh token
};

type Compiled = Route & { parts: string[] };


export async function defaultRoutes(): Promise<Route[]> {
  const { apiRoutes } = await import("../api/index.ts");
  return apiRoutes();
}

function compile(routes: Route[]): Compiled[] {
  return routes.map((r) => ({ ...r, parts: r.pattern.split("/").filter(Boolean) }));
}

function match(routes: Compiled[], method: string, path: string): { route?: Compiled; params?: Record<string, string>; other: boolean } {
  const segs = path.split("/").filter(Boolean);
  let other = false;
  for (const r of routes) {
    if (r.parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      const p = r.parts[i]!;
      if (p.startsWith(":")) {
        try {
          params[p.slice(1)] = decodeURIComponent(segs[i]!);
        } catch {
          ok = false;
        }
      } else ok = p === segs[i];
    }
    if (!ok) continue;
    if (r.method === method) return { route: r, params, other };
    other = true;
  }
  return { other };
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > BODY_LIMIT) throw new HttpError(413, "Request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const contentType = (req: IncomingMessage): string => (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readRaw(req);
  if (raw.length === 0) return new URLSearchParams();
  if (contentType(req) !== "application/x-www-form-urlencoded") throw new HttpError(415, "Forms must be sent as application/x-www-form-urlencoded");
  return new URLSearchParams(raw.toString("utf8"));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  if (raw.length === 0) return undefined;
  if (contentType(req) !== "application/json") throw new HttpError(415, "Send the body as application/json");
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "The body is not valid JSON");
  }
}

// API clients send the session's CSRF token in this header; every /api/
// response carries it, so the client reads it from GET /api/me.
export const CSRF_HEADER = "x-csrf-token";

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function createApp(opts: AppOptions & { routes: Route[] }) {
  const { config, db } = opts;
  const provider = opts.provider ?? providerFor(config);
  const box = new TokenBox(config.secrets.sessionKey);
  const routes = compile(opts.routes);
  const signinLimit = new RateLimiter(60, 10 * 60_000);
  const writeLimitSession = new RateLimiter(60, 60_000);
  const writeLimitIp = new RateLimiter(300, 60_000);
  const images = opts.images ?? new ImageProxy({ cacheDir: config.imageCacheDir });
  const imageLimit = new RateLimiter(120, 60_000);    // upstream fetches per session; cache hits are free
  const callbackUrl = `${config.baseUrl ?? ""}/auth/callback`;
  let lastPrune = 0;

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]!;
    }
    return req.socket.remoteAddress ?? "?";
  }

  function secure(headers: Record<string, string | string[]>, csp: string): Record<string, string | string[]> {
    headers["content-security-policy"] = csp;
    headers["x-frame-options"] = "DENY";
    headers["referrer-policy"] = "same-origin";
    headers["x-content-type-options"] = "nosniff";
    headers["cross-origin-opener-policy"] = "same-origin";
    if (config.baseUrl?.startsWith("https:")) headers["strict-transport-security"] = "max-age=31536000";
    return headers;
  }

  function send(res: ServerResponse, nonce: string, r: Res, extraCookies: string[] = []): void {
    const status = r.status ?? (r.redirect ? 303 : 200);
    const headers: Record<string, string | string[]> = { ...r.headers };
    headers["cache-control"] ??= "no-store";
    secure(headers, [
      "default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "form-action 'self'",
      "base-uri 'none'", "frame-ancestors 'none'",
    ].join("; "));
    if (extraCookies.length) headers["set-cookie"] = extraCookies;
    let body: string | Buffer = "";
    if (r.redirect) headers.location = r.redirect;
    if (r.html !== undefined) {
      headers["content-type"] ??= "text/html; charset=utf-8";
      body = r.html;
    } else if (r.json !== undefined) {
      headers["content-type"] ??= "application/json; charset=utf-8";
      body = JSON.stringify(r.json);
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  const errorPage = (nonce: string, status: number, title: string, text: string): Res =>
    ({ status, html: plainPage(nonce, title, `<p>${esc(text)}</p><p><a href="/">Dashboard</a></p>`) });
  const apiError = (status: number, error: string): Res => ({ status, json: { error } });

  // A browser sends Origin on every POST it makes with fetch, and
  // Sec-Fetch-Site on current engines; either one from another site is refused.
  // Clients that send neither still need the CSRF header.
  function sameOrigin(req: IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const expected = config.baseUrl ?? `http://${req.headers.host ?? ""}`;
    try {
      return origin === new URL(expected).origin;
    } catch {
      return false;
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string, session: Session): Promise<void> {
    const method = req.method;
    const out = (r: Res, cookies?: string[]) =>
      send(res, nonce, { ...r, headers: { ...r.headers, [CSRF_HEADER]: session.csrf } }, cookies);
    if (method !== "GET" && method !== "POST") return out(apiError(405, "method not allowed"));
    let json: unknown;
    if (method === "POST") {
      if (!sameOrigin(req)) return out(apiError(403, "cross-origin request refused"));
      if (!writeLimitSession.allow(session.idHash) || !writeLimitIp.allow(clientIp(req))) return out(apiError(429, "too many requests; wait a minute"));
      json = await readJson(req);
      if (!safeEqual(String(req.headers[CSRF_HEADER] ?? ""), session.csrf)) return out(apiError(403, "missing or wrong CSRF token"));
      if (url.pathname === "/api/signout") {
        deleteSession(db, parseCookies(req.headers.cookie).get(SESSION_COOKIE)!);
        return send(res, nonce, { status: 204 }, [cookie(SESSION_COOKIE, "", 0)]);
      }
    }
    const { route, params, other } = match(routes, method, url.pathname);
    if (!route) return out(other ? apiError(405, "method not allowed") : apiError(404, "not found"));
    if (route.operator && session.role !== "operator") return out(apiError(403, "operators only"));
    const r: Req = {
      method, path: url.pathname, params: params!, query: url.searchParams, form: new URLSearchParams(), json,
      user: makeUser(db, box, provider, session, method === "POST"),
      csrf: session.csrf, nonce,
    };
    return out(await route.handler(db, r));
  }

  async function auth(req: IncomingMessage, url: URL, nonce: string, cookies: Map<string, string>): Promise<{ r: Res; cookies?: string[] }> {
    const ip = clientIp(req);
    const path = url.pathname;
    if (req.method === "GET" && path === "/auth/signin") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));
      if (loadSession(db, cookies.get(SESSION_COOKIE))) return { r: { redirect: returnTo } };
      const state = randomToken(24), verifier = randomToken(48);
      db.prepare("INSERT INTO oauth_states (state, verifier, return_to, created_at) VALUES (?, ?, ?, ?)")
        .run(state, verifier, returnTo, new Date().toISOString());
      return {
        r: { redirect: provider.authorizeUrl(state, pkceChallenge(verifier), callbackUrl) },
        cookies: [cookie(STATE_COOKIE, state, 600)],
      };
    }
    if (req.method === "GET" && path === "/auth/callback") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const clear = [cookie(STATE_COOKIE, "", 0)];
      if (url.searchParams.get("error")) {
        return { r: errorPage(nonce, 400, "Sign-in cancelled", "GitHub sign-in did not complete."), cookies: clear };
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const row = db.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING verifier, return_to, created_at").get(state) as
        { verifier: string; return_to: string | null; created_at: string } | undefined;
      const cookieState = cookies.get(STATE_COOKIE) ?? "";
      if (!row || !code || !safeEqual(cookieState, state) || Date.now() - Date.parse(row.created_at) > 600_000) {
        return { r: errorPage(nonce, 400, "Sign-in expired", "Start again from the sign-in link."), cookies: clear };
      }
      let tokens: Tokens | null, login: string | null;
      try {
        tokens = await provider.exchange(code, row.verifier, callbackUrl);
        login = tokens ? await provider.login(tokens.access) : null;
      } catch (e) {
        console.error(`sign-in: ${(e as Error).message}`);
        return { r: errorPage(nonce, 502, "Sign-in failed", "GitHub did not answer. Try again in a minute."), cookies: clear };
      }
      if (!tokens || !login) {
        return { r: errorPage(nonce, 400, "Sign-in failed", "GitHub did not accept the sign-in. Start again."), cookies: clear };
      }
      const access = getAccess(db, login);
      if (!access) {
        audit(db, login, "sign-in-refused", login, { ip });
        return { r: errorPage(nonce, 403, "Not authorised", `The GitHub account ${login} is not on this dashboard's access list.`), cookies: clear };
      }
      const id = createSession(db, box, access.login, tokens, req.headers["user-agent"]);
      audit(db, access.login, "sign-in", access.login, { ip });
      return {
        r: { redirect: safeReturnTo(row.return_to) },
        cookies: [...clear, cookie(SESSION_COOKIE, id, SESSION_TTL / 1000)],
      };
    }
    if (req.method === "POST" && path === "/auth/signout") {
      if (!sameOrigin(req)) return { r: errorPage(nonce, 403, "Refused", "This form was sent from another site.") };
      const form = await readBody(req);
      const id = cookies.get(SESSION_COOKIE);
      const s = loadSession(db, id);
      if (s) {
        if (!safeEqual(form.get("csrf") ?? "", s.csrf)) return { r: errorPage(nonce, 403, "Refused", "The form expired. Reload the page and try again.") };
        deleteSession(db, id!);
      }
      return { r: { redirect: "/auth/signed-out" }, cookies: [cookie(SESSION_COOKIE, "", 0)] };
    }
    if (req.method === "GET" && path === "/auth/signed-out") {
      return { r: { html: plainPage(nonce, "Signed out", `<p><a href="/auth/signin">Sign in again</a></p>`) } };
    }
    if (req.method === "GET" && path === "/auth/dev/authorize" && provider instanceof FakeProvider) {
      const q = url.searchParams;
      if (q.get("redirect_uri") !== callbackUrl) return { r: errorPage(nonce, 400, "Bad request", "Unknown redirect_uri.") };
      const login = q.get("login");
      if (login !== null) {
        if (!LOGIN.test(login)) return { r: errorPage(nonce, 400, "Bad request", "Not a GitHub login.") };
        const code = provider.issueCode(login, q.get("code_challenge") ?? "", callbackUrl);
        return { r: { redirect: `${callbackUrl}?${new URLSearchParams({ code, state: q.get("state") ?? "" })}` } };
      }
      const hidden = ["state", "code_challenge", "redirect_uri"]
        .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join("");
      return {
        r: {
          html: plainPage(nonce, "Development sign-in", `<p class="muted">Fake GitHub sign-in. Development only.</p>
<form method="get" action="/auth/dev/authorize">${hidden}<label>GitHub login <input name="login" required autofocus></label> <button>Sign in</button></form>`),
        },
      };
    }
    return { r: errorPage(nonce, 404, "Not found", "No such page.") };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = randomToken(16);
    try {
      if (Date.now() - lastPrune > 3_600_000) {
        lastPrune = Date.now();
        pruneExpired(db);
      }
      const url = new URL(req.url ?? "/", "http://dashboard.invalid");
      const cookies = parseCookies(req.headers.cookie);
      if (url.pathname.startsWith("/auth/")) {
        const { r, cookies: set } = await auth(req, url, nonce, cookies);
        return send(res, nonce, r, set);
      }
      const method = req.method;
      const session = loadSession(db, cookies.get(SESSION_COOKIE));
      if (!session) {
        const wantsPage = method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
        if (wantsPage) return send(res, nonce, { redirect: `/auth/signin?${new URLSearchParams({ return_to: url.pathname + url.search })}` });
        return send(res, nonce, { status: 401, json: { error: "sign-in required" } });
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, nonce, session);
      if (url.pathname === "/img") return await sendImage(req, res, url, session);
      // Every other address belongs to the React app, which routes on the client.
      if (method === "GET") return await sendWeb(res, nonce, url.pathname);
      return send(res, nonce, errorPage(nonce, 405, "Not allowed", "This address does not accept that request."));
    } catch (e) {
      const api = (req.url ?? "").startsWith("/api/");
      if (e instanceof HttpError) return send(res, nonce, api ? apiError(e.status, e.message) : errorPage(nonce, e.status, "Request refused", e.message));
      console.error(`${req.method} ${(req.url ?? "").split("?")[0]}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, nonce, api ? apiError(500, "server error; it is logged") : errorPage(nonce, 500, "Something went wrong", "The error is logged on the server."));
      else res.destroy();
    }
  }

  async function sendImage(req: IncomingMessage, res: ServerResponse, url: URL, session: Session): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405, secure({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "default-src 'none'"));
      return void res.end("method not allowed");
    }
    const r = await images.get(url.searchParams.get("u") ?? "", () => imageLimit.allow(session.idHash));
    if (r.status !== 200) {
      res.writeHead(r.status, secure({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "default-src 'none'"));
      return void res.end(r.error ?? "");
    }
    return sendFile(res, r.type!, "private, max-age=86400", "default-src 'none'", r.data!);
  }

  function sendFile(res: ServerResponse, type: string, cache: string, csp: string, data: Buffer): void {
    res.writeHead(200, secure({ "content-type": type, "cache-control": cache }, csp));
    res.end(data);
  }

  async function readDist(rel: string[]): Promise<Buffer | null> {
    const full = resolve(config.webDist, ...rel);
    const r = relative(config.webDist, full);
    if (!r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
    try {
      return await readFile(full);
    } catch {
      return null;    // missing, or a directory
    }
  }

  // The frontend's build output: hashed files under /assets/ are cached for a
  // year; any other path gets index.html, never cached, so a new build is
  // picked up on the next load.
  async function sendWeb(res: ServerResponse, nonce: string, pathname: string): Promise<void> {
    const notFound = () => send(res, nonce, errorPage(nonce, 404, "Not found", "No such file."));
    const rel: string[] = [];
    for (const raw of pathname.split("/")) {
      let seg: string;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        return notFound();
      }
      if (seg === "") continue;
      if (seg === "." || seg === ".." || /[\\/\0]/.test(seg)) return notFound();
      rel.push(seg);
    }
    const ext = rel.length ? /\.([a-z0-9]+)$/.exec(rel[rel.length - 1]!)?.[1] : undefined;
    if (rel[0] === "assets") {
      const data = ext && FILE_TYPES[ext] ? await readDist(rel) : null;
      if (!data) return notFound();
      return sendFile(res, FILE_TYPES[ext!]!, "private, max-age=31536000, immutable", "default-src 'none'", data);
    }
    if (rel.length === 1 && ext && FILE_TYPES[ext]) {
      const data = await readDist(rel);
      if (data) return sendFile(res, FILE_TYPES[ext]!, "private, max-age=3600", "default-src 'none'", data);
    }
    const index = await readDist(["index.html"]);
    if (!index) {
      return send(res, nonce, {
        status: 503,
        html: plainPage(nonce, "Frontend not built", `<p>The dashboard's frontend is not built: there is no <code>index.html</code> in the directory <code>CRAFT_AUTO_WEB_DIST</code> names (default <code>web/dist</code> in the repo).</p>
<p>Build it with <code>pnpm -C web install</code> and <code>pnpm -C web build</code>, then reload.</p>`),
      });
    }
    return sendFile(res, "text/html; charset=utf-8", "no-cache", APP_CSP, index);
  }

  return { handle, routes: opts.routes, provider };
}

export async function startServer(opts: AppOptions): Promise<{ server: Server; url: string; app: ReturnType<typeof createApp>; close(): Promise<void> }> {
  const app = createApp({ ...opts, routes: opts.routes ?? (await defaultRoutes()) });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => void app.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.config.port, opts.config.host, resolve);
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    server, app,
    url: `http://${host}:${addr.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
