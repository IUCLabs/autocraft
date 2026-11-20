// The signed-in user's Task Runners (session routes): their list, approving or denying a runner's device login
// (src/remote/device-login.ts), and removing one. Maintainers and operators approve and deny; anyone lists and removes
// their own. Removing deletes the credential: a lease it holds goes back to the queue at its next heartbeat (liveLease).
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../audit.ts";
import { revokeToken } from "../mcp/tokens.ts";
import { HttpError, RateLimiter } from "../server/util.ts";
import type { Req } from "../types.ts";
import { approveLogin, denyLogin, normalizeCode, pendingLogin } from "../../remote/device-login.ts";
import { listHelpers } from "../../remote/helpers.ts";
import { inferenceMode } from "../../remote/mode.ts";
import type { Machine, PendingRunnerLogin, RunnersReply } from "../../remote/protocol.ts";

/** Lookups of a user code that found no waiting login, per login: guessing codes is slow. */
const failedLookups = new RateLimiter(10, 10 * 60_000);

const body = (req: Req): Record<string, unknown> => {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
};

const staffOnly = (req: Req): void => {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers cannot add Task Runners");
};

/** Runs `find` on a user code; a code that finds nothing counts against the login's lookups. */
function byCode<T>(req: Req, raw: unknown, find: (code: string) => T | null): T {
  const key = req.user.login.toLowerCase();
  if (!failedLookups.allow(key)) throw new HttpError(429, "too many codes that matched no login; wait a few minutes");
  const code = normalizeCode(raw);
  let found: T | null;
  try {
    found = code ? find(code) : null;
  } catch (e) {
    failedLookups.refund(key);
    throw e;
  }
  if (found === null) throw new HttpError(404, "no Task Runner login is waiting with that code; it may have expired");
  failedLookups.refund(key);
  return found;
}

export function list(db: DatabaseSync, req: Req): RunnersReply {
  const helpers = listHelpers(db, req.user.login);
  const extra = new Map((db.prepare(`SELECT t.id, t.machine, t.created_at, t.expires_at, h.helper_version FROM mcp_tokens t LEFT JOIN remote_helpers h ON h.token_id = t.id
      WHERE t.login = ? AND t.kind = 'runner'`).all(req.user.login) as { id: number; machine: string | null; created_at: string; expires_at: string; helper_version: string | null }[])
    .map((r) => [Number(r.id), r]));
  return {
    runners: helpers.flatMap((h) => {
      const x = extra.get(h.tokenId);
      return x ? [{ ...h, machine: x.machine ? JSON.parse(x.machine) as Machine : null, helperVersion: x.helper_version, createdAt: x.created_at, expiresAt: x.expires_at }] : [];
    }),
  };
}

export function pending(db: DatabaseSync, req: Req): PendingRunnerLogin {
  staffOnly(req);
  return byCode(req, req.query.get("code"), (code) => pendingLogin(db, code, req.ip ?? ""));
}

export function approve(db: DatabaseSync, req: Req): RunnersReply {
  staffOnly(req);
  if (inferenceMode(db) !== "user-local") throw new HttpError(409, "the instance runs model calls on its own accounts; Task Runners take none now");
  const b = body(req);
  if (b.otherMachine !== undefined && typeof b.otherMachine !== "boolean") throw new HttpError(400, "otherMachine must be true or false");
  const out = byCode(req, b.code, (code) => approveLogin(db, req.user.login, code, b.label, req.ip ?? "", b.otherMachine === true));
  audit(db, req.user.login, "runner-approve", req.user.login, { id: out.row.id, label: out.row.label ?? undefined, machine: out.machine ?? undefined, ip: out.ip ?? undefined });
  return list(db, req);
}

export function deny(db: DatabaseSync, req: Req): { ok: true } {
  staffOnly(req);
  const out = byCode(req, body(req).code, (code) => denyLogin(db, req.user.login, code));
  audit(db, req.user.login, "runner-deny", req.user.login, { label: out.label ?? undefined, machine: out.machine ?? undefined, ip: out.ip ?? undefined });
  return { ok: true };
}

export function revoke(db: DatabaseSync, req: Req): RunnersReply {
  const id = body(req).id;
  if (!Number.isInteger(id)) throw new HttpError(400, "id must be a Task Runner id");
  if (!revokeToken(db, req.user.login, id as number, "runner")) throw new HttpError(404, "you have no such Task Runner");
  audit(db, req.user.login, "runner-revoke", req.user.login, { id });
  return list(db, req);
}
