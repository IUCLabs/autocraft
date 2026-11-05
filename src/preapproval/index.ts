// Pipeline steps of a resolution card (review again, fix-up, fix-up then merge) and the pre-approved merge they can start.
//
// A pre-approved merge is an operator's Merge answer given ahead of a fix-up. States (see Preapproval in web/src/api/types.ts):
//   fixup   -> the fix-up step works the operator's instructions (source 'operator' in its fixups rows)
//   review  -> the fix-up pushed; waiting for the Opus review of the pushed head
//   ci      -> that review says take (and is sure, not stale); waiting for CI of the pushed head, then for a clean pre-merge review of it
//   queued  -> CI is green and the pre-merge review is clean: the PR's Merge? decision at the head is answered Merge by the operator,
//              exactly as a dashboard answer would be, in the same transaction that moves the row from ci to queued; the merge queue
//              then merges it with every check it always makes (safe-merge included)
//   merged / asked / cancelled / failed end it.
// Every transition is a pure reaction to rows other steps write (fixups, opus_reviews, pr_checks, items, merges), evaluated by
// advancePreapprovals on each runner tick: no timer and no wait of its own; the one time comparison (the start of the mirror's last sync against the push) is made when the tick runs anyway. Merging itself is never called from here.
import type { DatabaseSync } from "node:sqlite";
import type { Preapproval } from "../../web/src/api/types.ts";
import type { Step } from "../conversations/cards.ts";
import { conversationOf, insertTurn, systemBlock } from "../conversations/store.ts";
import { cifixBucket, decidePr } from "../core/decide.ts";
import { loadPrFact } from "../core/facts.ts";
import { HEAD_FACT, MERGE_OPTIONS, PREMERGE_MAX_TRIES, mergeDecisionId } from "../core/rules.ts";
import { audit } from "../dash/audit.ts";
import { ask, getDecision, replaceProposedCards } from "../decisions.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { repoHasNoCi } from "../merge/no-ci.ts";
import { withdrawOtherHeadQuestions } from "../merge/withdraw.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { releaseMerge, removeFromBatch } from "../merge/controls.ts";
import type { Exec } from "../fixup/git.ts";
import { markReviewsStale, staleReviews } from "../review/discussion.ts";
import type { PrFacts } from "../core/plan.ts";
import { openOperatorFixups, operatorTriesLeft, queuedOperatorFix } from "./state.ts";

export type PipelineStep = Extract<Step, { kind: "review" | "fixup" }>;

const ACTOR = "pipeline";
export const INSTRUCTIONS_MAX = 1500;
const ACTIVE = ["fixup", "review", "ci", "queued"] as const;
/** Plan states in which the PR gets no review, so a pre-approved merge cannot go on. */
const NOT_REVIEWABLE = ["out-of-scope", "integration", "backlog", "duplicate", "draft", "label-not-reviewed", "scope"];
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

/** Moves the row to `to` when it is still in its state; audits the transition (the trace shows it). Callable inside a transaction. */
function moveRaw(db: DatabaseSync, p: Row, to: Row["state"], o: { head?: string | null; reason?: string | null; by?: string }): boolean {
  const r = db.prepare("UPDATE preapprovals SET state = ?, head = COALESCE(?, head), reason = ?, updated_at = ? WHERE id = ? AND state = ?")
    .run(to, o.head ?? null, o.reason ?? null, iso(), p.id, p.state);
  if (r.changes !== 1) return false;
  // A fix-up request that has no try yet must not start after the pre-approval ended; a push that is already running is recorded by the fix-up step as usual.
  if (["asked", "cancelled", "failed", "merged"].includes(to) && p.fix_id !== null) db.prepare("UPDATE operator_fixups SET state = 'ended' WHERE id = ?").run(p.fix_id);
  const head = o.head ?? p.head;
  audit(db, o.by ?? ACTOR, "preapproval", `${p.repo}#${p.number}`, { id: p.id, from: p.state, state: to, ...(head ? { head } : {}), ...(o.reason ? { reason: o.reason } : {}) });
  return true;
}

/** `moveRaw`, then says it in the thread. Not inside a transaction: the thread writes its own. */
function move(db: DatabaseSync, p: Row, to: Row["state"], o: { head?: string | null; reason?: string | null; by?: string; line: string }): boolean {
  if (!moveRaw(db, p, to, o)) return false;
  say(db, p.repo, p.number, o.line);
  return true;
}

const isOperator = (db: DatabaseSync, login: string | null): boolean => !!login && !!db.prepare("SELECT 1 FROM access WHERE login = ? AND role = 'operator'").get(login);

/** Takes back the Merge answer the hand-over wrote at the row's head (an answer anyone else wrote, or one already applied, stays). Inside the caller's transaction. */
function revertAnswer(db: DatabaseSync, p: Row, by: string): boolean {
  if (!p.head) return false;
  const id = mergeDecisionId(p.repo, p.number, p.head);
  if (!db.prepare("SELECT 1 FROM audit WHERE action = 'answer' AND target = ? AND details LIKE '%\"source\":\"preapproval\"%'").get(id)) return false;
  const r = db.prepare("UPDATE main.decisions SET answer = NULL, answer_note = NULL, exceptions = NULL, answered_by = NULL, answered_at = NULL, applied_at = NULL, adopted_opinion = NULL WHERE id = ? AND answer = 'merge' AND applied_at IS NULL AND answered_by = ?").run(id, p.by);
  if (r.changes !== 1) return false;
  audit(db, by, "undo", id, { answer: "merge", source: "preapproval" });
  return true;
}

/** Cancels the row and takes the hand-over answer back in one transaction, whatever state the caller read. False when the row had ended meanwhile. */
function cancelRow(db: DatabaseSync, id: number, by: string, reason: string, line: string, guard = false): boolean {
  db.exec("BEGIN IMMEDIATE");
  let p: Row | undefined;
  try {
    p = db.prepare("SELECT * FROM preapprovals WHERE id = ?").get(id) as Row | undefined;
    if (!p || !(ACTIVE as readonly string[]).includes(p.state)) {
      db.exec("ROLLBACK");
      return false;
    }
    // Past the guard of the merge queue, a cancel cannot stop the merge: a batch holds the PR, or it is merged.
    if (guard && p.state === "queued") {
      if (inActiveBatch(db, p.repo, p.number)) throw new Error("the PR is still in an integration batch");
      if (mergeRunning(db, p.repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
      if (p.head && db.prepare("SELECT 1 FROM merges WHERE repo = ? AND number = ? AND head_oid = ? AND outcome = 'merged'").get(p.repo, p.number, p.head)) throw new Error("the PR is already merged");
    }
    if (!moveRaw(db, p, "cancelled", { by, reason })) {
      db.exec("ROLLBACK");
      return false;
    }
    revertAnswer(db, p, by);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  say(db, p.repo, p.number, line);
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
  // The fix-up step and the review of its push only see PRs the planner works: out of scope, integration and unreviewable PRs would wait for ever.
  const fact = loadPrFact(db, repo, number);
  const planState = fact ? decidePr(fact).state : null;
  if (!planState || planState === "out-of-scope" || planState === "integration") throw new Error(`${ref} is outside the pipeline's scope: no fix-up runs on it`);
  if (step.merge === true && NOT_REVIEWABLE.filter((x) => x !== "scope").includes(planState)) throw new Error(`${ref} cannot be reviewed (${planState}): a merge after the fix-up could not follow`);
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

type Hand = { done: true } | { gone: true } | { stop: string };

/**
 * Moves the row from ci to queued and answers the PR's Merge? decision at `head` with Merge for the operator, as the dashboard would,
 * in one transaction: a cancel that ran first leaves the row cancelled and nothing answered. Idempotent.
 */
function handOver(db: DatabaseSync, p: Row, head: string): Hand {
  const id = mergeDecisionId(p.repo, p.number, head);
  const at = iso();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isOperator(db, p.by)) {
      db.exec("ROLLBACK");
      return { stop: `${p.by} is no longer an operator` };
    }
    const d0 = getDecision(db, id);
    if (d0 && d0.answer !== null && d0.answer !== "merge") {
      db.exec("ROLLBACK");
      return { stop: `the Merge? question at this head was answered ${d0.answer}` };
    }
    if (!moveRaw(db, p, "queued", { head })) {
      db.exec("ROLLBACK");
      return { gone: true };
    }
    if (!getDecision(db, id)) {
      ask(db, [{
        id, kind: "merge", repo: p.repo, number: p.number, question: "Merge this PR?",
        context: `${p.by} approved this merge ahead of a fix-up; the fix-up was pushed, its review says take, CI is green and its pre-merge review is clean.`,
        facts: [`fix-up pushed by the pipeline from ${short(p.from_head)} to ${short(head)}`, `${HEAD_FACT}${head}`],
        options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: ACTOR, asked_at: at,
      }], true);
    }
    if (getDecision(db, id)!.answer === null) {
      db.prepare(`UPDATE main.decisions SET answer = 'merge', answer_note = NULL, exceptions = NULL, answered_by = ?, answered_at = ?, adopted_opinion = NULL, snoozed_by = NULL, snoozed_at = NULL
        WHERE id = ? AND answer IS NULL`).run(p.by, at, id);
      db.prepare("DELETE FROM main.decision_claims WHERE decision_id = ?").run(id);
      replaceProposedCards(db, p.repo, p.number);
      audit(db, p.by, "answer", id, { answer: "merge", source: "preapproval" });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  say(db, p.repo, p.number, "CI is green and the pre-merge review is clean: the PR is in the merge queue, which checks it as for any Merge answer.");
  return { done: true };
}

type ReviewRead = { kind: "none" | "stale" | "take" | "bad"; why: string };

/** The Opus review at `head`: a sure take that is not stale is the only one a pre-approved merge goes on with. */
function reviewAt(db: DatabaseSync, p: Row, head: string): ReviewRead {
  const r = db.prepare("SELECT verdict, sure, reason FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ? AND verdict IS NOT NULL").get(p.repo, p.number, head) as { verdict: string; sure: number | null; reason: string | null } | undefined;
  if (!r) return { kind: "none", why: "" };
  if (staleReviews(db, p.repo).has(`${p.repo}#${p.number}@${head}`)) return { kind: "stale", why: "" };
  if (r.verdict === "take" && r.sure === 1) return { kind: "take", why: "" };
  return { kind: "bad", why: `the review says ${r.verdict}${r.sure === 1 ? "" : " (unsure)"}${r.reason ? `: ${oneLine(r.reason, 160)}` : ""}` };
}

/** "CI fix" or "conflict merge" when the pipeline itself pushed `cur` on top of the row's head, else null. */
function ownPush(db: DatabaseSync, p: Row, cur: string): string | null {
  if (db.prepare("SELECT 1 FROM ci_fixes WHERE repo = ? AND number = ? AND head = ? AND to_head = ? AND state IN ('pushing', 'pushed')").get(p.repo, p.number, p.head, cur)) return "CI fix";
  if (db.prepare("SELECT 1 FROM conflict_merges WHERE repo = ? AND number = ? AND from_head = ? AND to_head = ? AND state IN ('pushing', 'merged')").get(p.repo, p.number, p.head, cur)) return "conflict merge";
  return null;
}

/** Why the planner does not list the operator's fix-up for the PR now; null when it does. */
function whyNotPlanned(db: DatabaseSync, f: PrFacts): string | null {
  if (decidePr(f).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator")) return null;
  if (f.draft) return "the PR is a draft";
  if (f.heldBacklog) return "the PR is held in the backlog";
  if (f.mergeable === "CONFLICTING") return "the PR conflicts with its base branch";
  if (!f.pushable) return "the PR's branch cannot be pushed to";
  if (!f.repoFacts.pushApproved) return "pushing is not approved for the repo";
  if (!operatorTriesLeft(db, f.repo, f.number)) return "the fix-up tries are used up";
  return "the pipeline does not plan the fix-up";
}

/** Whether the CI fix or conflict step is working the PR now or the planner lists it: a wait for it ends. A step the planner does not list (not approved, held, merge blocked) and that has no task in flight never moves the PR on. */
function stepRuns(f: PrFacts, step: "cifix" | "conflict"): boolean {
  const acts = decidePr(f).actions;
  if (step === "conflict") return f.conflict?.bucket === "linting" || acts.some((a) => a.kind === "conflict" && a.params?.bucket === "merge");
  const b = cifixBucket(f);
  return (b !== null && ["formatting", "linting", "rerun-wait"].includes(b)) || acts.some((a) => a.kind === "cifix" && !["capped", "ask"].includes(String(a.params?.bucket)));
}

const FAILED_FIXUP = ["failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];

/** One pre-approved merge: reads what the other steps recorded and makes at most one transition. */
function advance(db: DatabaseSync, p: Row): void {
  const it = prRow(db, p.repo, p.number);
  const cancel = (reason: string) => void cancelRow(db, p.id, ACTOR, reason, `The pre-approved merge was cancelled: ${reason}.`);
  const stop = (to: "asked" | "failed", why: string, head: string, facts: string[] = [why]) => {
    if (move(db, p, to, { reason: why, line: `The pre-approved merge stopped: ${why}. A Merge? question was asked.` })) askMerge(db, p, head, why, facts);
  };
  if (!it) return cancel("the PR is gone");
  const cur = it.head_oid;
  const mergedByQueue = !!p.head && !!db.prepare("SELECT 1 FROM merges WHERE repo = ? AND number = ? AND head_oid = ? AND outcome = 'merged'").get(p.repo, p.number, p.head);
  if (p.state === "queued" && (it.state === "MERGED" || mergedByQueue)) return void move(db, p, "merged", { line: "The pre-approved merge went through: the PR is merged." });
  if (it.state === "MERGED") return cancel("the PR was merged before the fix-up finished");
  if (it.state !== "OPEN") return cancel("the PR was closed");

  if (p.state === "fixup") {
    const fx = db.prepare("SELECT state, to_head, reason FROM fixups WHERE operator_fix = ? AND source = 'operator' ORDER BY rowid DESC LIMIT 1").get(p.fix_id) as { state: string; to_head: string | null; reason: string | null } | undefined;
    if (fx?.state === "pushed" && fx.to_head) return void move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    if (fx && FAILED_FIXUP.includes(fx.state)) {
      const why = `the fix-up ${fx.state}${fx.reason ? `: ${oneLine(fx.reason, 120)}` : ""}`;
      return stop("failed", why, cur ?? p.from_head);
    }
    // A push written before it ran: when the head is its commit, it landed.
    if (fx?.state === "pushing" && fx.to_head && cur === fx.to_head) return void move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    // Whatever the fix-up row says (none yet, linting, pushing), a head that is neither its start nor its push is someone else's.
    if (cur !== null && cur !== p.from_head && cur !== fx?.to_head) return cancel(`another push moved the head to ${short(cur)}`);
    // No try yet and the planner would not work the request (not pushable, conflicting, a draft, ...): it would wait for ever.
    if (!fx) {
      const f = loadPrFact(db, p.repo, p.number);
      const why = f ? whyNotPlanned(db, f) : null;
      if (why) stop("asked", `the fix-up cannot run: ${why}`, cur ?? p.from_head);
    }
    return;
  }

  // Every later state: the head is the fix-up's push. Until a review exists at it, the mirror may still show the head the push started from, for a short time.
  const head = p.head!;
  if (cur !== null && cur !== head) {
    // The mirror row shows the old head until a sync that started after the push has finished (synced_at is the sync's start; the row's state entry follows the push); a review at the pushed head also shows the mirror saw it.
    const synced = (db.prepare("SELECT synced_at FROM repos WHERE name = ?").get(p.repo) as { synced_at: string | null } | undefined)?.synced_at ?? null;
    const lag = p.state === "review" && cur === p.from_head && (synced === null || synced <= p.updated_at)
      && !db.prepare("SELECT 1 FROM opus_reviews WHERE repo = ? AND number = ? AND head_oid = ?").get(p.repo, p.number, head);
    if (!lag && p.state !== "queued") {
      // The pipeline's own CI fix or conflict merge on the pushed head carries the pre-approval on: the new head needs the whole chain again.
      const own = ownPush(db, p, cur);
      if (own) return void move(db, p, "review", { head: cur, line: `The ${own} pushed ${short(cur)}; it needs a fresh review, a clean pre-merge review and green CI before the PR goes to the merge queue.` });
    }
    if (!lag) return cancel(cur === p.from_head ? `the head went back to ${short(cur)}` : `another push moved the head to ${short(cur)}`);
  }

  if (p.state === "review") {
    const r = reviewAt(db, p, head);
    if (r.kind === "stale") return;
    if (r.kind === "none") {
      // No review is coming for a PR the planner does not review (an open scope question, a draft, a hold).
      const f = cur === head ? loadPrFact(db, p.repo, p.number) : null;
      const state = f ? decidePr(f).state : null;
      if (state && NOT_REVIEWABLE.includes(state)) stop("asked", `the pushed head cannot be reviewed (${state})`, head);
      return;
    }
    if (r.kind === "take") return void move(db, p, "ci", { line: "The review of the fix-up says take; waiting for CI." });
    return stop("asked", r.why, head, [`review of the fix-up: ${r.why}`]);
  }

  if (!mergeApprovalOf(db, p.repo)) return p.state === "queued" ? cancel("merging is no longer approved for the repo") : stop("asked", "merging is no longer approved for the repo", head);

  if (p.state === "ci") {
    // A re-review since the move to ci counts: the hand-over needs a sure take at this head now.
    const r = reviewAt(db, p, head);
    if (r.kind === "none" || r.kind === "stale") return void move(db, p, "review", { line: "The review of the pushed head is out of date; Opus reviews it again." });
    if (r.kind === "bad") return stop("asked", r.why, head, [`review of the fix-up: ${r.why}`]);
    const c = db.prepare("SELECT overall, mergeable FROM pr_checks WHERE repo = ? AND number = ? AND head_oid = ?").get(p.repo, p.number, head) as { overall: string; mergeable: string | null } | undefined;
    if (!c || c.overall === "pending") return;
    if (c.overall === "failure") {
      // The CI fix step works the red head as it would for any PR; its push is a new head that continues this pre-approval (see ownPush). The operator decides when the step has given up.
      const f = loadPrFact(db, p.repo, p.number);
      const bucket = f ? cifixBucket(f) : null;
      if (bucket !== null && ["work", "formatting", "linting", "collect", "rerun", "rerun-wait"].includes(bucket) && stepRuns(f!, "cifix")) return;
      return stop("asked", "CI failed at the pushed head and the CI fix did not repair it", head, ["review of the fix-up: take", "CI failed at the pushed head"]);
    }
    if (c.overall === "none" && !repoHasNoCi(db, p.repo)) return;
    if (c.mergeable === "CONFLICTING") {
      // The conflict step merges the base into the PR when it can; its push is a new head that continues this pre-approval.
      const f = loadPrFact(db, p.repo, p.number);
      if (f?.conflict?.baseOk && ["merge", "linting"].includes(f.conflict.bucket) && stepRuns(f, "conflict")) return;
      return stop("asked", "the PR conflicts with its base branch", head);
    }
    // The pre-merge review of this head must be clean; the planner runs it (src/core/decide.ts) and retries a failed one.
    const pm = premergeAt(db, p.repo, p.number, head);
    if (!pm || (pm.findings === null && pm.tries < PREMERGE_MAX_TRIES)) return;
    if (pm.findings === null) return stop("asked", "the pre-merge review of the pushed head failed", head);
    const defects = findingsOf(pm).filter((x) => x.severity === "defect").length;
    if (defects) return stop("asked", `the pre-merge review found ${defects} defect${defects === 1 ? "" : "s"}`, head);
    if (pm.unsure === 1) return stop("asked", "the pre-merge review is unsure", head);
    const h = handOver(db, p, head);
    if ("stop" in h) {
      if (move(db, p, "asked", { reason: h.stop, line: `The pre-approved merge stopped: ${h.stop}.` }) && !h.stop.includes("was answered")) askMerge(db, p, head, h.stop, [h.stop]);
    }
    return;
  }

  // queued: the merge queue owns it now; only an answer that stops counting ends it here.
  const d = getDecision(db, mergeDecisionId(p.repo, p.number, head));
  if (!d || d.answer !== "merge") return cancel("its Merge answer was withdrawn");
  if (!isOperator(db, d.answered_by ?? p.by)) cancel(`${d.answered_by ?? p.by} is no longer an operator, so the Merge answer no longer counts`);
}

/** Ends fix-up requests the planner can no longer work (the PR's head moved, it closed, the push is not possible), with the reason in the thread. Requests of a pre-approved merge end with it. */
function endStaleRequests(db: DatabaseSync): void {
  for (const o of openOperatorFixups(db)) {
    if (o.preapprovalId !== null) continue;
    const f = loadPrFact(db, o.repo, o.number);
    const why = !f ? "the PR is no longer open" : f.head !== o.head ? `the head moved to ${short(f.head)}` : o.started ? null : whyNotPlanned(db, f);
    if (!why) continue;
    if (db.prepare("UPDATE operator_fixups SET state = 'ended' WHERE id = ? AND state = 'queued'").run(o.id).changes !== 1) continue;
    audit(db, ACTOR, "operator-fixup", `${o.repo}#${o.number}`, { id: o.id, ended: true, reason: why });
    say(db, o.repo, o.number, `The queued fix-up of ${short(o.head)} was dropped: ${why}.`);
  }
}

/** A cancel that came too late for a merge already past its guard: the merge row that appears at the head turns the row into merged. */
function settleCancelled(db: DatabaseSync): void {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rows = db.prepare("SELECT * FROM preapprovals WHERE state = 'cancelled' AND head IS NOT NULL AND updated_at > ?").all(since) as Row[];
  for (const p of rows) {
    if (db.prepare("SELECT 1 FROM merges WHERE repo = ? AND number = ? AND head_oid = ? AND outcome = 'merged' AND at >= ?").get(p.repo, p.number, p.head, p.at)) move(db, p, "merged", { line: "The merge went through before the cancel took effect: the PR is merged." });
  }
}

/** Runs on every runner tick: moves each pre-approved merge that other steps' rows have carried to a new state. Writes nothing when nothing moved. */
export function advancePreapprovals(db: DatabaseSync, log: (line: string) => void = () => {}): number {
  const rows = db.prepare(`SELECT * FROM preapprovals WHERE state IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id`).all(...ACTIVE) as Row[];
  let n = 0;
  try {
    endStaleRequests(db);
    settleCancelled(db);
  } catch (e) {
    log(`preapproval requests: ${(e as Error).message}`);
  }
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

const mergeRunning = (db: DatabaseSync, repo: string): boolean => !!db.prepare("SELECT 1 FROM jobs WHERE repo = ? AND step = 'merge' AND state = 'running'").get(repo);
const inActiveBatch = (db: DatabaseSync, repo: string, n: number): boolean =>
  !!db.prepare("SELECT 1 FROM main.merge_batch_prs x JOIN main.merge_batches b ON b.id = x.batch_id WHERE b.repo = ? AND x.number = ? AND b.state IN ('checking', 'open')").get(repo, n);

/**
 * An operator cancels the PR's pre-approved merge before the merge queue has merged it. A queued PR in an integration batch is first
 * removed from the batch (the operator control: the batch PR is closed; the hold it sets is released) unless the merge is running.
 * Throws when there is none or the queue is past stopping it.
 */
export async function cancelPreapproval(db: DatabaseSync, by: string, repo: string, n: number, run?: Exec): Promise<Preapproval> {
  const p = db.prepare(`SELECT id FROM preapprovals WHERE repo = ? AND number = ? AND state IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`).get(repo, n, ...ACTIVE) as { id: number } | undefined;
  if (!p) throw new Error(`${repo}#${n} has no pre-approved merge in progress`);
  const state = (db.prepare("SELECT state FROM preapprovals WHERE id = ?").get(p.id) as { state: string }).state;
  // The state change and the take-back of the hand-over answer are one transaction, so the merge queue never sees a cancelled row with a live answer.
  const finish = () => {
    if (!cancelRow(db, p.id, by, `cancelled by ${by}`, `${by} cancelled the pre-approved merge.`, true)) throw new Error("the pre-approved merge changed a moment ago");
  };
  if (state === "queued" && inActiveBatch(db, repo, n)) {
    if (mergeRunning(db, repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
    // The removal holds the PR's merge; a hold that was there before stays, the one the removal set is released again after the row
    // is cancelled (so the queue never sees an unheld PR with a live Merge answer), also when the removal or the cancel fails.
    const heldBefore = !!db.prepare("SELECT 1 FROM main.merge_holds WHERE repo = ? AND number = ?").get(repo, n);
    try {
      const r = await removeFromBatch(db, by, repo, n, run);
      const b = db.prepare("SELECT state FROM main.merge_batches WHERE repo = ? AND branch = ? ORDER BY id DESC LIMIT 1").get(repo, r.batch) as { state: string } | undefined;
      if (b?.state === "merged") throw new Error("the PR is already merged: its batch merged");
      finish();
    } finally {
      if (!heldBefore) releaseMerge(db, by, repo, n);
    }
  } else finish();
  return preapprovalOf(db, repo, n)!;
}
