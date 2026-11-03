// The comments the Act step posts for a duplicate group, written into dupe_group_items.comment
// when the decision is asked and again when an answer changes who is kept. They come from the
// roles and the stored comparison points only (no model call), so the operator approves the exact words.
import type { DatabaseSync } from "node:sqlite";
import { dupeGroupCloseComment, dupeGroupDetailsComment } from "../act/templates.ts";

type Row = { number: number; kind: string; role: string; target: number | null; detail: string | null };

const points = (detail: string | null, key: "carry" | "adds"): string[] => {
  try {
    const v = (JSON.parse(detail ?? "null") as Record<string, unknown> | null)?.[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** The comment per member number: closing members get the close comment, the kept issue of a group with closed reports the details comment. */
export function groupTexts(rows: Row[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of rows) {
    if (r.role === "close" && r.target !== null) out.set(r.number, dupeGroupCloseComment({ kept: r.target, carry: r.kind === "pr" ? points(r.detail, "carry") : [] }));
  }
  const keep = rows.find((r) => r.role === "keep" && r.kind === "issue");
  if (keep) {
    const text = dupeGroupDetailsComment(rows.filter((r) => r.kind === "issue" && r.role === "close").map((r) => ({ number: r.number, points: points(r.detail, "adds") })));
    if (text) out.set(keep.number, text);
  }
  return out;
}

/** Rewrites the stored comments of a group decision from its current roles. */
export function storeTexts(db: DatabaseSync, id: string): void {
  const rows = db.prepare("SELECT number, kind, role, target, detail FROM dupe_group_items WHERE decision_id = ?").all(id) as Row[];
  const texts = groupTexts(rows);
  const upd = db.prepare("UPDATE dupe_group_items SET comment = ? WHERE decision_id = ? AND number = ?");
  for (const r of rows) upd.run(texts.get(r.number) ?? null, id, r.number);
}

/** What the decision page shows: every stored comment with the item it goes on. Null when the decision has none. */
export function previewOf(db: DatabaseSync, id: string): string | null {
  const rows = db.prepare("SELECT number, role, comment FROM dupe_group_items WHERE decision_id = ? AND comment IS NOT NULL ORDER BY role = 'close', number").all(id) as { number: number; role: string; comment: string }[];
  if (!rows.length) return null;
  return rows.map((r) => `On #${r.number}:\n${r.comment}`).join("\n\n");
}
