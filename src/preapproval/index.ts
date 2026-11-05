// Pipeline steps of a resolution card (review again, fix-up, fix-up then merge) and the pre-approved merge they can start.
//
// A pre-approved merge is an operator's Merge answer given ahead of a fix-up. States (see Preapproval in web/src/api/types.ts):
//   fixup   -> the fix-up step works the operator's instructions (source 'operator' in its fixups rows)
//   review  -> the fix-up pushed; waiting for the Opus review of the pushed head
//   ci      -> that review says take (and is sure); waiting for CI of the pushed head
//   queued  -> CI is green: the PR's Merge? decision at the head is answered Merge by the operator, exactly as a dashboard answer
//              would be; the merge queue then merges it with every check it always makes (safe-merge included)
//   merged / asked / cancelled / failed end it.
// Every transition is a pure reaction to rows other steps write (fixups, opus_reviews, pr_checks, items, merges), evaluated by
// advancePreapprovals on each runner tick: no timer, no wait of its own. Merging itself is never called from here.
import type { DatabaseSync } from "node:sqlite";
import type { Preapproval } from "../../web/src/api/types.ts";
import type { Step } from "../conversations/cards.ts";
import { conversationOf, insertTurn, systemBlock } from "../conversations/store.ts";
import { HEAD_FACT, MERGE_OPTIONS, mergeDecisionId } from "../core/rules.ts";
import { audit } from "../dash/audit.ts";
import { ask, getDecision, replaceProposedCards } from "../decisions.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { repoHasNoCi } from "../merge/no-ci.ts";
import { withdrawOtherHeadQuestions } from "../merge/withdraw.ts";
import { markReviewsStale } from "../review/discussion.ts";
import { operatorTriesLeft, queuedOperatorFix } from "./state.ts";

export type PipelineStep = Extract<Step, { kind: "review" | "fixup" }>;

const ACTOR = "pipeline";
export const INSTRUCTIONS_MAX = 1500;
const ACTIVE = ["fixup", "review", "ci", "queued"] as const;
const iso = () => new Date().toISOString();
const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);

type Row = { id: number; repo: string; number: number; by: string; at: string; instructions: string; state: Preapproval["state"]; from_head: string; head: string | null; reason: string | null; updated_at: string; fix_id: number | null };
type PrRow = { state: string; head_oid: string | null; kind: string; head_repo: string | null; head_ref: string | null };

const prRow = (db: DatabaseSync, repo: string, n: number): PrRow | undefined =>
  db.prepare("SELECT state, head_oid, kind, head_repo, head_ref FROM items WHERE repo = ? AND number = ?").get(repo, n) as PrRow | undefined;

const toView = (r: Row): Preapproval => ({ id: r.id, by: r.by, at: r.at, instructions: r.instructions, state: r.state, fromHead: r.from_head, head: r.head, reason: r.reason, updatedAt: r.updated_at });

/** The newest pre-approved merge of the PR, or null. */
export function preapprovalOf(db: DatabaseSync, repo: string, n: number): Preapproval | null {
  const r = db.prepare("SELECT * FROM preapprovals WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 1").get(repo, n) as Row | undefined;
  return r ? toView(r) : null;
}

/** The system line of the item's thread (when it has a conversation). Not inside a transaction: the thread writes its own. */
function say(db: DatabaseSync, repo: string, n: number, text: string): void {
  if (conversationOf(db, repo, n)) insertTurn(db, repo, n, { kind: "system", login: "system", body: text, block: systemBlock(text) });
}

/** Moves the row to `to` when it is still in its state; audits the transition (the trace shows it) and says it in the thread. */
function move(db: DatabaseSync, p: Row, to: Row["state"], o: { head?: string | null; reason?: string | null; by?: string; line: string }): boolean {
  const r = db.prepare("UPDATE preapprovals SET state = ?, head = COALESCE(?, head), reason = ?, updated_at = ? WHERE id = ? AND state = ?")
    .run(to, o.head ?? null, o.reason ?? null, iso(), p.id, p.state);
  if (r.changes !== 1) return false;
  // A fix-up request that has no try yet must not start after the pre-approval ended; a push that is already running is recorded by the fix-up step as usual.
  if (["asked", "cancelled", "failed", "merged"].includes(to) && p.fix_id !== null) db.prepare("UPDATE operator_fixups SET state = 'ended' WHERE id = ?").run(p.fix_id);
  const head = o.head ?? p.head;
  audit(db, o.by ?? ACTOR, "preapproval", `${p.repo}#${p.number}`, { id: p.id, from: p.state, state: to, ...(head ? { head } : {}), ...(o.reason ? { reason: o.reason } : {}) });
  say(db, p.repo, p.number, o.line);
  return true;
}

// ---- starting a step ----------------------------------------------------------------------------------------------------

/** Queues a card's pipeline step for the PR; `label` is the done line the card shows. Throws when the step cannot start. */
export async function runPipelineStep(db: DatabaseSync, o: { repo: string; number: number; step: PipelineStep; by: string }): Promise<{ label: string }> {
  const { repo, number, step, by } = o;
  const ref = `${repo}#${number}`;
  const it = prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new Error(`${ref} is not a pull request`);
  if (it.state !== "OPEN") throw new Error(`${ref} is not open`);
  if (step.kind === "review") {
    markReviewsStale(db, by, repo, number);
    return { label: "Queued a new review of the current head" };
  }
  const instructions = step.instructions.trim();
  if (!instructions) throw new Error("the fix-up needs instructions");
  if (instructions.length > INSTRUCTIONS_MAX) throw new Error(`the instructions are over ${INSTRUCTIONS_MAX} characters`);
  const head = it.head_oid;
  if (!head) throw new Error(`${ref} has no head commit in the mirror yet`);
  const checks = db.prepare("SELECT head_oid, mergeable, maintainer_can_modify FROM pr_checks WHERE repo = ? AND number = ?").get(repo, number) as { head_oid: string; mergeable: string | null; maintainer_can_modify: number | null } | undefined;
  if (checks?.mergeable === "CONFLICTING") throw new Error(`${ref} conflicts with its base branch: the conflict merge comes first`);
  if (!pushApprovalOf(db, repo)) throw new Error(`pushing is not approved for ${repo}`);
  if (!pushable(it.head_repo, repo, checks?.head_oid === head ? checks.maintainer_can_modify : null, it.head_ref, longLivedOf(db, repo))) throw new Error("can't push to the contributor's branch");
  if (!operatorTriesLeft(db, repo, number)) throw new Error("the fix-up tries for this PR are used up");
  if (queuedOperatorFix(db, repo, number, head)) throw new Error(`a fix-up of ${ref} is already queued`);
  const merge = step.merge === true;
  if (merge) {
    if (!mergeApprovalOf(db, repo)) throw new Error(`merging is not approved for ${repo}`);
    if (db.prepare(`SELECT 1 FROM preapprovals WHERE repo = ? AND number = ? AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(repo, number, ...ACTIVE)) throw new Error(`${ref} already has a pre-approved merge in progress`);
  }
  const at = iso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const fix = Number(db.prepare("INSERT INTO operator_fixups (repo, number, from_head, instructions, by, at) VALUES (?, ?, ?, ?, ?, ?)").run(repo, number, head, instructions, by, at).lastInsertRowid);
    let id: number | null = null;
    if (merge) {
      id = Number(db.prepare("INSERT INTO preapprovals (repo, number, by, at, instructions, state, from_head, updated_at, fix_id) VALUES (?, ?, ?, ?, ?, 'fixup', ?, ?, ?)").run(repo, number, by, at, instructions, head, at, fix).lastInsertRowid);
      db.prepare("UPDATE operator_fixups SET preapproval_id = ? WHERE id = ?").run(id, fix);
    }
    audit(db, by, merge ? "preapproval" : "operator-fixup", ref, merge ? { id, state: "fixup", head } : { head, queued: true });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  say(db, repo, number, merge
    ? `${by} approved a merge after a fix-up: a fix-up of ${short(head)} is queued; if its review says take and CI is green, the PR goes to the merge queue.`
    : `${by} queued a fix-up of ${short(head)}.`);
  return { label: merge ? "Queued the fix-up; the PR merges if its review says take and CI is green" : "Queued the fix-up" };
}

// ---- the state machine ---------------------------------------------------------------------------------------------------

/** Asks a Merge? question at `head` the normal way (Prepare writes its options and recommendation); an answered one is left as it is. */
function askMerge(db: DatabaseSync, p: Row, head: string, why: string, facts: string[]): void {
  const id = mergeDecisionId(p.repo, p.number, head);
  if (getDecision(db, id)?.answer) return;
  const at = iso();
  ask(db, [{
    id, kind: "merge", repo: p.repo, number: p.number, question: "Merge this PR?",
    context: `${p.by} approved a merge after a fix-up, but it stopped: ${why}.`,
    facts: [...facts.slice(0, 4), `${HEAD_FACT}${head}`], options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: ACTOR, asked_at: at,
  }]);
  withdrawOtherHeadQuestions(db, p.repo, p.number, head, at);
}

/** Answers the PR's Merge? decision at `head` with Merge for the operator, as the dashboard would. Idempotent. Returns the reason when it cannot. */
function handOver(db: DatabaseSync, p: Row, head: string): string | null {
  if (!db.prepare("SELECT 1 FROM access WHERE login = ? AND role = 'operator'").get(p.by)) return `${p.by} is no longer an operator`;
  const id = mergeDecisionId(p.repo, p.number, head);
  const at = iso();
  if (!getDecision(db, id)) {
    ask(db, [{
      id, kind: "merge", repo: p.repo, number: p.number, question: "Merge this PR?",
      context: `${p.by} approved this merge ahead of a fix-up; the fix-up was pushed, its review says take and CI is green.`,
      facts: [`fix-up pushed by the pipeline from ${short(p.from_head)} to ${short(head)}`, `${HEAD_FACT}${head}`],
      options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: ACTOR, asked_at: at,
    }]);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const d = getDecision(db, id)!;
    if (d.answer === null) {
      db.prepare(`UPDATE main.decisions SET answer = 'merge', answer_note = NULL, exceptions = NULL, answered_by = ?, answered_at = ?, adopted_opinion = NULL, snoozed_by = NULL, snoozed_at = NULL
        WHERE id = ? AND answer IS NULL`).run(p.by, at, id);
      db.prepare("DELETE FROM main.decision_claims WHERE decision_id = ?").run(id);
      replaceProposedCards(db, p.repo, p.number);
      audit(db, p.by, "answer", id, { answer: "merge", source: "preapproval" });
    } else if (d.answer !== "merge") {
      db.exec("COMMIT");
      return `the Merge? question at this head was answered ${d.answer}`;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return null;
}

const FAILED_FIXUP = ["failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed"];

/** One pre-approved merge: reads what the other steps recorded and makes at most one transition. */
function advance(db: DatabaseSync, p: Row): void {
  const it = prRow(db, p.repo, p.number);
  const cancel = (reason: string) => void move(db, p, "cancelled", { reason, line: `The pre-approved merge was cancelled: ${reason}.` });
  if (!it) return cancel("the PR is gone");
  const cur = it.head_oid;
  const mergedByQueue = !!p.head && !!db.prepare("SELECT 1 FROM merges WHERE repo = ? AND number = ? AND head_oid = ? AND outcome = 'merged'").get(p.repo, p.number, p.head);
  if (p.state === "queued" && (it.state === "MERGED" || mergedByQueue)) return void move(db, p, "merged", { line: "The pre-approved merge went through: the PR is merged." });
  if (it.state === "MERGED") return cancel("the PR was merged before the fix-up finished");
  if (it.state !== "OPEN") return cancel("the PR was closed");

  if (p.state === "fixup") {
    const fx = db.prepare("SELECT state, to_head, reason FROM fixups WHERE repo = ? AND number = ? AND from_head = ? AND source = 'operator' ORDER BY rowid DESC LIMIT 1").get(p.repo, p.number, p.from_head) as { state: string; to_head: string | null; reason: string | null } | undefined;
    if (fx?.state === "pushed" && fx.to_head) return void move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    if (fx && FAILED_FIXUP.includes(fx.state)) {
      const why = `the fix-up ${fx.state}${fx.reason ? `: ${oneLine(fx.reason, 120)}` : ""}`;
      if (move(db, p, "failed", { reason: why, line: `The pre-approved merge stopped: ${why}. A Merge? question was asked.` })) askMerge(db, p, cur ?? p.from_head, why, [why]);
      return;
    }
    // A push written before it ran: when the head is its commit, it landed.
    if (fx?.state === "pushing" && fx.to_head && cur === fx.to_head) return void move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    if (!fx && cur !== null && cur !== p.from_head) return cancel(`another push moved the head to ${short(cur)}`);
    return;
  }

  // Every later state: the head is the fix-up's push, or the mirror has not read the push yet.
  if (cur !== null && cur !== p.head && cur !== p.from_head) return cancel(`another push moved the head to ${short(cur)}`);
  const head = p.head!;

  if (p.state === "review") {
    const r = db.prepare("SELECT verdict, sure, reason FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL").get(p.repo, p.number, head) as { verdict: string; sure: number | null; reason: string | null } | undefined;
    if (!r) return;
    if (r.verdict === "take" && r.sure === 1) return void move(db, p, "ci", { line: "The review of the fix-up says take; waiting for CI." });
    const why = `the review says ${r.verdict}${r.sure === 1 ? "" : " (unsure)"}${r.reason ? `: ${oneLine(r.reason, 160)}` : ""}`;
    if (move(db, p, "asked", { reason: why, line: `The pre-approved merge stopped: ${why}. A Merge? question was asked.` })) askMerge(db, p, head, why, [`review of the fix-up: ${why}`]);
    return;
  }

  if (p.state === "ci") {
    const c = db.prepare("SELECT overall FROM pr_checks WHERE repo = ? AND number = ? AND head_oid = ?").get(p.repo, p.number, head) as { overall: string } | undefined;
    if (!c || c.overall === "pending") return;
    if (c.overall === "failure") {
      // The CI fix step may still run on the red head as usual, but the pre-approval does not wait for it: its push would be a new head. The operator decides now.
      const why = "CI failed at the pushed head";
      if (move(db, p, "asked", { reason: why, line: `The pre-approved merge stopped: ${why}. A Merge? question was asked.` })) askMerge(db, p, head, why, ["review of the fix-up: take", why]);
      return;
    }
    if (c.overall === "none" && !repoHasNoCi(db, p.repo)) return;
    const refused = handOver(db, p, head);
    if (refused) {
      if (move(db, p, "asked", { reason: refused, line: `The pre-approved merge stopped: ${refused}.` }) && !refused.includes("was answered")) askMerge(db, p, head, refused, [refused]);
      return;
    }
    return void move(db, p, "queued", { line: "CI is green: the PR is in the merge queue, which checks it as for any Merge answer." });
  }

  // queued: the merge queue owns it now; only a withdrawn answer ends it here.
  const d = getDecision(db, mergeDecisionId(p.repo, p.number, head));
  if (!d || d.answer !== "merge") cancel("its Merge answer was withdrawn");
}

/** Runs on every runner tick: moves each pre-approved merge that other steps' rows have carried to a new state. Writes nothing when nothing moved. */
export function advancePreapprovals(db: DatabaseSync, log: (line: string) => void = () => {}): number {
  const rows = db.prepare(`SELECT * FROM preapprovals WHERE state IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id`).all(...ACTIVE) as Row[];
  let n = 0;
  for (const p of rows) {
    try {
      advance(db, p);
      if ((db.prepare("SELECT state FROM preapprovals WHERE id = ?").get(p.id) as { state: string }).state !== p.state) n++;
    } catch (e) {
      log(`preapproval ${p.repo}#${p.number}: ${(e as Error).message}`);
    }
  }
  return n;
}

/** An operator cancels the PR's pre-approved merge before the merge queue has merged it. Throws when there is none. */
export function cancelPreapproval(db: DatabaseSync, by: string, repo: string, n: number): Preapproval {
  const p = db.prepare(`SELECT * FROM preapprovals WHERE repo = ? AND number = ? AND state IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`).get(repo, n, ...ACTIVE) as Row | undefined;
  if (!p) throw new Error(`${repo}#${n} has no pre-approved merge in progress`);
  if (!move(db, p, "cancelled", { by, reason: `cancelled by ${by}`, line: `${by} cancelled the pre-approved merge.` })) throw new Error("the pre-approved merge changed a moment ago");
  // A queued one also loses the Merge answer it wrote, so the queue does not merge it.
  if (p.state === "queued" && p.head) {
    const id = mergeDecisionId(repo, n, p.head);
    const r = db.prepare("UPDATE main.decisions SET answer = NULL, answer_note = NULL, exceptions = NULL, answered_by = NULL, answered_at = NULL, applied_at = NULL, adopted_opinion = NULL WHERE id = ? AND answer = 'merge' AND applied_at IS NULL AND answered_by = ?").run(id, p.by);
    if (r.changes === 1) audit(db, by, "undo", id, { answer: "merge", source: "preapproval" });
  }
  return preapprovalOf(db, repo, n)!;
}
