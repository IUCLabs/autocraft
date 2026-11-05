// What the planner and the fix-up step read of operator fix-ups and pre-approved merges. No writes here.
import type { DatabaseSync } from "node:sqlite";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";

/** Fix-up states that count as a try; a row left in `pushing` by a crash counts too. */
const TRY_STATES = ["pushing", "pushed", "failed", "refused", "rejected"];
/** Fix-up states that end the work of an operator fix-up (`linting` is a stored patch waiting for its lint task; `superseded` is one the plan dropped). */
const ENDED_STATES = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];
/** A fix-up request that has not been worked this long stops holding the PR's merge. */
export const HOLD_MAX_MS = 24 * 3600_000;
const ENDED_SQL = `EXISTS (SELECT 1 FROM fixups f WHERE f.operator_fix = o.id AND f.source = 'operator' AND f.state IN (${ENDED_STATES.map(() => "?").join(",")}))`;

/** Tries the operator's fix-ups used on the PR; the fix-up limit of the PR applies to them as to the review's. */
export function operatorTries(db: DatabaseSync, repo: string, number: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM fixups WHERE repo = ? AND number = ? AND source = 'operator' AND state IN (${TRY_STATES.map(() => "?").join(",")})`)
    .get(repo, number, ...TRY_STATES) as { n: number }).n;
}
export const operatorTriesLeft = (db: DatabaseSync, repo: string, number: number): boolean => operatorTries(db, repo, number) < FIXUP_MAX_ATTEMPTS;

export type OperatorFix = { id: number; head: string; instructions: string; by: string; preapprovalId: number | null };

/** The operator fix-up of the PR still to work at `head`: queued and without a final fixups row of its own (matched by the request's id). */
export function queuedOperatorFix(db: DatabaseSync, repo: string, number: number, head: string): OperatorFix | null {
  const r = db.prepare(`SELECT id, from_head, instructions, by, preapproval_id FROM operator_fixups o WHERE repo = ? AND number = ? AND from_head = ? AND state = 'queued'
    AND NOT ${ENDED_SQL}
    ORDER BY id DESC LIMIT 1`).get(repo, number, head, ...ENDED_STATES) as { id: number; from_head: string; instructions: string; by: string; preapproval_id: number | null } | undefined;
  return r ? { id: r.id, head: r.from_head, instructions: r.instructions, by: r.by, preapprovalId: r.preapproval_id } : null;
}

export type OperatorWork = { fixHeads: Set<string>; hold: boolean; /** The pushed head of a pre-approved merge waiting for its pre-merge review (state `ci`). */ premergeHeads: Set<string> };

/** Per PR ("repo#n"): the heads with an operator fix-up still to work, whether the PR's merge is held (a pre-approved merge before its merge answer, or a fix-up request still being worked), and the heads due a pre-merge review. Small tables, read once per pass. */
export function operatorWork(db: DatabaseSync, repo?: string): Map<string, OperatorWork> {
  const out = new Map<string, OperatorWork>();
  const get = (r: string, n: number): OperatorWork => {
    const k = `${r}#${n}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { fixHeads: new Set(), hold: false, premergeHeads: new Set() }));
    return w;
  };
  const q = (sql: string) => db.prepare(`${sql}${repo ? " AND repo = ?" : ""}`).all(...(repo ? [repo] : []));
  const since = new Date(Date.now() - HOLD_MAX_MS).toISOString();
  for (const o of db.prepare(`SELECT repo, number, from_head, at FROM operator_fixups o WHERE state = 'queued' AND NOT ${ENDED_SQL}${repo ? " AND repo = ?" : ""}`).all(...ENDED_STATES, ...(repo ? [repo] : [])) as { repo: string; number: number; from_head: string; at: string }[]) {
    const w = get(o.repo, o.number);
    w.fixHeads.add(o.from_head);
    if (o.at > since) w.hold = true;
  }
  for (const p of q("SELECT repo, number, state, head FROM preapprovals WHERE state IN ('fixup', 'review', 'ci')") as { repo: string; number: number; state: string; head: string | null }[]) {
    const w = get(p.repo, p.number);
    w.hold = true;
    if (p.state === "ci" && p.head) w.premergeHeads.add(p.head);
  }
  return out;
}
