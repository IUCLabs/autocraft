// Summaries of Merge? and Close? decisions, taken from the review text stored for
// the PR at the head the decision was asked at. No model call.
import type { DatabaseSync } from "node:sqlite";
import { HEAD_FACT } from "../merge/queue.ts";
import { factsOf, type DecisionRow } from "../decisions.ts";
import { inPilot } from "../pilot.ts";

type Opus = { model: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: string | null };

const one = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const risks = (s: string | null): string => {
  try {
    const r = (JSON.parse(s ?? "[]") as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim());
    return r.length ? ` Risks: ${r.slice(0, 3).map((x) => one(x, 150)).join("; ")}.` : "";
  } catch { return ""; }
};
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Opus's review of one PR head; null when there is no review text. */
export function reviewSummary(db: DatabaseSync, repo: string, number: number, head: string): { summary: string; by: string } | null {
  const o = db.prepare("SELECT model, verdict, sure, reason, risks FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL").get(repo, number, head) as Opus | undefined;
  if (!o) return null;
  const unsure = o.sure === 0 && (o.verdict === "take" || o.verdict === "take-fix") ? " Opus was unsure, so a person decides." : "";
  return { summary: `Opus's review says ${o.verdict}${o.sure === 0 ? " (not sure)" : ""}: ${stop(one(o.reason, 450))}${risks(o.risks)}${unsure}`, by: o.model ?? "opus" };
}

/** Fills the summary of open Merge? and Close? decisions that have none, from the stored reviews at their head. Returns how many it filled. */
export function fillReviewSummaries(db: DatabaseSync, at: string, repo?: string): number {
  const rows = db.prepare(`SELECT * FROM decisions WHERE kind IN ('merge', 'close') AND answer IS NULL AND summary IS NULL AND number IS NOT NULL
    ${repo ? "AND repo = ?" : ""}`).all(...(repo ? [repo] : [])) as DecisionRow[];
  const set = db.prepare("UPDATE decisions SET summary = ?, summary_by = ?, summary_at = ? WHERE id = ? AND summary IS NULL");
  let n = 0;
  for (const d of rows) {
    if (!inPilot(db, d.repo!, d.number!)) continue;
    const head = factsOf(d).find((f) => f.startsWith(HEAD_FACT))?.slice(HEAD_FACT.length).trim();
    const r = head ? reviewSummary(db, d.repo!, d.number!, head) : null;
    if (!r) continue;
    set.run(r.summary, r.by, at, d.id);
    n++;
  }
  return n;
}
