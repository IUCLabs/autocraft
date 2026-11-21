// The judgement model: the model that prepares every question for a person (the prepare step). An operator picks it.
import type { DatabaseSync } from "node:sqlite";
import { setting } from "../settings-read.ts";

export const JUDGEMENT_MODELS = ["opus", "sonnet"] as const;
export type JudgementModel = (typeof JUDGEMENT_MODELS)[number];
const KEY = "judgement_model";

export function judgementModel(db: DatabaseSync): JudgementModel {
  const v = setting(db, KEY);
  return (JUDGEMENT_MODELS as readonly string[]).includes(v ?? "") ? (v as JudgementModel) : "opus";
}

export function setJudgementModel(db: DatabaseSync, model: string): void {
  if (!(JUDGEMENT_MODELS as readonly string[]).includes(model)) throw new Error(`not a judgement model: ${model}`);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(KEY, model);
}
