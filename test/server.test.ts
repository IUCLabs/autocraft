// Acceptance item 5: access checks, with the fake OAuth provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { addLogin, removeLogin, setRole } from "../src/access.ts";
import { connect } from "../src/db.ts";
import type { Route } from "../src/dash/types.ts";
import { ConfigError, loadConfig } from "../src/dash/server/config.ts";
import { defaultRoutes, SESSION_COOKIE, startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";

const SCRATCH = "/home/user/.cache/craft-automation-scratch";
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "server-test-"));
const permsFile = join(dir, "perms.json");
const setPerms = (p: Record<string, Record<string, string>>) => writeFileSync(permsFile, JSON.stringify(p));

let handlerRuns = 0;
// Stand-ins for the pages' decision writes, which check permission the same way.
const testRoutes: Route[] = [
  { method: "GET", pattern: "/test/me", handler: (_db, req) => ({ json: { login: req.user.login, csrf: req.csrf } }) },
  { method: "GET", pattern: "/test/can/:repo", handler: async (_db, req) => ({ json: { can: await req.user.canWrite(req.params.repo!) } }) },
  {
    method: "POST", pattern: "/test/answer/:repo",
    handler: async (_db, req) => {
      handlerRuns++;
      return (await req.user.canWrite(req.params.repo!)) ? { json: { ok: true } } : { status: 403, json: { error: "no write" } };
    },
  },
  {
    method: "POST", pattern: "/test/batch",
    handler: async (_db, req) => {
      const repos = (req.form.get("repos") ?? "").split(",");
      const blocked = [];
      for (const r of repos) if (!(await req.user.canWrite(r))) blocked.push(r);
      return blocked.length ? { status: 403, json: { blocked } } : { json: { ok: true } };
    },
  },
];

const db = connect(join(dir, "dash.db"));
const provider = new FakeProvider(permsFile);
let base = "";
let close: () => Promise<void>;
let allRoutes: Route[];

before(async () => {
  setPerms({ maint: { photocraft: "write" }, boss: {} });
  addLogin(db, "cli", "boss", "admin", null);
  addLogin(db, "cli", "viewer1", "viewer", null);
  addLogin(db, "cli", "maint", "viewer", null);
  const config = loadConfig({
    CRAFT_AUTO_DEV_AUTH: "1", CRAFT_AUTO_LISTEN: "127.0.0.1:0", CRAFT_AUTO_DB: join(dir, "dash.db"), CRAFT_AUTO_DEV_PERMS: permsFile,
  });
  allRoutes = [...(await defaultRoutes()), ...testRoutes];
  const s = await startServer({ config, db, provider, routes: allRoutes });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  async req(method: string, path: string, opts: { form?: Record<string, string>; html?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      accept: opts.html === false ? "application/json" : "text/html",
    };
    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }
    const r = await fetch(new URL(path, base), { method, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, v] = [kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1)];
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  get = (path: string, html = true) => this.req("GET", path, { html });
  post = (path: string, form: Record<string, string>) => this.req("POST", path, { form, html: false });
  async signIn(login: string): Promise<Response> {
    const start = await this.get("/auth/signin?return_to=/");
    assert.equal(start.status, 303);
    const auth = await this.get(`${start.headers.get("location")}&login=${login}`);
    assert.equal(auth.status, 303);
    return this.get(auth.headers.get("location")!);
  }
  async csrf(): Promise<string> {
    return ((await (await this.get("/test/me", false)).json()) as { csrf: string }).csrf;
  }
}

async function signedIn(login: string): Promise<Client> {
  const c = new Client();
  const r = await c.signIn(login);
  assert.equal(r.status, 303, `sign-in of ${login}`);
  return c;
}

const sample = (pattern: string) => pattern.replace(/:[a-z]+/gi, "x");
const audits = (action: string) => db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ?").get(action) as { n: number };

describe("without a session", () => {
  test("every page redirects to sign-in, everything else gets 401", async () => {
    const c = new Client();
    const paths = [...allRoutes.filter((r) => r.method === "GET").map((r) => sample(r.pattern)), "/assets/app.css", "/no-such-page"];
    for (const p of paths) {
      const page = await c.get(p);
      assert.equal(page.status, 303, p);
      assert.equal(page.headers.get("location"), `/auth/signin?${new URLSearchParams({ return_to: p })}`);
      assert.equal((await c.get(p, false)).status, 401, p);
    }
    for (const r of allRoutes.filter((r) => r.method === "POST")) {
      assert.equal((await c.post(sample(r.pattern), { csrf: "x" })).status, 401, r.pattern);
    }
    assert.equal(handlerRuns, 0);
  });
});

describe("sign-in", () => {
  test("a login not on the access list gets no session", async () => {
    const c = new Client();
    const r = await c.signIn("stranger");
    assert.equal(r.status, 403);
    assert.match(await r.text(), /Not authorised/);
    assert.equal(c.jar.has(SESSION_COOKIE), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE login = 'stranger'").get() as { n: number }).n, 0);
    assert.equal(audits("sign-in-refused").n, 1);
  });

  test("a session cookie is HttpOnly, Secure, SameSite=Lax; the token stays encrypted", async () => {
    const c = new Client();
    const r = await c.signIn("viewer1");
    const set = r.headers.getSetCookie().find((s) => s.startsWith(SESSION_COOKIE))!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, /Path=\//);
    const page = await c.get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self' 'nonce-[\w-]+'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    const rows = db.prepare("SELECT token_enc FROM sessions").all() as { token_enc: string }[];
    for (const row of rows) assert.doesNotMatch(row.token_enc, /dev_/);
  });

  test("a sign-in callback with a forged state is refused", async () => {
    const c = new Client();
    const start = await c.get("/auth/signin");
    const auth = await c.get(`${start.headers.get("location")}&login=viewer1`);
    const cb = new URL(auth.headers.get("location")!, base);
    cb.searchParams.set("state", "forged");
    assert.equal((await c.get(cb.pathname + cb.search)).status, 400);
    assert.equal(c.jar.has(SESSION_COOKIE), false);
  });
});

describe("permissions", () => {
  test("a viewer can read, but every write returns 403", async () => {
    const c = await signedIn("viewer1");
    assert.equal((await c.get("/")).status, 200);
    assert.equal((await c.get("/access")).status, 403);
    const csrf = await c.csrf();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
    for (const r of allRoutes.filter((r) => r.method === "POST")) {
      const status = (await c.post(sample(r.pattern), { csrf, login: "viewer1", role: "admin", repos: "photocraft", id: "1" })).status;
      if (r.admin) assert.equal(status, 403, r.pattern);
      else assert.ok(status >= 400, `${r.pattern}: ${status}`);
    }
    assert.equal((await c.post("/test/answer/photocraft", { csrf })).status, 403);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n, before);
  });

  test("a maintainer answers only in repos where they have write", async () => {
    const c = await signedIn("maint");
    const csrf = await c.csrf();
    assert.equal((await c.post("/test/answer/photocraft", { csrf })).status, 200);
    assert.equal((await c.post("/test/answer/filmcraft", { csrf })).status, 403);
  });

  test("a batch spanning a repo without write is refused", async () => {
    const c = await signedIn("maint");
    const csrf = await c.csrf();
    const r = await c.post("/test/batch", { csrf, repos: "photocraft,filmcraft" });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { blocked: ["filmcraft"] });
    assert.equal((await c.post("/test/batch", { csrf, repos: "photocraft" })).status, 200);
  });

  test("reads use the 10-minute cache; writes re-check a value older than a minute", async () => {
    const c = await signedIn("maint");
    const csrf = await c.csrf();
    assert.equal((await c.post("/test/answer/photocraft", { csrf })).status, 200);
    setPerms({ maint: {} });
    db.prepare("UPDATE repo_permissions SET checked_at = ? WHERE login = 'maint'").run(new Date(Date.now() - 120_000).toISOString());
    assert.deepEqual(await (await c.get("/test/can/photocraft", false)).json(), { can: true });
    assert.equal((await c.post("/test/answer/photocraft", { csrf })).status, 403);
    setPerms({ maint: { photocraft: "write" }, boss: {} });
    db.prepare("DELETE FROM repo_permissions").run();
  });

  test("a POST without the right CSRF token is refused before the handler runs", async () => {
    const c = await signedIn("maint");
    const runs = handlerRuns;
    assert.equal((await c.post("/test/answer/photocraft", {})).status, 403);
    assert.equal((await c.post("/test/answer/photocraft", { csrf: "wrong" })).status, 403);
    const other = await signedIn("viewer1");
    assert.equal((await c.post("/test/answer/photocraft", { csrf: await other.csrf() })).status, 403);
    assert.equal(handlerRuns, runs);
  });
});

describe("tokens", () => {
  test("a permission check after the access token expires refreshes it", async () => {
    provider.tokenTtlMs = 300;
    const c = await signedIn("maint");
    provider.tokenTtlMs = 8 * 3_600_000;
    await sleep(350);
    db.prepare("DELETE FROM repo_permissions").run();
    const refreshes = provider.refreshes;
    assert.deepEqual(await (await c.get("/test/can/photocraft", false)).json(), { can: true });
    assert.equal(provider.refreshes, refreshes + 1);
  });

  test("a failed refresh ends the session", async () => {
    provider.tokenTtlMs = 300;
    const c = await signedIn("maint");
    provider.tokenTtlMs = 8 * 3_600_000;
    await sleep(350);
    db.prepare("DELETE FROM repo_permissions").run();
    provider.rejectRefresh = true;
    try {
      assert.deepEqual(await (await c.get("/test/can/photocraft", false)).json(), { can: false });
    } finally {
      provider.rejectRefresh = false;
    }
    assert.equal((await c.get("/")).status, 303);
  });
});

describe("access changes", () => {
  test("removing a login on the Access page ends its session", async () => {
    addLogin(db, "cli", "leaver", "viewer", null);
    const victim = await signedIn("leaver");
    assert.equal((await victim.get("/")).status, 200);
    const admin = await signedIn("boss");
    const page = await (await admin.get("/access")).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    assert.equal((await admin.post("/access/remove", { csrf, login: "leaver" })).status, 303);
    assert.equal((await victim.get("/")).status, 303);
    assert.equal((await victim.get("/", false)).status, 401);
    assert.equal(audits("access-remove").n, 1);
  });

  test("changing a role ends the login's sessions", async () => {
    addLogin(db, "cli", "promoted", "viewer", null);
    const c = await signedIn("promoted");
    setRole(db, "cli", "promoted", "admin");
    assert.equal((await c.get("/")).status, 303);
    removeLogin(db, "cli", "promoted");
  });

  test("the last admin can't be removed from the page", async () => {
    const admin = await signedIn("boss");
    const csrf = await admin.csrf();
    assert.equal((await admin.post("/access/remove", { csrf, login: "boss" })).status, 400);
    assert.equal((await admin.get("/")).status, 200);
  });
});

describe("startup refusals", () => {
  const secrets = (mode: number, body: object) => {
    const p = join(dir, `secrets-${mode.toString(8)}-${Object.keys(body).length}.json`);
    writeFileSync(p, JSON.stringify(body));
    chmodSync(p, mode);
    return p;
  };
  const full = { github_client_id: "id", github_client_secret: "secret", session_key: "k".repeat(43) };
  const env = (file: string) => ({ CRAFT_AUTO_SECRETS_FILE: file, CRAFT_AUTO_BASE_URL: "https://dash.example" });

  test("dev auth on a non-loopback address", () => {
    assert.throws(() => loadConfig({ CRAFT_AUTO_DEV_AUTH: "1", CRAFT_AUTO_LISTEN: "0.0.0.0:8993" }), ConfigError);
    const r = spawnSync(process.execPath, ["src/cli.ts", "dash", "serve"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
      env: { PATH: process.env.PATH, CRAFT_AUTO_DEV_AUTH: "1", CRAFT_AUTO_LISTEN: "0.0.0.0:0", CRAFT_AUTO_DB: join(dir, "spawn.db") },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /loopback/);
  });

  test("a world- or group-readable, missing or incomplete secrets file", () => {
    assert.throws(() => loadConfig(env(secrets(0o644, full))), /group or others/);
    assert.throws(() => loadConfig(env(secrets(0o640, full))), /group or others/);
    assert.throws(() => loadConfig(env(join(dir, "missing.json"))), /not found/);
    assert.throws(() => loadConfig(env(secrets(0o600, { github_client_id: "id" }))), /missing/);
    assert.throws(() => loadConfig({ CRAFT_AUTO_SECRETS_FILE: secrets(0o600, full) }), /BASE_URL/);
    assert.equal(loadConfig(env(secrets(0o600, full))).baseUrl, "https://dash.example");
  });
});
