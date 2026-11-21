// Follow-up issues held until the merge. A card that merges the PR (a Merge answer, or a fix-up that merges: holdsIssues) does not open
// its issue at the press: it stores it here, and the Act step files it once the PR merged, whoever merged it. A PR closed without merging,
// or a merge path that ended (the Merge answer taken back, set aside or changed; the pre-approved merge cancelled, failed or handed back as
// a question), drops it. The Act step reads these rows when the planner sees the PR's state or the merge path change: no timer runs.
//
// Filing writes the `filing` row before the call. A create whose answer was lost leaves that row behind: the issue may exist, so it is never
// filed again and the item page says the outcome is unknown. Only a refusal from GitHub (no issue can exist) returns the row to `held`.
import type { DatabaseSync } from "node:sqlite";
import { guardRepo } from "../core/guard.ts";
import { getDecision, optionsOf } from "../decisions.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { createIssue, IssueError, PACE_MAX_WAIT_MS, type Note, type Writer } from "../github/write.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { isQuiet } from "../security/quiet.ts";
import { settlesNow } from "../settlers.ts";
import { actRoom } from "./queue.ts";
import { conversationOf, insertTurn, systemBlock } from "./store.ts";

export type HeldState = "held" | "filing" | "filed" | "dropped" | "failed";
export type HeldRow = {
  id: number; card_id: number; choice_id: string | null; decision_id: string | null; answer_seq: number | null; preapproval_id: number | null;
  repo: string; number: number; issue_repo: string; title: string; body: string; by: string; at: string;
  state: HeldState; issue_number: number | null; url: string | null; reason: string | null; attempts: number; updated_at: string;
};

/** Refusals from GitHub before the row stops being tried; each failed try ends the Act job as failed, so the registered failure backoff spaces them. */
export const HELD_MAX_ATTEMPTS = 3;

/** Held issues come from conversation cards, which always run on the conversation prompt's first model (as src/conversations/act.ts posts them). */
const NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };
const ref = (repo: string, n: number) => `${repo}#${n}`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").trim().slice(0, 300);

export function holdFollowup(db: DatabaseSync, h: Pick<HeldRow, "card_id" | "choice_id" | "decision_id" | "answer_seq" | "preapproval_id" | "repo" | "number" | "issue_repo" | "title" | "body" | "by" | "at">): number {
  return Number(db.prepare(`INSERT INTO main.held_followups (card_id, choice_id, decision_id, answer_seq, preapproval_id, repo, number, issue_repo, title, body, by, at, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`).run(h.card_id, h.choice_id, h.decision_id, h.answer_seq, h.preapproval_id, h.repo, h.number, h.issue_repo, h.title, h.body, h.by, h.at, h.at).lastInsertRowid);
}

/** The item's held follow-ups, oldest first. */
export const heldOf = (db: DatabaseSync, repo: string, n: number): HeldRow[] =>
  db.prepare("SELECT * FROM main.held_followups WHERE repo = ? AND number = ? ORDER BY id").all(repo, n) as HeldRow[];

/** Answer, undo and reopen audit rows of the decision: the card stores the count once it answered, and any later one ends its merge path. */
export const answerSeqOf = (db: DatabaseSync, decision: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM main.audit WHERE target = ? AND action IN ('answer', 'undo', 'reopen')").get(decision) as { n: number }).n;

type Ended = { why: string; at: string };

/**
 * Whether the merge path this row was held on has ended, why and when. The row is bound to the path its press made: the pre-approved merge
 * it started, or its Merge answer as the decision's answer history stood then, so a new answer or a new pre-approval never revives it.
 */
function pathEnded(db: DatabaseSync, h: HeldRow, nowIso: string): Ended | null {
  if (h.preapproval_id !== null) {
    const p = db.prepare("SELECT state, updated_at FROM main.preapprovals WHERE id = ?").get(h.preapproval_id) as { state: string; updated_at: string } | undefined;
    if (!p) return { why: "the pre-approved merge is gone", at: nowIso };
    if (p.state === "asked") return { why: "the pre-approved merge was handed back as a question", at: p.updated_at };
    if (p.state === "cancelled" || p.state === "failed") return { why: `the pre-approved merge was ${p.state}`, at: p.updated_at };
    return null;
  }
  if (h.decision_id === null) return null;
  const d = getDecision(db, h.decision_id);
  if (!d) {
    const aside = db.prepare("SELECT answer_note, applied_at FROM main.decisions WHERE id LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1").get(`${h.decision_id.replace(/[\\%_]/g, "\\$&")}~replaced-%`) as { answer_note: string | null; applied_at: string | null } | undefined;
    return aside ? { why: `the Merge answer was set aside${aside.answer_note ? `: ${aside.answer_note}` : ""}`, at: aside.applied_at ?? nowIso } : { why: "the Merge question is gone", at: nowIso };
  }
  const later = h.answer_seq === null ? undefined
    : db.prepare("SELECT action, at FROM main.audit WHERE target = ? AND action IN ('answer', 'undo', 'reopen') ORDER BY rowid LIMIT 1 OFFSET ?").get(h.decision_id, h.answer_seq) as { action: string; at: string } | undefined;
  if (later) return { why: later.action === "answer" ? "the Merge question was answered again" : later.action === "undo" ? "the Merge answer was taken back" : "the Merge question was reopened", at: later.at };
  if (d.answer === "merge") return null;
  const why = d.answer === null ? "the Merge answer was taken back" : `the question was answered "${optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer}"`;
  return { why, at: d.answered_at ?? nowIso };
}

/**
 * What to do with a held row now: file it, drop it (with the reason), or keep holding (null). A merged PR files unless its path ended before
 * the merge: a pre-approval the merge itself cancelled ("merged before the fix-up finished") does not count.
 */
export function heldVerdict(db: DatabaseSync, h: HeldRow, nowIso: string = new Date().toISOString()): { file: true } | { drop: string } | null {
  const it = db.prepare("SELECT state, merged_at FROM main.items WHERE repo = ? AND number = ?").get(h.repo, h.number) as { state: string; merged_at: string | null } | undefined;
  if (!it) return null;
  if (it.state === "CLOSED") return { drop: "the PR was closed without merging" };
  const ended = pathEnded(db, h, nowIso);
  if (it.state !== "MERGED") return ended ? { drop: ended.why } : null;
  const mergedAt = it.merged_at ?? nowIso;
  return ended && Date.parse(ended.at) < Date.parse(mergedAt) ? { drop: ended.why } : { file: true };
}

/** A row left in `filing` past this was not being filed any more (a create takes seconds; the write pacing waits at most PACE_MAX_WAIT_MS). */
export const HELD_STUCK_MS = Math.max(10 * 60_000, 4 * PACE_MAX_WAIT_MS);

/**
 * What the audit row of a row left in `filing` tells: "filed" (with the issue) when the create finished with a URL, "held" when no write
 * was ever recorded for it (nothing was sent), null when the outcome stays unknown.
 */
export function filingOutcome(db: DatabaseSync, h: HeldRow, ms: number = Date.now()): { state: "filed"; number: number; url: string } | { state: "held" } | null {
  if (h.state !== "filing" || Date.parse(h.updated_at) > ms - HELD_STUCK_MS) return null;
  const a = db.prepare("SELECT details FROM main.audit WHERE action = 'act-open-issue' AND json_valid(details) AND json_extract(details, '$.held') = ? AND at >= ? ORDER BY rowid DESC LIMIT 1").get(h.id, h.updated_at) as { details: string } | undefined;
  if (!a) return { state: "held" };
  const d = JSON.parse(a.details) as { state?: string; url?: string };
  const m = d.state === "done" ? /\/issues\/(\d+)/.exec(d.url ?? "") : null;
  return m ? { state: "filed", number: Number(m[1]), url: d.url! } : null;
}

/** The held rows of the PRs of `repo` that the Act step has to file or drop now. */
export function dueHeld(db: DatabaseSync, repo?: string): HeldRow[] {
  const rows = db.prepare(`SELECT * FROM main.held_followups WHERE state IN ('held', 'filing') ${repo ? "AND repo = ?" : ""} ORDER BY id`).all(...(repo ? [repo] : [])) as HeldRow[];
  return rows.filter((h) => (h.state === "filing" ? filingOutcome(db, h) !== null : heldVerdict(db, h) !== null));
}

/**
 * The repos whose Act job has held rows to file or drop now; `fits`: false when every one of them is to be filed and the daily count has
 * no room (the planner then wakes when room returns). Also the signature of that input for the planner.
 */
export function heldDue(db: DatabaseSync, ms: number = Date.now()): { repos: Map<string, boolean>; sig: string } {
  const room = actRoom(db, 1, ms);
  const repos = new Map<string, boolean>();
  for (const h of dueHeld(db)) {
    const v = h.state === "filing" ? null : heldVerdict(db, h);
    repos.set(h.repo, (repos.get(h.repo) ?? false) || room || h.state === "filing" || (v !== null && "drop" in v));
  }
  return { repos, sig: repos.size ? `held:${[...repos].map(([r, f]) => `${r}=${f ? 1 : 0}`).join(",")}` : "" };
}

/** When rows in `filing` become old enough for filingOutcome to settle them: the planner wakes then. */
export function filingWakes(db: DatabaseSync, ms: number = Date.now()): number[] {
  return (db.prepare("SELECT updated_at FROM main.held_followups WHERE state = 'filing'").all() as { updated_at: string }[])
    .map((r) => Date.parse(r.updated_at) + HELD_STUCK_MS).filter((t) => t > ms);
}

/** The PR's thread line (when it has a conversation): what became of the held issue. */
function say(db: DatabaseSync, h: HeldRow, text: string): void {
  if (conversationOf(db, h.repo, h.number)) insertTurn(db, h.repo, h.number, { kind: "system", login: "system", body: text, block: systemBlock(text) });
}

function drop(db: DatabaseSync, h: HeldRow, reason: string, at: string): boolean {
  const r = db.prepare("UPDATE main.held_followups SET state = 'dropped', reason = ?, updated_at = ? WHERE id = ? AND state = 'held'").run(reason, at, h.id);
  if (r.changes !== 1) return false;
  say(db, h, `The issue "${h.title}" held for after the merge is dropped: ${reason}.`);
  return true;
}

export type HeldDeps = { exec?: Exec; now?: () => Date };
/** `paced`: the write pacing's message when it held a create back (the job fails with it, as other paced jobs do). */
export type HeldSummary = { filed: number; dropped: number; failed: { ref: string; reason: string }[]; unknown: number; writes: number; paced?: string };

/**
 * Files or drops the due held follow-ups of the PRs of `repo`, oldest first. Each issue is one GitHub write of the Act step's shared daily
 * count (it goes out as a card write of the card that held it); the run stops at the first that finds no room, or past `writes` (what the
 * Act job still allows). A presser who no longer settles on the issue's repo, or a PR that turned quiet, drops the row; a missing approval
 * keeps it held with the reason. A create with an unknown outcome, or one the write pacing held back, ends the run. A row a stopped process left
 * in `filing` is settled from its audit row (filingOutcome). held_followups is not planner input, so these row writes never re-queue the job.
 */
export async function fileHeldFollowups(db: DatabaseSync, repo: string, deps: HeldDeps = {}, o: { writes?: number } = {}): Promise<HeldSummary> {
  const s: HeldSummary = { filed: 0, dropped: 0, failed: [], unknown: 0, writes: 0 };
  const now = () => (deps.now?.() ?? new Date());
  for (const h of dueHeld(db, repo)) {
    const at = now().toISOString();
    if (h.state === "filing") {
      // Left behind by a stopped process: its audit row says whether the create finished, or never went out.
      const f = filingOutcome(db, h, now().getTime());
      if (f?.state === "filed") { db.prepare("UPDATE main.held_followups SET state = 'filed', issue_number = ?, url = ?, reason = NULL, updated_at = ? WHERE id = ? AND state = 'filing'").run(f.number, f.url, at, h.id); s.filed++; }
      else if (f?.state === "held") db.prepare("UPDATE main.held_followups SET state = 'held', attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ? AND state = 'filing'").run(at, h.id);
      continue;
    }
    const v = heldVerdict(db, h, at);
    if (!v) continue;
    if ("drop" in v) { if (drop(db, h, v.drop, at)) s.dropped++; continue; }
    if (isQuiet(db, h.repo, h.number)) { if (drop(db, h, "the pull request is quiet until its fix is published", at)) s.dropped++; continue; }
    if (!settlesNow(db, h.by, [h.issue_repo])) { if (drop(db, h, `${h.by} no longer has write access to ${h.issue_repo}`, at)) s.dropped++; continue; }
    const g = guardRepo(db, h.issue_repo, "comment", { operator: h.by }, undefined, h.by);
    if ("refused" in g) {
      db.prepare("UPDATE main.held_followups SET reason = ? WHERE id = ? AND state = 'held'").run(g.refused, h.id);
      continue;
    }
    if ((o.writes !== undefined && s.writes >= o.writes) || !actRoom(db, 1, now().getTime())) break;
    const attempts = h.attempts + 1;
    if (db.prepare("UPDATE main.held_followups SET state = 'filing', attempts = ?, updated_at = ? WHERE id = ? AND state = 'held'").run(attempts, at, h.id).changes !== 1) continue;
    s.writes++;
    const w: Writer = { db, login: h.by };
    let made: { number: number; url: string };
    try {
      made = await createIssue(w, g, deps.exec ?? defaultExec, { repo: h.issue_repo, target: ref(h.repo, h.number), title: h.title, body: h.body, action: "act-open-issue" }, NOTE, { source: "conversation", card: h.card_id, held: h.id });
    } catch (e) {
      const reason = oneLine(e);
      // The network or GitHub is likely failing: the rest waits for the next run.
      if (!(e instanceof IssueError) || !e.clear) { s.unknown++; break; }
      // The write pacing sent nothing: no try is counted; the job fails with the pacing message, which the failure backoff ignores, so the next pass runs it again.
      if (e.paced) {
        db.prepare("UPDATE main.held_followups SET state = 'held', attempts = ? WHERE id = ? AND state = 'filing'").run(h.attempts, h.id);
        s.paced = reason;
        break;
      }
      const end = attempts >= HELD_MAX_ATTEMPTS;
      db.prepare("UPDATE main.held_followups SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = 'filing'").run(end ? "failed" : "held", reason, now().toISOString(), h.id);
      if (end) say(db, h, `The issue "${h.title}" held for after the merge could not be opened: ${reason}.`);
      s.failed.push({ ref: ref(h.repo, h.number), reason });
      continue;
    }
    db.prepare("UPDATE main.held_followups SET state = 'filed', issue_number = ?, url = ?, reason = NULL, updated_at = ? WHERE id = ?").run(made.number, made.url, now().toISOString(), h.id);
    say(db, h, `The PR merged: opened ${ref(h.issue_repo, made.number)}, the issue "${h.title}" held for after the merge.`);
    s.filed++;
  }
  return s;
}
