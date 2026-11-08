// An operator's Merge answer to a Merge? question that named a failed or errored verification stands only when it was given after that
// verification result at the same head. A pre-approved merge's hand-over never answers over a failed verification (src/preapproval).
import type { DatabaseSync } from "node:sqlite";
import { settledBySql } from "../settlers.ts";
import { mergeDecisionId } from "../core/rules.ts";

export function verifyOverride(db: DatabaseSync, repo: string, number: number, head: string): boolean {
  const v = db.prepare("SELECT created_at FROM verifications WHERE repo = ? AND number = ? AND head_sha = ? AND state IN ('failed', 'error')").get(repo, number, head) as { created_at: string } | undefined;
  if (!v) return false;
  return !!db.prepare(`SELECT 1 FROM decisions WHERE id = ? AND kind = 'merge' AND answer = 'merge' AND answered_at > ? AND ${settledBySql("decisions")}`).get(mergeDecisionId(repo, number, head), v.created_at);
}
