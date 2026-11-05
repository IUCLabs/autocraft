// What the planner and the fix-up step read of operator fix-ups and pre-approved merges. No writes here.
import type { DatabaseSync } from "node:sqlite";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";

/** Fix-up states that count as a try; a row left in `pushing` by a crash counts too. */
const TRY_STATES = ["pushing", "pushed", "failed", "refused", "rejected"];
/** Fix-up states that end the work of an operator fix-up at its head (`linting` is a stored patch waiting for its lint task). */
const ENDED_STATES = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed"];

/** Tries the operator's fix-ups used on the PR; the fix-up limit of the PR applies to them as to the review's. */
export function operatorTries(db: DatabaseSync, repo: string, number: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM fixups WHERE repo = ? AND number = ? AND source = 'operator' AND state IN (${TRY_STATES.map(() => "?").join(",")})`)
    .get(repo, number, ...TRY_STATES) as { n: number }).n;
}
export const operatorTriesLeft = (db: DatabaseSync, repo: string, number: number): boolean => operatorTries(db, repo, number) < FIXUP_MAX_ATTEMPTS;

export type OperatorFix = { id: number; head: string; instructions: string; by: string; preapprovalId: number | null };

/** The operator fix-up of the PR still to work at `head`: queued and without a final fixups row there. */
export function queuedOperatorFix(db: DatabaseSync, repo: string, number: number, head: string): OperatorFix | null {
  const r = db.prepare(`SELECT id, from_head, instructions, by, preapproval_id FROM operator_fixups o WHERE repo = ? AND number = ? AND from_head = ? AND state = 'queued'
    AND NOT EXISTS (SELECT 1 FROM fixups f WHERE f.repo = o.repo AND f.number = o.number AND f.from_head = o.from_head AND f.source = 'operator' AND f.state IN (${ENDED_STATES.map(() => "?").join(",")}))
    ORDER BY id DESC LIMIT 1`).get(repo, number, head, ...ENDED_STATES) as { id: number; from_head: string; instructions: string; by: string; preapproval_id: number | null } | undefined;
  return r ? { id: r.id, head: r.from_head, instructions: r.instructions, by: r.by, preapprovalId: r.preapproval_id } : null;
}

export type OperatorWork = { fixHeads: Set<string>; hold: boolean };

/** Per PR ("repo#n"): the heads with a queued operator fix-up, and whether a pre-approved merge is still before its merge answer. Small tables, read once per pass. */
export function operatorWork(db: DatabaseSync, repo?: string): Map<string, OperatorWork> {
  const out = new Map<string, OperatorWork>();
  const get = (r: string, n: number): OperatorWork => {
    const k = `${r}#${n}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { fixHeads: new Set(), hold: false }));
    return w;
  };
  const q = (sql: string) => db.prepare(`${sql}${repo ? " AND repo = ?" : ""}`).all(...(repo ? [repo] : []));
  for (const o of q("SELECT repo, number, from_head FROM operator_fixups WHERE state = 'queued'") as { repo: string; number: number; from_head: string }[]) get(o.repo, o.number).fixHeads.add(o.from_head);
  for (const p of q("SELECT repo, number FROM preapprovals WHERE state IN ('fixup', 'review', 'ci')") as { repo: string; number: number }[]) get(p.repo, p.number).hold = true;
  return out;
}
