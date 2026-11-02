// Claude accounts, agent runs and rates over JSON. Everyone signed in reads;
// only operators change an account (audited as `account-change`). The box
// config's directories never reach a response: accounts are returned by id and label.
import type { DatabaseSync } from "node:sqlite";
import type { AgentRunFilter, AgentRunState, ClaudeAccount } from "../../../web/src/api/types.ts";
import { AccountError, listAccounts, updateAccount } from "../../agents/accounts.ts";
import { getRun, listRuns, rates as ratesOf, RunQueryError } from "../../agents/runs.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccountError || e instanceof RunQueryError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

/** Operators see every account; others only the enabled ones. */
export const accounts = (db: DatabaseSync, req: Req): ClaudeAccount[] =>
  listAccounts(db).filter((a) => a.enabled || req.user.role === "operator");

export const putAccount = (db: DatabaseSync, req: Req) => wrap(() => updateAccount(db, req.params.id, req.json, req.user.login));

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,6}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const list = (db: DatabaseSync, req: Req) => wrap(() => {
  const q = (k: string) => req.query.get(k) || undefined;
  const f: AgentRunFilter = {
    state: q("state") as AgentRunState | "recent" | undefined, step: q("step"), account: q("account"), repo: q("repo"), cursor: q("cursor"), limit: intParam(req, "limit"),
  };
  return listRuns(db, f);
});

export const detail = (db: DatabaseSync, req: Req) => wrap(() => {
  if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new HttpError(400, "not a run id");
  return getRun(db, Number(req.params.id));
});

export const rates = (db: DatabaseSync, req: Req) => wrap(() => ratesOf(db, req.query.get("window") ?? "24h"));
