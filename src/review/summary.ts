// Summaries of Merge? and Close? decisions, taken from the review text stored for
// the PR at the head the decision was asked at. No model call.
import type { DatabaseSync } from "node:sqlite";
import { HEAD_FACT } from "../merge/queue.ts";
import { factsOf, type DecisionRow } from "../decisions.ts";
import { inPilot } from "../pilot.ts";

type Sonnet = { model: string | null; verdict: string; reason: string; risks: string | null };
type Opus = { model: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: string | null };

const one = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const risks = (s: string | null): string => {
  try {
    const r = (JSON.parse(s ?? "[]") as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim());
    return r.length ? ` Risks: ${r.slice(0, 3).map((x) => one(x, 150)).join("; ")}.` : "";
  } catch { return ""; }
};
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The stored Sonnet review and, when present, Opus's final review of one PR head; null when there is no review text. */
export function reviewSummary(db: DatabaseSync, repo: string, number: number, head: string): { summary: string; by: string } | null {
  const s = db.prepare("SELECT model, verdict, reason, risks FROM reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(repo, number, head) as Sonnet | undefined;
  const o = db.prepare("SELECT model, verdict, sure, reason, risks FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL").get(repo, number, head) as Opus | undefined;
  if (!s && !o) return null;
  const parts: string[] = [];
  const by: string[] = [];
  if (s) {
    parts.push(`Sonnet's review says ${s.verdict}: ${stop(one(s.reason, 450))}${risks(s.risks)}`);
    by.push(s.model ?? "sonnet");
  }
  if (o) {
    parts.push(`Opus's final review says ${o.verdict}${o.sure === 0 ? " (not sure)" : ""}: ${stop(one(o.reason, 450))}${risks(o.risks)}`);
    by.push(o.model ?? "opus");
  }
  return { summary: parts.join(" "), by: by.join(", ") };
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
