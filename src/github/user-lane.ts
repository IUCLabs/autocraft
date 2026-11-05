// The user lane: a GitHub write that carries out an operator's answer is made as that operator, with the operator's
// GitHub App user token (src/github/vault.ts), never as the box account or the app. Only repos whose `repo_identity`
// is `app` use it; under `legacy` nothing here runs and the box account writes as before.
//
// A decision whose operator has no usable token, or no write access on the repo, does not fail: it waits
// (`decisions.exec_state` waiting-token / waiting-permission, with a plain reason) and runs again after that operator
// signs in or authorizes again, or when someone presses Retry.
import type { DatabaseSync } from "node:sqlite";
import { AppError, call, GITHUB_API } from "./app.ts";
import { identityOfDecision, repoIdentity } from "./identity.ts";
import { openVault, type Vault } from "./vault.ts";
import { withIdentityEnv } from "./install-token.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { Client, type Querier } from "../mirror.ts";
import { slugOf } from "../owners.ts";

export type ExecState = "pending" | "waiting-token" | "waiting-permission" | "done" | "failed";
export const WAITING: readonly ExecState[] = ["waiting-token", "waiting-permission"];

export const SIGN_IN_REASON = "Sign in to let AutoCraft finish this as you";
export const noWriteReason = (repo: string): string => `You have no write access to ${slugOf(repo)}`;

/** Sets the state shown on the decision. Writes nothing when it is already that, so the planner is not woken for nothing. */
export function setExecState(db: DatabaseSync, id: string, state: ExecState, reason: string | null = null): void {
  db.prepare("UPDATE main.decisions SET exec_state = ?, exec_reason = ? WHERE id = ? AND (exec_state IS NOT ? OR exec_reason IS NOT ?)").run(state, reason, id, state, reason);
}

/** Decisions the pipeline applied are done. */
export function markExecDone(db: DatabaseSync): void {
  db.prepare("UPDATE main.decisions SET exec_state = 'done', exec_reason = NULL WHERE applied_at IS NOT NULL AND exec_state IS NOT NULL AND exec_state <> 'done'").run();
}

/**
 * Sets a decision answered under an app repo to pending, or to waiting-token when its operator has no stored token set
 * (a database read only: the network checks happen when the write runs).
 */
export function initExecState(db: DatabaseSync, id: string): void {
  const d = db.prepare("SELECT repo, answered_by FROM main.decisions WHERE id = ? AND answer IS NOT NULL AND applied_at IS NULL").get(id) as { repo: string | null; answered_by: string | null } | undefined;
  if (!d?.repo || !d.answered_by || repoIdentity(db, d.repo) !== "app") return;
  const has = db.prepare("SELECT 1 FROM main.user_tokens WHERE login = ? AND status = 'ok'").get(d.answered_by);
  if (has) setExecState(db, id, "pending");
  else setExecState(db, id, "waiting-token", SIGN_IN_REASON);
}

/** Puts the waiting (and, for one decision, failed) decisions back to pending so the stages take them up again. Returns how many changed. */
export function retryWaiting(db: DatabaseSync, login?: string): number {
  const r = db.prepare(`UPDATE main.decisions SET exec_state = 'pending', exec_reason = NULL
    WHERE exec_state IN ('waiting-token', 'waiting-permission') AND applied_at IS NULL AND answer IS NOT NULL AND (? IS NULL OR answered_by = ? COLLATE NOCASE)`).run(login ?? null, login ?? null);
  return Number(r.changes);
}

export function retryDecision(db: DatabaseSync, id: string): boolean {
  const r = db.prepare(`UPDATE main.decisions SET exec_state = 'pending', exec_reason = NULL
    WHERE id = ? AND exec_state IN ('waiting-token', 'waiting-permission', 'failed') AND applied_at IS NULL AND answer IS NOT NULL`).run(id);
  return Number(r.changes) > 0;
}

// ---- the lane ----------------------------------------------------------------------

/** What a write made as a user needs: the user's name for the audit row, and the transports that carry the token. */
export type Lane = {
  login: string;
  /** The whole environment of the child: the user's token as GH_TOKEN, and none of the box's own tokens. */
  env: Record<string, string>;
  querier: Querier;
  exec: Exec;
};

export type Permission = "write" | "none" | "rejected";

export type LaneDeps = {
  vault: Pick<Vault, "userToken"> | null;
  /** The user's permission on the repo, read with the user's token. Throws when GitHub cannot answer. */
  permission?: (token: string, repo: string) => Promise<Permission>;
  /** Tests replace the transports. */
  transports?: (env: Record<string, string>) => { querier: Querier; exec: Exec };
};

export type Waiting = { state: "waiting-token" | "waiting-permission"; reason: string };
/** `transient`: GitHub or the token refresh could not answer now; nothing is recorded and the next run tries again. */
export type LaneResult = { lane: Lane } | Waiting | { transient: string };

/** The repo's permission for the token, from GitHub's `permissions` field of the repository. */
export async function githubPermission(token: string, repo: string, apiBase = GITHUB_API): Promise<Permission> {
  try {
    const r = (await call(apiBase, `/repos/${slugOf(repo)}`, token)) as { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
    const p = r.permissions;
    return p?.push || p?.maintain || p?.admin ? "write" : "none";
  } catch (e) {
    if (e instanceof AppError) {
      if (e.status === 401) return "rejected";
      if (e.status === 403 || e.status === 404) return "none";
    }
    throw e;
  }
}

const memo = new WeakMap<DatabaseSync, LaneDeps>();
/** The vault of the secrets file (null without a registered app) and GitHub's own permission read. */
export function defaultLaneDeps(db: DatabaseSync): LaneDeps {
  let d = memo.get(db);
  if (!d) {
    let vault: Vault | null = null;
    try { vault = openVault(db); } catch { /* no readable secrets: no token can be had */ }
    d = { vault };
    memo.set(db, d);
  }
  return d;
}

export function laneOf(deps: LaneDeps, login: string, token: string): Lane {
  const env = withIdentityEnv({ kind: "app", token });
  const t = deps.transports?.(env);
  return {
    login, env,
    querier: t?.querier ?? new Client(1000, env),
    exec: t?.exec ?? ((cmd, args, opts) => defaultExec(cmd, args, { ...opts, env: { ...env, ...opts?.env }, replaceEnv: true })),
  };
}

/** A usable token for the login and write access on every repo, or the reason it waits. */
export async function resolveLane(deps: LaneDeps, login: string, repos: string[]): Promise<LaneResult> {
  if (!deps.vault) return { state: "waiting-token", reason: SIGN_IN_REASON };
  const permission = deps.permission ?? githubPermission;
  let t = await deps.vault.userToken(login);
  for (let attempt = 0; ; attempt++) {
    if (!t.ok) return t.needsSignIn ? { state: "waiting-token", reason: SIGN_IN_REASON } : { transient: "the user token could not be refreshed now" };
    let rejected = false;
    for (const repo of repos) {
      let p: Permission;
      try {
        p = await permission(t.access, repo);
      } catch (e) {
        return { transient: String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200) };
      }
      if (p === "none") return { state: "waiting-permission", reason: noWriteReason(repo) };
      if (p === "rejected") { rejected = true; break; }
    }
    if (!rejected) return { lane: laneOf(deps, login, t.access) };
    // GitHub refused the access token as expired or revoked: one refresh, then the person has to sign in again.
    if (attempt > 0) return { state: "waiting-token", reason: SIGN_IN_REASON };
    t = await deps.vault.userToken(login, t.access);
  }
}

/**
 * The lane for the operator who answered `decisionId`, or null when every repo is on the box account (`legacy`): the
 * caller then uses its own transports and nothing changes. Only the repos on `app` are checked.
 */
export async function laneForDecision(db: DatabaseSync, deps: LaneDeps | undefined, decisionId: string, repos: string[]): Promise<LaneResult | null> {
  const app = repos.filter((r) => repoIdentity(db, r) === "app");
  if (!app.length) return null;
  // A decision that waits stays put until its operator signs in or someone retries it: no network call per run.
  const row = db.prepare("SELECT exec_state, exec_reason FROM main.decisions WHERE id = ?").get(decisionId) as { exec_state: string | null; exec_reason: string | null } | undefined;
  if (row && (row.exec_state === "waiting-token" || row.exec_state === "waiting-permission")) return { state: row.exec_state, reason: row.exec_reason ?? SIGN_IN_REASON };
  const who = identityOfDecision(db, decisionId);
  if (who === "app") return { state: "waiting-token", reason: SIGN_IN_REASON };
  return resolveLane(deps ?? defaultLaneDeps(db), who.slice("user:".length), app);
}

/** The lane for an operator acting right now (a conversation card), or null when every repo is on the box account. */
export async function laneForOperator(db: DatabaseSync, deps: LaneDeps | undefined, login: string, repos: string[]): Promise<LaneResult | null> {
  const app = repos.filter((r) => repoIdentity(db, r) === "app");
  return app.length ? resolveLane(deps ?? defaultLaneDeps(db), login, app) : null;
}

/** What GitHub says when the user's token may not do the write: 401, 403 or 404, or an integration without access. */
export function authFailure(message: string): "waiting-token" | "waiting-permission" | null {
  if (/\b401\b|bad credentials/i.test(message)) return "waiting-token";
  if (/\b(403|404)\b|not accessible by integration|must have (admin|write)|resource not accessible|could not resolve to a repository/i.test(message)) return "waiting-permission";
  return null;
}
