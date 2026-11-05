// The operator's GitHub App registration: the status the admin page reads, the
// start page that posts the manifest to GitHub, and the callback that turns the
// returned code into the app's keys. The keys go to the secrets file only; no
// response, log line or audit row carries the private key or client secret.
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { GithubAppStatus } from "../../../web/src/api/types.ts";
import { audit } from "../audit.ts";
import { AppError, APP_NAME, appManifest, appName, convertManifest, installUrl, installations, installationRepos, registrationUrl, transferUrl, type AppDeps } from "../../github/app.ts";
import type { Res, Route } from "../types.ts";
import { envVar } from "../../env.ts";
import { writeAppSecrets, type Config } from "./config.ts";
import { randomToken } from "./crypto.ts";
import { esc, plainPage } from "./util.ts";

export const DEFAULT_APP_NAME = "AutoCraft";
const STATE_TTL_MS = 3_600_000;   // GitHub's one-time code lives an hour
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const publicBase = (config: Config, req: IncomingMessage): string => config.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;

export function githubAppRoutes(config: Config, deps: AppDeps): Route[] {
  return [{
    method: "GET", pattern: "/api/admin/github-app", operator: true,
    handler: async (): Promise<Res> => ({ json: await githubAppStatus(config, deps) }),
  }];
}

export async function githubAppStatus(config: Config, deps: AppDeps): Promise<GithubAppStatus> {
  const app = config.secrets.app;
  const status: GithubAppStatus = {
    configured: !!app, loginMode: config.loginApp, canRegister: !!config.secretsFile,
    defaultName: envVar("GITHUB_APP_NAME") ?? DEFAULT_APP_NAME, app: null, installations: [], error: null,
  };
  if (!app) return status;
  status.app = { id: app.id, slug: app.slug, name: null, installUrl: installUrl(app.slug), transferUrl: transferUrl(app.slug) };
  try {
    status.app.name = await appName(app, deps);
    for (const i of await installations(app, deps)) {
      status.installations.push({ owner: i.owner, selection: i.selection, repos: await installationRepos(app, i.id, deps) });
    }
  } catch (e) {
    status.error = e instanceof AppError ? e.message : "GitHub could not be read";
  }
  return status;
}

/** Records the login mode the server started with when it differs from the last one recorded. */
export function auditLoginMode(db: DatabaseSync, config: Config): void {
  const last = db.prepare("SELECT target FROM audit WHERE action = 'github-app-login-mode' ORDER BY rowid DESC LIMIT 1").get() as { target: string } | undefined;
  if ((last?.target ?? "oauth") !== config.loginApp) audit(db, "system", "github-app-login-mode", config.loginApp, { from: last?.target ?? "oauth" });
}

const refuse = (nonce: string, status: number, text: string): Res =>
  ({ status, html: plainPage(nonce, "GitHub App", `<p>${esc(text)}</p><p><a href="/admin/github-app">GitHub App</a></p>`) });

/** GET /auth/github-app/start?name=&org=: a page that posts the manifest to GitHub. Operators only. */
export function startRegistration(db: DatabaseSync, config: Config, req: IncomingMessage, url: URL, nonce: string, login: string | null, isOperator: boolean): Res {
  if (!login || !isOperator) return refuse(nonce, 403, "Only operators can register the GitHub App.");
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return refuse(nonce, 403, "Start the registration from the GitHub App page.");
  if (config.secrets.app) return refuse(nonce, 409, "An app is already registered.");
  if (!config.secretsFile) return refuse(nonce, 409, "AUTOCRAFT_SECRETS_FILE is not set, so there is nowhere to keep the app's keys.");
  const name = (url.searchParams.get("name") ?? "").trim() || envVar("GITHUB_APP_NAME") || DEFAULT_APP_NAME;
  const org = (url.searchParams.get("org") ?? "").trim() || null;
  if (!APP_NAME.test(name)) return refuse(nonce, 400, "The app name must be 1 to 34 letters, digits, spaces, dashes or underscores.");
  if (org && !ORG.test(org)) return refuse(nonce, 400, "That is not a GitHub organization name.");
  const state = randomToken(24);
  db.prepare("DELETE FROM github_app_states WHERE created_at <= ?").run(new Date(Date.now() - STATE_TTL_MS).toISOString());
  db.prepare("INSERT INTO github_app_states (state, login, created_at) VALUES (?, ?, ?)").run(state, login, new Date().toISOString());
  const manifest = JSON.stringify(appManifest(name, publicBase(config, req)));
  const body = `<p class="muted">Sending the app's manifest to GitHub. Confirm the app there.</p>
<form id="f" method="post" action="${esc(registrationUrl(state, org))}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button>Continue to GitHub</button></form>
<script nonce="${nonce}">document.getElementById("f").submit()</script>`;
  return {
    html: plainPage(nonce, "Register the GitHub App", body),
    headers: {
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`,
    },
  };
}

/** GET /auth/github-app/callback?code=&state=: converts the code and stores the keys. */
export async function finishRegistration(db: DatabaseSync, config: Config, deps: AppDeps, url: URL, nonce: string, login: string | null, isOperator: boolean): Promise<Res> {
  if (!login || !isOperator) return refuse(nonce, 403, "Only operators can register the GitHub App.");
  const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
  const row = db.prepare("DELETE FROM github_app_states WHERE state = ? RETURNING login, created_at").get(state) as { login: string; created_at: string } | undefined;
  if (!row || !code || row.login !== login || Date.now() - Date.parse(row.created_at) > STATE_TTL_MS) {
    return refuse(nonce, 400, "This registration link is unknown, used or expired. Start again from the GitHub App page.");
  }
  if (config.secrets.app || !config.secretsFile) return refuse(nonce, 409, "An app is already registered, or no secrets file is set.");
  try {
    const { name, ...app } = await convertManifest(code, deps);
    writeAppSecrets(config.secretsFile, app);
    config.secrets.app = app;
    audit(db, login, "github-app-register", app.slug, { id: app.id, name });
  } catch (e) {
    console.error(`github-app registration: ${e instanceof AppError ? e.message : "failed"}`);
    return refuse(nonce, 502, "GitHub did not return the app, or its keys could not be stored. Start again.");
  }
  return { redirect: "/admin/github-app" };
}
