// GitHub App registration through the dashboard, with a fake GitHub for the
// manifest conversion: the keys land in the secrets file (mode 0600) and
// nowhere else, the state nonce works once, only operators reach the page's
// API, and app sign-in keeps the user's token sealed in user_tokens.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { connect } from "../src/db.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "github-app-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
const secretsFile = join(dir, "secrets.json");
writeFileSync(permsFile, "{}");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CLIENT_SECRET = "client-secret-for-the-test";
const WEBHOOK_SECRET = "webhook-secret-for-the-test";

const db = connect(dbFile);
let github: Server;
let converted: string[] = [];
const closers: Array<() => Promise<void>> = [];
let base = "";

before(async () => {
  github = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (req.method === "POST" && url.startsWith("/app-manifests/")) {
      const code = decodeURIComponent(url.split("/")[2]!);
      converted.push(code);
      return code === "good-code"
        ? send(201, { id: 4242, slug: "autocraft-test", name: "AutoCraft", client_id: "Iv1.test", client_secret: CLIENT_SECRET, webhook_secret: WEBHOOK_SECRET, pem: PEM })
        : send(404, { message: "Not Found" });
    }
    if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return send(401, {});
    if (url === "/app") return send(200, { name: "AutoCraft" });
    if (url.startsWith("/app/installations?")) return send(200, [{ id: 7, account: { login: "glasswing" }, repository_selection: "selected" }]);
    if (req.method === "POST" && url === "/app/installations/7/access_tokens") return send(201, { token: "ghs_installation" });
    if (url.startsWith("/installation/repositories")) return send(200, { repositories: [{ full_name: "glasswing/photocraft" }] });
    send(404, {});
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  const githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  addLogin(db, "cli", "boss", "operator", null);
  addLogin(db, "cli", "viewer1", "viewer", null);
  addLogin(db, "cli", "maint", "maintainer", null);
  const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: secretsFile };
  const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
  base = s.url;
  closers.push(s.close);
});
after(async () => {
  for (const c of closers) await c();
  await new Promise((r) => github.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }
  async req(path: string): Promise<Response> {
    const r = await fetch(new URL(path, this.origin), { headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" }, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
}

async function signedIn(login: string, origin = base): Promise<Client> {
  const c = new Client(origin);
  const start = await c.req("/auth/signin?return_to=/");
  const auth = await c.req(`${start.headers.get("location")}&login=${login}`);
  assert.equal((await c.req(auth.headers.get("location")!)).status, 303, `sign-in of ${login}`);
  return c;
}

describe("github app registration", () => {
  test("only operators reach the page's API and the registration start", async () => {
    for (const login of ["viewer1", "maint"]) {
      const c = await signedIn(login);
      assert.equal((await c.req("/api/admin/github-app")).status, 403);
      assert.equal((await c.req("/auth/github-app/start")).status, 403);
    }
  });

  test("registration stores the keys 0600, returns none of them, and the state works once", async () => {
    const boss = await signedIn("boss");
    const before = (await (await boss.req("/api/admin/github-app")).json()) as { configured: boolean };
    assert.equal(before.configured, false);

    const page = await (await boss.req("/auth/github-app/start?name=AutoCraft")).text();
    const state = /settings\/apps\/new\?state=([A-Za-z0-9_-]+)/.exec(page)?.[1];
    assert.ok(state, "the start page posts to GitHub with a state");
    assert.match(page, /&#34;active&#34;:false/);
    assert.match(page, /&#34;callback_urls&#34;:\[&#34;http:\/\/127\.0\.0\.1:\d+\/auth\/callback&#34;\]/);

    const done = await boss.req(`/auth/github-app/callback?code=good-code&state=${state}`);
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin/github-app");
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(secretsFile, "utf8")) as Record<string, string>;
    assert.equal(stored.github_app_slug, "autocraft-test");
    assert.equal(stored.github_app_private_key, PEM);
    assert.equal(stored.github_app_client_secret, CLIENT_SECRET);

    const replay = await boss.req(`/auth/github-app/callback?code=good-code&state=${state}`);
    assert.equal(replay.status, 400);
    assert.deepEqual(converted, ["good-code"]);

    const text = await (await boss.req("/api/admin/github-app")).text();
    const status = JSON.parse(text) as { configured: boolean; app: { slug: string; installUrl: string }; installations: { owner: string; repos: string[] }[] };
    assert.equal(status.configured, true);
    assert.equal(status.app.slug, "autocraft-test");
    assert.equal(status.app.installUrl, "https://github.com/apps/autocraft-test/installations/new");
    assert.deepEqual(status.installations, [{ owner: "glasswing", selection: "selected", repos: ["glasswing/photocraft"] }]);
    const audit = JSON.stringify(db.prepare("SELECT * FROM audit").all());
    for (const secret of [PEM.slice(40, 80), CLIENT_SECRET, WEBHOOK_SECRET, "ghs_installation"]) {
      assert.ok(!text.includes(secret) && !page.includes(secret) && !audit.includes(secret));
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github-app-register' AND target = 'autocraft-test'").get() as { n: number }).n, 1);
  });

  test("app sign-in keeps the user's token sealed in user_tokens and is audited as a mode change", async () => {
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: secretsFile, AUTOCRAFT_LOGIN_APP: "github-app" };
    const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [] });
    closers.push(s.close);
    await signedIn("maint", s.url);
    const row = db.prepare("SELECT token_enc, version, status FROM user_tokens WHERE login = 'maint'").get() as { token_enc: string; version: number; status: string };
    assert.equal(row.status, "ok");
    assert.ok(row.token_enc && !row.token_enc.includes("dev_"));
    await signedIn("maint", s.url);
    assert.equal((db.prepare("SELECT version FROM user_tokens WHERE login = 'maint'").get() as { version: number }).version, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github-app-login-mode' AND target = 'github-app'").get() as { n: number }).n, 1);
  });
});
