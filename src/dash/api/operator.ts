// Operator-only releases on the Item page: review again, verify again, try the fix again.
// They change local tables only; the pipeline picks the item up on its next pass.
import type { DatabaseSync } from "node:sqlite";
import { ActionError, batchAgain, fixAgain, reviewAgain, verifyAgain } from "../../operator-actions.ts";
import { cancelPreapproval } from "../../preapproval/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { needVisible } from "./visible.ts";

async function run(db: DatabaseSync, req: Req, f: (db: DatabaseSync, by: string, repo: string, n: number) => void): Promise<{ ok: true }> {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators can release an item");
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  try {
    f(db, req.user.login, repo, n);
  } catch (e) {
    if (e instanceof ActionError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return { ok: true };
}

/** Operator: cancels the PR's pre-approved merge while it is before the merge queue's merge. */
export async function cancelItemPreapproval(db: DatabaseSync, req: Req) {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators can cancel a pre-approved merge");
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  try {
    return await cancelPreapproval(db, req.user.login, repo, n);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
}

export const reviewItemAgain = (db: DatabaseSync, req: Req) => run(db, req, reviewAgain);
export const verifyItemAgain = (db: DatabaseSync, req: Req) => run(db, req, verifyAgain);
export const fixItemAgain = (db: DatabaseSync, req: Req) => run(db, req, fixAgain);
export const batchItemAgain = (db: DatabaseSync, req: Req) => run(db, req, batchAgain);
