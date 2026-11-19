// The instance's inference mode. `server`: Claude model calls run on this host with the registered accounts.
// `user-local`: they are queued as remote calls that maintainers' helpers claim, run on their own machines and
// submit (src/remote/calls.ts). Jev calls and embeddings run on this host in both modes.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import type { Tier } from "./protocol.ts";

export const INFERENCE_MODES = ["server", "user-local"] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];
export const INFERENCE_KEY = "inference";

export const isInferenceMode = (v: unknown): v is InferenceMode => typeof v === "string" && (INFERENCE_MODES as readonly string[]).includes(v);

export const inferenceMode = (db: DatabaseSync): InferenceMode =>
  (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(INFERENCE_KEY) as { value: string } | undefined)?.value === "user-local" ? "user-local" : "server";

/** Sets the mode and audits the change as `by`; false when it already was `mode`. */
export function setInferenceMode(db: DatabaseSync, mode: InferenceMode, by: string): boolean {
  if (inferenceMode(db) === mode) return false;
  if (mode === "server") db.prepare("DELETE FROM main.settings WHERE key = ?").run(INFERENCE_KEY);
  else db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(INFERENCE_KEY, mode);
  audit(db, by, "inference", INFERENCE_KEY, { value: mode });
  return true;
}

/** The tier a model name of the prompt registry belongs to. */
export function tierOfModel(model: string): Tier {
  if (/opus/i.test(model)) return "top";
  if (/sonnet/i.test(model)) return "mid";
  if (/haiku/i.test(model)) return "small";
  throw new Error(`no tier for model ${model}`);
}

export const TIERS: readonly Tier[] = ["top", "mid", "small"];
export const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

export const REMOTE_MODELS_KEY = "remote_models";
/** Codex's top model: a placeholder family, not verified against Codex's model ids; operators correct it in the setting. */
export const CODEX_TOP_PLACEHOLDER = "astra";
/** The model families each tier accepts unless the `remote_models` setting says otherwise. */
export const DEFAULT_REMOTE_MODELS: Record<Tier, string[]> = { top: ["opus", CODEX_TOP_PLACEHOLDER], mid: ["sonnet"], small: ["haiku"] };
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,39}$/;

export function acceptedModels(db: DatabaseSync): Record<Tier, string[]> {
  const raw = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(REMOTE_MODELS_KEY) as { value: string } | undefined)?.value;
  if (!raw) return DEFAULT_REMOTE_MODELS;
  try { return { ...DEFAULT_REMOTE_MODELS, ...checkModels(JSON.parse(raw)) }; } catch { return DEFAULT_REMOTE_MODELS; }
}

/** `{tier: [family, ...]}` for some or all tiers, checked; throws with the reason. */
function checkModels(v: unknown): Partial<Record<Tier, string[]>> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("models must map a tier to a list of model families");
  const out: Partial<Record<Tier, string[]>> = {};
  for (const [t, list] of Object.entries(v as Record<string, unknown>)) {
    if (!isTier(t)) throw new Error(`unknown tier ${t}`);
    if (!Array.isArray(list) || !list.length || list.length > 10 || !list.every((f) => typeof f === "string" && FAMILY.test(f))) throw new Error(`tier ${t}: 1 to 10 lowercase model families, such as opus`);
    out[t] = [...new Set(list as string[])];
  }
  return out;
}

/** Replaces the accepted families of the tiers given (audited as `by`); returns the whole table. */
export function setAcceptedModels(db: DatabaseSync, raw: unknown, by: string): Record<Tier, string[]> {
  const next = { ...acceptedModels(db), ...checkModels(raw) };
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(REMOTE_MODELS_KEY, JSON.stringify(next));
  audit(db, by, "remote-models", REMOTE_MODELS_KEY, next);
  return next;
}

/** The family of `families` that a model alias or id belongs to (claude-opus-4-5 and opus are both opus), or null. */
export function familyOf(model: string, families: readonly string[]): string | null {
  const m = model.toLowerCase();
  return families.find((f) => new RegExp(`(^|[^a-z0-9])${f.replace(/[.-]/g, "\\$&")}([^a-z0-9]|$)`).test(m)) ?? null;
}
