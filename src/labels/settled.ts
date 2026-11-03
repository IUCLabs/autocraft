// The settled type label and flags of one item, as the Label stage and the Items
// browser need them. The rule itself lives in ../classify/settled.ts.
import type { DatabaseSync } from "node:sqlite";
import { needsDecisionOf, securityOf, settle } from "../classify/settled.ts";

export type Settled = { type: string; security: boolean; needsDecision: boolean };
export type ClsRow = { classifier: string; run_id: string; at: string; type_label: string | null; flags: string | null; probs: string | null };

const flagList = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const topOf = (s: string | null): number | null => {
  try {
    const t = (JSON.parse(s ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
};

// rows: the classifications of one item in one run.
export function settleRows(rows: ClsRow[]): Settled | null {
  const jev = rows.find((r) => r.classifier === "jev");
  const haiku = rows.find((r) => r.classifier === "haiku");
  if (!jev?.type_label) return null;
  const s = settle(
    { label: jev.type_label, flags: flagList(jev.flags), top: topOf(jev.probs), nd: needsDecisionOf(jev.probs), sec: securityOf(jev.probs) },
    haiku?.type_label ? { label: haiku.type_label, flags: flagList(haiku.flags) } : null,
  );
  if (s.status !== "settled" || s.label === null) return null;
  return { type: s.label, security: s.flags.includes("security"), needsDecision: s.flags.includes("needs decision") };
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
