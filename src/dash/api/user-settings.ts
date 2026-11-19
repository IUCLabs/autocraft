// The signed-in user's own settings (GET and PUT /api/me/settings) and their user-local helpers (GET /api/remote/helpers).
// Maintainers and operators set their own settings; a viewer writes nothing.
import type { DatabaseSync } from "node:sqlite";
import { listHelpers } from "../../remote/helpers.ts";
import type { HelperInfo, UserSettings } from "../../remote/protocol.ts";
import { parseReserve, setUserReserve, userReserve } from "../../remote/reserve.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

export const settings = (db: DatabaseSync, req: Req): UserSettings => ({ reserve: userReserve(db, req.user.login) });

export function setSettings(db: DatabaseSync, req: Req): UserSettings {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers have no settings to change");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a UserSettings object");
  for (const k of Object.keys(b)) if (k !== "reserve") throw new HttpError(400, `unknown setting ${k}`);
  let reserve;
  try { reserve = parseReserve((b as Record<string, unknown>).reserve); } catch (e) { throw new HttpError(400, (e as Error).message); }
  return { reserve: setUserReserve(db, req.user.login, reserve) };
}

export const helpers = (db: DatabaseSync, req: Req): { helpers: HelperInfo[] } => ({ helpers: listHelpers(db, req.user.login) });
