// SWAP AT MERGE: this is the settled-classification rule, implemented here until
// src/classify/ exports its own. Rule: Jev with top probability >= 0.9 settles the
// item; otherwise Haiku settles it when its type label equals Jev's; otherwise it is
// unsettled and gets no label. Flags (security, needs decision) are settled true when
// the settling Jev answer has them (Jev >= 0.9) or both classifiers have them.
import type { DatabaseSync } from "node:sqlite";

export type Settled = { type: string; security: boolean; needsDecision: boolean };
export type ClsRow = { classifier: string; run_id: string; at: string; type_label: string | null; flags: string | null; probs: string | null };

export const SETTLE_AT = 0.9;

const flagList = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const top = (s: string | null): number => {
  try {
    const t = (JSON.parse(s ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : 0;
  } catch {
    return 0;
  }
};

// rows: the classifications of one item in one run.
export function settleRows(rows: ClsRow[]): Settled | null {
  const jev = rows.find((r) => r.classifier === "jev");
  const haiku = rows.find((r) => r.classifier === "haiku");
  if (!jev?.type_label) return null;
  const jf = flagList(jev.flags);
  if (top(jev.probs) >= SETTLE_AT) return { type: jev.type_label, security: jf.includes("security"), needsDecision: jf.includes("needs decision") };
  if (haiku?.type_label !== jev.type_label) return null;
  const hf = flagList(haiku.flags);
  return {
    type: jev.type_label,
    security: jf.includes("security") && hf.includes("security"),
    needsDecision: jf.includes("needs decision") && hf.includes("needs decision"),
  };
}

// Without a run, each classifier's latest row for the item counts, from the latest Jev run.
export function settledLabel(db: DatabaseSync, repo: string, number: number, runId?: string): Settled | null {
  const all = db.prepare("SELECT classifier, run_id, at, type_label, flags, probs FROM main.classifications WHERE repo = ? AND number = ? ORDER BY at DESC")
    .all(repo, number) as ClsRow[];
  return settleRows(forRun(all, runId));
}

export function forRun(rows: ClsRow[], runId?: string): ClsRow[] {
  const id = runId ?? rows.find((r) => r.classifier === "jev")?.run_id;
  return id === undefined ? [] : rows.filter((r) => r.run_id === id);
}
