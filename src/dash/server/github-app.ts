// The operator's GitHub App registration: the status the admin page reads, the
// start page that posts the manifest to GitHub, and the callback that turns the
// returned code into the app's keys. The keys go to the secrets file only; no
// response, log line or audit row carries the private key or client secret.
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { GithubAppStatus } from "../../../web/src/api/types.ts";
import { audit } from "../audit.ts";
import type { Session } from "./sessions.ts";
import { AppError, APP_NAME, appManifest, appName, convertManifest, installUrl, installations, installationRepos, registrationUrl, settingsUrl, transferUrl, type AppDeps } from "../../github/app.ts";
import type { Res, Route } from "../types.ts";
import { envVar } from "../../env.ts";
import { checkSecretsWritable, writeAppSecrets, type Config } from "./config.ts";
import { randomToken } from "./crypto.ts";
import { esc, plainPage } from "./util.ts";

export const DEFAULT_APP_NAME = "AutoCraft";
const STATE_TTL_MS = 3_600_000;   // GitHub's one-time code lives an hour
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const publicBase = (config: Config, req: IncomingMessage): string => config.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;

export function githubAppRoutes(config: Config, deps: AppDeps): Route[] {
  return [{
    method: "GET", pattern: "/api/admin/github-app", operator: true,
    handler: async (_db, r): Promise<Res> => ({ json: { ...(await githubAppStatus(config, deps)), csrf: r.csrf } }),
  }];
}

export async function githubAppStatus(config: Config, deps: AppDeps): Promise<Omit<GithubAppStatus, "csrf">> {
  const app = config.secrets.app;
  const status: Omit<GithubAppStatus, "csrf"> = {
    configured: !!app, loginMode: config.loginApp, canRegister: !!config.secretsFile,
    defaultName: envVar("GITHUB_APP_NAME") ?? DEFAULT_APP_NAME, app: null, installations: [], error: null,
  };
  if (!app) return status;
  status.app = { id: app.id, slug: app.slug, name: null, installUrl: installUrl(app.slug), transferUrl: transferUrl(app.slug, app.owner) };
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

/**
 * POST /auth/github-app/start (form fields name, org; the caller has checked
 * the csrf field): a page that posts the manifest to GitHub. Operators only.
 * `org` is the organization that will own the app, empty for the signed-in
 * user's account.
 */
export function startRegistration(db: DatabaseSync, config: Config, req: IncomingMessage, form: URLSearchParams, nonce: string, session: Session): Res {
  if (session.role !== "operator") return refuse(nonce, 403, "Only operators can register the GitHub App.");
  if (config.secrets.app) return refuse(nonce, 409, "An app is already registered.");
  if (!config.secretsFile) return refuse(nonce, 409, "AUTOCRAFT_SECRETS_FILE is not set, so there is nowhere to keep the app's keys.");
  const name = (form.get("name") ?? "").trim() || envVar("GITHUB_APP_NAME") || DEFAULT_APP_NAME;
  const org = (form.get("org") ?? "").trim() || null;
  if (!APP_NAME.test(name)) return refuse(nonce, 400, "The app name must be 1 to 34 letters, digits, spaces, dashes or underscores.");
  if (org && !ORG.test(org)) return refuse(nonce, 400, "That is not a GitHub organization name.");
  try {
    checkSecretsWritable(config.secretsFile);
  } catch (e) {
    return refuse(nonce, 409, `The secrets file cannot be updated (${errorCode(e)}), so the app's keys could not be kept.`);
  }
  const state = randomToken(24);
  db.prepare("DELETE FROM github_app_states WHERE created_at <= ?").run(new Date(Date.now() - STATE_TTL_MS).toISOString());
  db.prepare("INSERT INTO github_app_states (state, login, session_hash, created_at) VALUES (?, ?, ?, ?)").run(state, session.login, session.idHash, new Date().toISOString());
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

const errorCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.name : "error");

// Registrations being converted right now: the code is one-time, so a second
// callback for the same config must not start while the first is in flight.
const converting = new WeakSet<Config>();

/** GET /auth/github-app/callback?code=&state=: converts the code and stores the keys. */
export async function finishRegistration(db: DatabaseSync, config: Config, deps: AppDeps, url: URL, nonce: string, session: Session): Promise<Res> {
  if (session.role !== "operator") return refuse(nonce, 403, "Only operators can register the GitHub App.");
  const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
  const stale = "This registration link is unknown, used or expired. Start again from the GitHub App page.";
  // The session and login are checked before the state row is consumed, so another session cannot burn it.
  const found = db.prepare("SELECT login, session_hash, created_at FROM github_app_states WHERE state = ?").get(state) as { login: string; session_hash: string; created_at: string } | undefined;
  if (!found || !code || found.login !== session.login || found.session_hash !== session.idHash || Date.now() - Date.parse(found.created_at) > STATE_TTL_MS) return refuse(nonce, 400, stale);
  if (config.secrets.app || !config.secretsFile || converting.has(config)) return refuse(nonce, 409, "An app is already registered, or no secrets file is set.");
  // Prove the file can take the keys before the state is consumed: GitHub's code works once, and a lost PEM leaves an app nobody holds keys for.
  // GitHub has already created the app by now; a failed probe keeps the state and the unconverted code, so a reload recovers.
  try {
    checkSecretsWritable(config.secretsFile);
  } catch (e) {
    console.error(`github-app registration: secrets file not writable (${errorCode(e)})`);
    return refuse(nonce, 409, `The app exists on GitHub, but the secrets file cannot be updated (${errorCode(e)}). Fix the file and reload this page within an hour.`);
  }
  if (db.prepare("DELETE FROM github_app_states WHERE state = ?").run(state).changes !== 1) return refuse(nonce, 400, stale);
  converting.add(config);
  try {
    let converted: Awaited<ReturnType<typeof convertManifest>>;
    try {
      converted = await convertManifest(code, deps);
    } catch (e) {
      console.error(`github-app registration: ${e instanceof AppError ? e.message : "failed"}`);
      return refuse(nonce, 502, "GitHub did not return the app. Start again.");
    }
    const { name, ...app } = converted;
    try {
      if (config.secrets.app) throw Object.assign(new Error("another app was registered meanwhile"), { code: "EEXIST" });
      writeAppSecrets(config.secretsFile, app);
    } catch (e) {
      console.error(`github-app registration: app ${app.slug} exists on GitHub but its keys were not stored (${errorCode(e)})`);
      audit(db, session.login, "github-app-register-failed", app.slug, { id: app.id, code: errorCode(e) });
      const link = settingsUrl(app.slug, app.owner);
      return {
        status: 500,
        html: plainPage(nonce, "GitHub App", `<p>GitHub created the app <code>${esc(app.slug)}</code>, but its keys could not be stored (${esc(errorCode(e))}). Delete the app on GitHub, fix the secrets file and start again.</p><p><a href="${esc(link)}">${esc(link)}</a></p><p><a href="/admin/github-app">GitHub App</a></p>`),
      };
    }
    config.secrets.app = app;
    audit(db, session.login, "github-app-register", app.slug, { id: app.id, name, owner: app.owner?.login ?? null });
  } finally {
    converting.delete(config);
  }
  return { redirect: "/admin/github-app" };
}
