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
import { createIssue, IssueError, type Note, type Writer } from "../github/write.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { isQuiet } from "../security/quiet.ts";
import { settlesNow } from "../settlers.ts";
import { actRoom } from "./queue.ts";
import { conversationOf, insertTurn, systemBlock } from "./store.ts";

export type HeldState = "held" | "filing" | "filed" | "dropped" | "failed";
export type HeldRow = {
  id: number; card_id: number; choice_id: string | null; decision_id: string | null; preapproval_id: number | null;
  repo: string; number: number; issue_repo: string; title: string; body: string; by: string; at: string;
  state: HeldState; issue_number: number | null; url: string | null; reason: string | null; attempts: number; updated_at: string;
};

/** Refusals from GitHub before the row stops being tried; each failed try ends the Act job as failed, so the registered failure backoff spaces them. */
export const HELD_MAX_ATTEMPTS = 3;

/** Held issues come from conversation cards, which always run on the conversation prompt's first model (as src/conversations/act.ts posts them). */
const NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };
const ref = (repo: string, n: number) => `${repo}#${n}`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").trim().slice(0, 300);

export function holdFollowup(db: DatabaseSync, h: Pick<HeldRow, "card_id" | "choice_id" | "decision_id" | "preapproval_id" | "repo" | "number" | "issue_repo" | "title" | "body" | "by" | "at">): number {
  return Number(db.prepare(`INSERT INTO main.held_followups (card_id, choice_id, decision_id, preapproval_id, repo, number, issue_repo, title, body, by, at, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`).run(h.card_id, h.choice_id, h.decision_id, h.preapproval_id, h.repo, h.number, h.issue_repo, h.title, h.body, h.by, h.at, h.at).lastInsertRowid);
}

/** The item's held follow-ups, oldest first. */
export const heldOf = (db: DatabaseSync, repo: string, n: number): HeldRow[] =>
  db.prepare("SELECT * FROM main.held_followups WHERE repo = ? AND number = ? ORDER BY id").all(repo, n) as HeldRow[];

/** Why the merge path the row was held on has ended, or null while it stands. */
function pathEnded(db: DatabaseSync, h: HeldRow): string | null {
  if (h.preapproval_id !== null) {
    const p = db.prepare("SELECT state FROM main.preapprovals WHERE id = ?").get(h.preapproval_id) as { state: string } | undefined;
    if (!p) return "the pre-approved merge is gone";
    if (p.state === "asked") return "the pre-approved merge was handed back as a question";
    if (p.state === "cancelled" || p.state === "failed") return `the pre-approved merge was ${p.state}`;
    return null;
  }
  if (h.decision_id === null) return null;
  const d = getDecision(db, h.decision_id);
  if (!d) {
    const aside = db.prepare("SELECT answer_note FROM main.decisions WHERE id LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1").get(`${h.decision_id.replace(/[\\%_]/g, "\\$&")}~replaced-%`) as { answer_note: string | null } | undefined;
    return aside ? `the Merge answer was set aside${aside.answer_note ? `: ${aside.answer_note}` : ""}` : "the Merge question is gone";
  }
  if (d.answer === "merge") return null;
  if (d.answer === null) return "the Merge answer was taken back";
  return `the question was answered "${optionsOf(d).find((o) => o.key === d.answer)?.label ?? d.answer}"`;
}

/** What to do with a held row now: file it, drop it (with the reason), or keep holding (null). */
export function heldVerdict(db: DatabaseSync, h: HeldRow): { file: true } | { drop: string } | null {
  const it = db.prepare("SELECT state FROM main.items WHERE repo = ? AND number = ?").get(h.repo, h.number) as { state: string } | undefined;
  if (!it) return null;
  if (it.state === "CLOSED") return { drop: "the PR was closed without merging" };
  const ended = pathEnded(db, h);
  if (ended) return { drop: ended };
  return it.state === "MERGED" ? { file: true } : null;
}

/** The held rows of the PRs of `repo` that the Act step has to file or drop now. */
export function dueHeld(db: DatabaseSync, repo?: string): HeldRow[] {
  const rows = db.prepare(`SELECT * FROM main.held_followups WHERE state = 'held' ${repo ? "AND repo = ?" : ""} ORDER BY id`).all(...(repo ? [repo] : [])) as HeldRow[];
  return rows.filter((h) => heldVerdict(db, h) !== null);
}

/**
 * The repos whose Act job has held rows to file or drop now; `fits`: false when every one of them is to be filed and the daily count has
 * no room (the planner then wakes when room returns). Also the signature of that input for the planner.
 */
export function heldDue(db: DatabaseSync, ms: number = Date.now()): { repos: Map<string, boolean>; sig: string } {
  const room = actRoom(db, 1, ms);
  const repos = new Map<string, boolean>();
  for (const h of dueHeld(db)) {
    const v = heldVerdict(db, h);
    repos.set(h.repo, (repos.get(h.repo) ?? false) || room || (v !== null && "drop" in v));
  }
  return { repos, sig: repos.size ? `held:${[...repos].map(([r, f]) => `${r}=${f ? 1 : 0}`).join(",")}` : "" };
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
export type HeldSummary = { filed: number; dropped: number; failed: { ref: string; reason: string }[]; unknown: number; writes: number };

/**
 * Files or drops the due held follow-ups of the PRs of `repo`, oldest first. Each issue is one GitHub write of the Act step's shared daily
 * count (it goes out as a card write of the card that held it); the run stops at the first that finds no room, or past `writes` (what the
 * Act job still allows). A presser who no longer settles on the issue's repo, or a PR that turned quiet, drops the row; a missing approval
 * keeps it held with the reason. A create with an unknown outcome ends the run.
 */
export async function fileHeldFollowups(db: DatabaseSync, repo: string, deps: HeldDeps = {}, o: { writes?: number } = {}): Promise<HeldSummary> {
  const s: HeldSummary = { filed: 0, dropped: 0, failed: [], unknown: 0, writes: 0 };
  const now = () => (deps.now?.() ?? new Date());
  for (const h of dueHeld(db, repo)) {
    const at = now().toISOString();
    const v = heldVerdict(db, h);
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
