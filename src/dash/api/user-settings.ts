// The signed-in user's own settings (GET and PUT /api/me/settings) and their user-local helpers (GET /api/remote/helpers).
// Maintainers and operators set their own settings; a viewer writes nothing.
import type { DatabaseSync } from "node:sqlite";
import { pipelineRepos } from "../../pilot.ts";
import { listHelpers } from "../../remote/helpers.ts";
import { parseRepos, setUserRepos, userRepos } from "../../remote/my-repos.ts";
import type { HelperInfo, UserSettingsReply } from "../../remote/protocol.ts";
import { parseReserve, setUserReserve, userReserve } from "../../remote/reserve.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

/** Repos with the pipeline on where the user has write permission, the permission a claim requires. */
async function repoChoices(db: DatabaseSync, req: Req): Promise<string[]> {
  const repos = [...pipelineRepos(db)].sort();
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

export const settings = async (db: DatabaseSync, req: Req): Promise<UserSettingsReply> =>
  ({ reserve: userReserve(db, req.user.login), repos: userRepos(db, req.user.login), maxCalls: null, repoChoices: await repoChoices(db, req) });

export async function setSettings(db: DatabaseSync, req: Req): Promise<UserSettingsReply> {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers have no settings to change");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a UserSettings object");
  const body = b as Record<string, unknown>;
  for (const k of Object.keys(body)) if (k !== "reserve" && k !== "repos") throw new HttpError(400, `unknown setting ${k}`);
  if (body.reserve === undefined && body.repos === undefined) throw new HttpError(400, "send reserve, repos or both");
  let reserve, repos;
  try {
    if (body.reserve !== undefined) reserve = parseReserve(body.reserve);
    if (body.repos !== undefined) repos = parseRepos(db, body.repos);
  } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (reserve) setUserReserve(db, req.user.login, reserve);
  if (repos) setUserRepos(db, req.user.login, repos);
  return settings(db, req);
}

export const helpers = (db: DatabaseSync, req: Req): { helpers: HelperInfo[] } => ({ helpers: listHelpers(db, req.user.login) });
