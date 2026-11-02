import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "./crypto.ts";
import { dbPath } from "../../db.ts";
import { defaultImageCacheDir } from "./images.ts";

export type Secrets = { githubClientId: string; githubClientSecret: string; sessionKey: string };

export type Config = {
  host: string;
  port: number;
  baseUrl: string | null;          // null only with dev auth, where every URL the server builds is relative
  dbPath: string;
  webDist: string;                 // the frontend's build output (web/dist)
  devAuth: boolean;
  devPermsFile: string | null;
  devTokenTtlMs: number | null;    // fake provider's access-token lifetime
  trustProxy: boolean;
  imageCacheDir: string | null;    // the image proxy's disk cache; null: none
  secrets: Secrets;
};

export const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

export class ConfigError extends Error {}

// Dev auth signs in as any login typed on a form, so it is for this machine
// only. Its default port differs from the real dashboard's, so a dev server
// never answers on the port a reverse proxy forwards to.
export const DEFAULT_LISTEN = "127.0.0.1:8993";
export const DEV_LISTEN = "127.0.0.1:8994";

export function parseListen(value: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(value);
  if (!m) throw new ConfigError(`CRAFT_AUTO_LISTEN must be host:port, got ${JSON.stringify(value)}`);
  const port = Number(m[3]);
  if (port > 65535) throw new ConfigError("CRAFT_AUTO_LISTEN: port out of range");
  return { host: m[1] ?? m[2]!, port };
}

export function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) === 6) return host === "::1" || /^::ffff:127\./i.test(host);
  return false;
}

/** True when a Host header names this machine (with or without a port). */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+))(?::\d{1,5})?$/.exec(hostHeader.trim());
  return !!m && isLoopback(m[1] ?? m[2]!);
}

export function readSecrets(path: string | undefined): Secrets {
  if (!path) throw new ConfigError("CRAFT_AUTO_SECRETS_FILE is not set");
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError("secrets file not found");
  }
  if (mode & 0o077) throw new ConfigError("secrets file is readable or writable by group or others; chmod 600 it");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError("secrets file is not valid JSON");
  }
  const get = (k: string, min = 1): string => {
    const v = raw?.[k];
    if (typeof v !== "string" || v.length < min) throw new ConfigError(`secrets file: ${k} is missing or too short`);
    return v;
  };
  return {
    githubClientId: get("github_client_id"),
    githubClientSecret: get("github_client_secret"),
    sessionKey: get("session_key", 32),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { host, port } = parseListen(env.CRAFT_AUTO_LISTEN ?? (env.CRAFT_AUTO_DEV_AUTH === "1" ? DEV_LISTEN : DEFAULT_LISTEN));
  const devAuth = env.CRAFT_AUTO_DEV_AUTH === "1";
  let secrets: Secrets;
  let baseUrl: string | null = null;
  if (devAuth) {
    if (!isLoopback(host)) throw new ConfigError("CRAFT_AUTO_DEV_AUTH=1 is allowed only on a loopback listen address");
    // Dev sessions don't survive a restart: the key lives only in this process.
    secrets = { githubClientId: "dev", githubClientSecret: "dev", sessionKey: randomToken() };
  } else {
    secrets = readSecrets(env.CRAFT_AUTO_SECRETS_FILE);
  }
  if (env.CRAFT_AUTO_BASE_URL) {
    let u: URL;
    try {
      u = new URL(env.CRAFT_AUTO_BASE_URL);
    } catch {
      throw new ConfigError("CRAFT_AUTO_BASE_URL is not a URL");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("CRAFT_AUTO_BASE_URL must be http(s)");
    if (devAuth && (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1"))) {
      throw new ConfigError("CRAFT_AUTO_DEV_AUTH=1 allows CRAFT_AUTO_BASE_URL only as an http://localhost or http://127.0.0.1 URL");
    }
    baseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    if (baseUrl !== u.origin) throw new ConfigError("CRAFT_AUTO_BASE_URL must not have a path");
  } else if (!devAuth) {
    throw new ConfigError("CRAFT_AUTO_BASE_URL is not set");
  }
  return {
    host, port, baseUrl, devAuth, secrets,
    dbPath: env.CRAFT_AUTO_DB ?? dbPath(),
    webDist: env.CRAFT_AUTO_WEB_DIST ? resolve(env.CRAFT_AUTO_WEB_DIST) : DEFAULT_WEB_DIST,
    devPermsFile: devAuth ? (env.CRAFT_AUTO_DEV_PERMS ?? null) : null,
    devTokenTtlMs: devAuth && env.CRAFT_AUTO_DEV_TOKEN_TTL ? Number(env.CRAFT_AUTO_DEV_TOKEN_TTL) * 1000 || null : null,
    trustProxy: env.CRAFT_AUTO_TRUST_PROXY === "1",
    imageCacheDir: env.CRAFT_AUTO_IMG_CACHE === "" ? null : defaultImageCacheDir(env),
  };
}
