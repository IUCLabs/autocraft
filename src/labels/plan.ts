// Which labels each open item should get. Reads the mirror and classifications only.
import type { DatabaseSync } from "node:sqlite";
import { forRun, settleRows, type ClsRow } from "./settled.ts";
import { scopeAnswers } from "../review/candidates.ts";
import { isTypeLabel, sameLabel } from "./set.ts";

/** The type label an operator's `plugin` scope answer asks for. */
export const PLUGIN_LABEL = "plugin candidate";

export type PlanStatus = "add" | "already" | "unsettled" | "conflict";
export type PlanRow = {
  number: number; kind: string; url: string; status: PlanStatus;
  settled: string; existing: string[]; add: string[]; note: string;
};
export type PlanCounts = { toAdd: number; already: number; unsettled: number; conflicts: number };

export function planLabels(db: DatabaseSync, repo: string, runId?: string): PlanRow[] {
  const items = db.prepare("SELECT number, kind, url, labels FROM main.items WHERE repo = ? AND state = 'OPEN' ORDER BY number").all(repo) as
    { number: number; kind: string; url: string | null; labels: string | null }[];
  const byItem = new Map<number, ClsRow[]>();
  const cls = db.prepare(`SELECT number, classifier, run_id, at, type_label, flags, probs FROM main.classifications WHERE repo = ?
    ${runId ? "AND run_id = ?" : ""} ORDER BY at DESC`).all(...(runId ? [repo, runId] : [repo])) as (ClsRow & { number: number })[];
  for (const c of cls) (byItem.get(c.number) ?? byItem.set(c.number, []).get(c.number)!).push(c);

  const answers = scopeAnswers(db, true);
  return items.map((it) => {
    let existing: string[] = [];
    try {
      existing = (JSON.parse(it.labels ?? "[]") as unknown[]).map(String);
    } catch { /* unreadable labels count as none */ }
    const row = { number: it.number, kind: it.kind, url: it.url ?? "", settled: "", existing, add: [] as string[], note: "" };
    const settled = settleRows(forRun(byItem.get(it.number) ?? [], runId));
    // An operator's plugin answer decides the type, also where the classifiers disagreed about it.
    const plugin = answers.get(`${repo}#${it.number}`) === "plugin";
    const s = plugin ? { type: PLUGIN_LABEL, security: settled?.security ?? false, needsDecision: false } : settled;
    if (!s) return { ...row, status: "unsettled" as const };
    row.settled = s.type;
    const other = existing.filter((l) => isTypeLabel(l) && !sameLabel(l, s.type));
    if (other.length) return { ...row, status: "conflict" as const, note: `has ${other.join(", ")}` };
    const want = [s.type, ...(s.security ? ["security"] : []), ...(s.needsDecision ? ["needs decision"] : [])];
    const add = want.filter((w) => !existing.some((e) => sameLabel(e, w)));
    return { ...row, add, status: add.length ? ("add" as const) : ("already" as const) };
  });
}

export function countPlan(rows: PlanRow[]): PlanCounts {
  const n = (s: PlanStatus) => rows.filter((r) => r.status === s).length;
  return { toAdd: n("add"), already: n("already"), unsettled: n("unsettled"), conflicts: n("conflict") };
}

const csvCell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export function planCsv(repo: string, rows: PlanRow[]): string {
  const lines = [["repo", "number", "kind", "status", "settled_type", "existing_labels", "labels_to_add", "note", "url"].join(",")];
  for (const r of rows) lines.push([repo, r.number, r.kind, r.status, r.settled, r.existing.join("|"), r.add.join("|"), r.note, r.url].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
