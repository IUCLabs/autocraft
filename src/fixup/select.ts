// The PRs the fix-up and conflict steps work on: those whose Plan holds a `fixup` or `conflict` action.
import type { DatabaseSync } from "node:sqlite";
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { PrFacts } from "../core/plan.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { type Carry, type FixCandidate, type FixSelection, parseFixes } from "./candidates.ts";
import { conflictTries, type ConflictCandidate } from "./conflict-state.ts";

/** The queued carry-over jobs of a kept PR that have points to carry, in the order the facts list them. */
function carriesOf(db: DatabaseSync, f: PrFacts, head: string): FixCandidate[] {
  const rows = db.prepare("SELECT decision_id, attempts FROM dupe_carries WHERE repo = ? AND number = ? AND state = 'queued' ORDER BY number").all(f.repo, f.number) as { decision_id: string; attempts: number }[];
  const out: FixCandidate[] = [];
  for (const r of rows) {
    const sources = (db.prepare("SELECT number, detail FROM dupe_group_items WHERE decision_id = ? AND kind = 'pr' AND role = 'close' ORDER BY number").all(r.decision_id) as { number: number; detail: string | null }[])
      .map((x) => {
        let pts: unknown = [];
        try { pts = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry ?? []; } catch { /* no points */ }
        const sh = (db.prepare("SELECT head_oid FROM items WHERE repo = ? AND number = ?").get(f.repo, x.number) as { head_oid: string | null } | undefined)?.head_oid ?? null;
        return { number: x.number, head: sh, points: Array.isArray(pts) ? pts.filter((p): p is string => typeof p === "string") : [] };
      }).filter((x) => x.points.length);
    if (!sources.length) continue;
    const suggestion = (db.prepare("SELECT t.text FROM dupe_group_texts t JOIN dupe_groups g ON g.decision_id = t.decision_id AND g.applied_answer = t.option WHERE t.decision_id = ? AND t.number = ? AND t.step = 'suggestion'").get(r.decision_id, f.number) as { text: string } | undefined)?.text ?? null;
    const carry: Carry = { decisionId: r.decision_id, suggestion, sources };
    out.push({ repo: f.repo, number: f.number, head, reason: `Parts of ${sources.map((x) => `#${x.number}`).join(", ")}, closed as duplicates, to carry over.`, fixes: [], attempt: r.attempts + 1,
      model: (db.prepare("SELECT summary_by FROM decisions WHERE id = ?").get(r.decision_id) as { summary_by: string | null } | undefined)?.summary_by ?? null, carry });
  }
  return out;
}

export function selectFixups(db: DatabaseSync, repo: string, run?: string | null, plans?: PlanSet): FixSelection {
  const opts = { repo, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) };
  const out: FixSelection = { fix: [], cannotPush: [], ask: [], conflictMerge: [], conflictAsk: [] };
  const review = db.prepare("SELECT fixes, model FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict = 'take-fix'");
  const text = db.prepare("SELECT title FROM items WHERE repo = ? AND number = ?");
  for (const { facts: f, action } of planned(db, "conflict", opts)) {
    const c: ConflictCandidate = {
      repo, number: f.number, head: action.head!, base: f.conflict!.base, title: ((text.get(repo, f.number) as { title: string | null } | undefined)?.title ?? "").slice(0, 300),
      reason: f.review!.reason, attempt: conflictTries(db, repo, f.number, action.head!) + 1, pushable: f.pushable,
    };
    (action.params?.bucket === "merge" ? out.conflictMerge : out.conflictAsk).push(c);
  }
  const carryFix: FixCandidate[] = [], carryAsk: FixCandidate[] = [], fix: FixCandidate[] = [];
  const carryIndex = new Map<string, number>();
  for (const { facts: f, action } of planned(db, "fixup", opts)) {
    const head = action.head!, bucket = action.params?.bucket;
    if (action.params?.source === "carry") {
      const ref = `${f.number}`;
      const i = carryIndex.get(ref) ?? 0;
      carryIndex.set(ref, i + 1);
      const c = carriesOf(db, f, head)[i];
      if (c) (bucket === "fix" ? carryFix : carryAsk).push(c);
    } else if (action.params?.source === "premerge") {
      // Only a branch we may push to gets a pre-merge round; otherwise the step leaves it alone.
      if (!f.pushable || !f.repoFacts.pushApproved) continue;
      const row = premergeAt(db, repo, f.number, head);
      const defects = findingsOf(row).filter((x) => x.severity === "defect");
      fix.push({ repo, number: f.number, head, reason: "pre-merge review", fixes: parseFixes(JSON.stringify(defects.map((x) => x.fix))), attempt: 1, model: row?.model ?? null, source: "premerge" });
    } else {
      const r = review.get(repo, f.number, head) as { fixes: string | null; model: string | null } | undefined;
      const c: FixCandidate = { repo, number: f.number, head, reason: f.review!.reason, fixes: parseFixes(r?.fixes ?? null), attempt: f.fixup!.attempts + 1, model: r?.model ?? null };
      if (bucket === "ask") out.ask.push(c);
      else if (bucket === "cannot-push") out.cannotPush.push(c);
      else if (bucket === "fix") fix.push(c);
    }
  }
  out.fix.push(...carryFix, ...fix);
  out.ask.unshift(...carryAsk);
  return out;
}
