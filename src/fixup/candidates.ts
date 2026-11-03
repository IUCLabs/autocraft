// Which take-fix PRs the fix-up step works on, from the local tables only.
import { backlogHeldSql, notHeldSql } from "../dupes/held.ts";
import type { DatabaseSync } from "node:sqlite";
import { headOf } from "../review/candidates.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { pushApprovalOf } from "./approval.ts";
import { safePath } from "./patch.ts";
import { pilotSql } from "../pilot.ts";

/** Fix-up tries per PR (pushed, failed, refused or rejected) before the step leaves it to a person. */
export const MAX_ATTEMPTS = 2;

export type Fix = { file: string; change: string };
/** Parts of PRs closed as duplicates that a duplicate group's kept PR should take over (src/act/dupe-groups.ts queues them). */
export type Carry = { decisionId: string; /** The suggestion comment stored with the answer, posted as it is when the branch can't be pushed to. */ suggestion: string | null; sources: { number: number; head: string | null; points: string[] }[] };
/** `carry` set: the candidate is a carry-over job; its fixes are worked out from the source PRs' diffs when it runs. */
export type FixCandidate = { repo: string; number: number; head: string; reason: string; fixes: Fix[]; attempt: number; carry?: Carry };
export type FixSelection = {
  /** Take-fix PRs we may push to, in a repo with push approval. */
  fix: FixCandidate[];
  /** Take-fix PRs we can't push to that have no hold row at this head yet. */
  cannotPush: FixCandidate[];
  /** Take-fix PRs we can't push to, in a repo with comment approval, with no comment at this head yet. */
  ask: FixCandidate[];
};

type Row = {
  repo: string; number: number; head_oid: string | null; updated_at: string | null; is_draft: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null;
  mergeable: string | null; can_modify: number | null;
};

export function parseFixes(s: string | null): Fix[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((f): f is Fix => !!f && typeof f.file === "string" && typeof f.change === "string" && safePath(f.file)) : [];
  } catch { return []; }
}

export const FIXUP_STATES = ["pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "asked"] as const;
export type FixupState = (typeof FIXUP_STATES)[number];

/** States that count as a try; the other three are recorded once per head and end the step's work on that head. */
const ATTEMPT_STATES: FixupState[] = ["pushed", "failed", "refused", "rejected"];

export function attemptsOf(db: DatabaseSync, repo: string, number: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM fixups WHERE repo = ? AND number = ? AND state IN (${ATTEMPT_STATES.map(() => "?").join(",")})`)
    .get(repo, number, ...ATTEMPT_STATES) as { n: number }).n;
}

export type FixupBucket = "fix" | "unapproved" | "cannot-push" | "ask" | "asked" | "hold";
export type Classified = { c: FixCandidate; bucket: FixupBucket; done: boolean };

/**
 * Every take-fix PR at its current head with where it stands: `fix` (the step will push), `unapproved` (it could,
 * but the repo has no push approval), `cannot-push` (maintainers may not modify the branch, or a recorded cannot-push
 * or too-large at this head), `ask` (the same, in a repo with comment approval and no comment at this head yet),
 * `asked` (the contributor was told the fixes at this head) and `hold` (two tries used up, or an earlier push left the head unchanged). `done` marks
 * heads the step has recorded a final row for.
 */
export function classifyFixups(db: DatabaseSync, repo: string): Classified[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.mergeable, c.maintainer_can_modify AS can_modify
    FROM items i JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY p.score IS NULL, p.score DESC, i.number`).all(repo) as Row[];
  const done = db.prepare("SELECT state FROM fixups WHERE repo = ? AND number = ? AND from_head = ? AND state IN ('pushed', 'cannot-push', 'too-large', 'asked')");
  const commenting = commentApprovalOf(db, repo) !== null;
  const approved = pushApprovalOf(db, repo) !== null;
  const out: Classified[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head) continue;
    // The review row must be the one at the current head; reviews of older heads don't count.
    // The final verdict (Opus's, or Sonnet's when skip-listed) and its fix list.
    const review = db.prepare("SELECT reason, fixes FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND final = 1 AND verdict = 'take-fix'").get(r.repo, r.number, head) as
      { reason: string; fixes: string | null } | undefined;
    if (!review) continue;
    if (r.mergeable === "CONFLICTING") continue;
    const fixes = parseFixes(review.fixes);
    if (!fixes.length) continue;
    const c: FixCandidate = { repo: r.repo, number: r.number, head, reason: review.reason, fixes, attempt: attemptsOf(db, r.repo, r.number) + 1 };
    const recorded = done.all(r.repo, r.number, head) as { state: string }[];
    const has = (state: string) => recorded.some((x) => x.state === state);
    // Heads held before the repo got comment approval are asked once it has it.
    const ask = (held: boolean): Classified => commenting ? { c, done: false, bucket: "ask" } : { c, done: held, bucket: "cannot-push" };
    if (has("asked")) out.push({ c, done: true, bucket: "asked" });
    else if (has("pushed")) out.push({ c, done: true, bucket: "hold" });
    else if (has("cannot-push")) out.push(ask(true));
    else if (has("too-large")) out.push({ c, done: true, bucket: "cannot-push" });
    else if (!r.can_modify) out.push(ask(false));
    else if (c.attempt > MAX_ATTEMPTS) out.push({ c, done: false, bucket: "hold" });
    else out.push({ c, done: false, bucket: approved ? "fix" : "unapproved" });
  }
  return out;
}

/** Queued carry-over jobs for open, non-draft kept PRs: pushed when we may push, else posted as a comment when the repo allows comments. */
export function carryCandidates(db: DatabaseSync, repo: string): { fix: FixCandidate[]; ask: FixCandidate[] } {
  const out = { fix: [] as FixCandidate[], ask: [] as FixCandidate[] };
  const rows = db.prepare(`SELECT k.decision_id, k.attempts, i.number, i.head_oid, i.updated_at, i.is_draft,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, c.maintainer_can_modify AS can_modify, c.mergeable
    FROM dupe_carries k JOIN items i ON i.repo = k.repo AND i.number = k.number AND i.kind = 'pr' AND i.state = 'OPEN' AND ${pilotSql("i")} AND NOT ${backlogHeldSql("i")}
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    WHERE k.repo = ? AND k.state = 'queued' ORDER BY k.number`).all(repo) as (Row & { decision_id: string; attempts: number })[];
  const commenting = commentApprovalOf(db, repo) !== null;
  const approved = pushApprovalOf(db, repo) !== null;
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || r.mergeable === "CONFLICTING") continue;
    const sources = (db.prepare("SELECT number, detail FROM dupe_group_items WHERE decision_id = ? AND kind = 'pr' AND role = 'close' ORDER BY number").all(r.decision_id) as { number: number; detail: string | null }[])
      .map((x) => {
        let pts: unknown = [];
        try { pts = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry ?? []; } catch { /* no points */ }
        const sh = (db.prepare("SELECT head_oid FROM items WHERE repo = ? AND number = ?").get(repo, x.number) as { head_oid: string | null } | undefined)?.head_oid ?? null;
        return { number: x.number, head: sh, points: Array.isArray(pts) ? pts.filter((p): p is string => typeof p === "string") : [] };
      }).filter((x) => x.points.length);
    if (!sources.length) continue;
    const suggestion = (db.prepare("SELECT t.text FROM dupe_group_texts t JOIN dupe_groups g ON g.decision_id = t.decision_id AND g.applied_answer = t.option WHERE t.decision_id = ? AND t.number = ? AND t.step = 'suggestion'").get(r.decision_id, r.number) as { text: string } | undefined)?.text ?? null;
    const c: FixCandidate = { repo, number: r.number, head, reason: `Parts of ${sources.map((x) => `#${x.number}`).join(", ")}, closed as duplicates, to carry over.`, fixes: [], attempt: r.attempts + 1, carry: { decisionId: r.decision_id, suggestion, sources } };
    if (r.can_modify && approved && c.attempt <= MAX_ATTEMPTS) out.fix.push(c);
    else if (commenting) out.ask.push(c);
  }
  return out;
}

export function selectFixups(db: DatabaseSync, repo: string): FixSelection {
  const out: FixSelection = { fix: [], cannotPush: [], ask: [] };
  const carry = carryCandidates(db, repo);
  out.fix.push(...carry.fix);
  out.ask.push(...carry.ask);
  for (const x of classifyFixups(db, repo)) {
    if (x.bucket === "ask") out.ask.push(x.c);
    if (x.done) continue;
    if (x.bucket === "cannot-push") out.cannotPush.push(x.c);
    else if (x.bucket === "fix") out.fix.push(x.c);
  }
  return out;
}
