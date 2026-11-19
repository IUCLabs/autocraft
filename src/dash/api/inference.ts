// The inference mode and the accepted models per tier of the user-local mode (src/remote/mode.ts). Operators only; changes are audited.
import type { DatabaseSync } from "node:sqlite";
import { acceptedModels, inferenceMode, isInferenceMode, setAcceptedModels, setInferenceMode, type InferenceMode } from "../../remote/mode.ts";
import type { Tier } from "../../remote/protocol.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

export type InferenceSettings = { mode: InferenceMode; models: Record<Tier, string[]> };

export const get = (db: DatabaseSync): InferenceSettings => ({ mode: inferenceMode(db), models: acceptedModels(db) });

/** Body `{mode?, models?}`: either or both. */
export function put(db: DatabaseSync, req: Req): InferenceSettings {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change the inference mode");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  const { mode, models } = b as { mode?: unknown; models?: unknown };
  if (mode !== undefined && !isInferenceMode(mode)) throw new HttpError(400, "mode must be server or user-local");
  if (models !== undefined) {
    try { setAcceptedModels(db, models, req.user.login); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (mode !== undefined) setInferenceMode(db, mode, req.user.login);
  return get(db);
}
