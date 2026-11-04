// Direction proposals: operators' notes (a decision's answer note, a comment on a closed item) are judged by a model;
// a draft waits on the dashboard until an operator accepts (with editable text) or dismisses it. Nothing becomes a direction without an operator.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "./agents/call.ts";
import { runModelStep } from "./agents/step.ts";
import { DIRECTIONS_PROPOSE } from "./agents/steps.ts";
import { pool } from "./classify/run.ts";
import { activeDirections, addDirection } from "./directions.ts";
import type { ProposalInput } from "./directions-types.ts";
import { CLAUDE_PROMPTS } from "./prompts/index.ts";
import { trackedNames } from "./repos.ts";

export const PROPOSAL_NOTE_MIN_CHARS = 20;
const PROMPT = CLAUDE_PROMPTS["directions.propose"];

export type ProposalState = "open" | "accepted" | "dismissed" | "none";
export type ProposalRow = {
  id: number; source: string; repo: string; number: number | null; decision_id: string | null; note: string; draft: string | null;
  state: ProposalState; created_at: string; decided_by: string | null; decided_at: string | null; direction_id: number | null;
};
export type DueNote = { source: string; repo: string; number: number | null; decisionId: string | null; note: string };

/**
 * Notes nobody has judged yet, oldest first, of tracked repos: answer notes of decisions an operator answered, and comments
 * an operator wrote on a closed item. Only notes newer than the setting `direction_proposals_since` count.
 */
export function dueNotes(db: DatabaseSync): DueNote[] {
  const repos = JSON.stringify(trackedNames(db));
  const since = (db.prepare("SELECT value FROM settings WHERE key = 'direction_proposals_since'").get() as { value: string } | undefined)?.value ?? "";
  const rows = db.prepare(`
    SELECT 'decision:' || d.id AS source, d.repo, d.number, d.id AS decisionId, trim(d.answer_note) AS note, d.answered_at AS at
    FROM decisions d JOIN access a ON a.login = d.answered_by AND a.role = 'operator'
    WHERE d.answer_note IS NOT NULL AND length(trim(d.answer_note)) >= :min AND d.answer NOT IN ('withdrawn', 'superseded') AND d.answered_at >= :since
      AND d.repo IN (SELECT value FROM json_each(:repos))
      AND NOT EXISTS (SELECT 1 FROM direction_proposals p WHERE p.source = 'decision:' || d.id)
    UNION ALL
    SELECT 'comment:' || c.id, c.repo, c.number, NULL, trim(c.body), c.created_at
    FROM comments c JOIN access a ON a.login = c.author AND a.role = 'operator' JOIN items i ON i.repo = c.repo AND i.number = c.number
    WHERE c.kind = 'comment' AND i.state = 'CLOSED' AND length(trim(c.body)) >= :min AND c.created_at >= :since
      AND c.repo IN (SELECT value FROM json_each(:repos))
      AND NOT EXISTS (SELECT 1 FROM direction_proposals p WHERE p.source = 'comment:' || c.id)
    ORDER BY at, source`).all({ min: PROPOSAL_NOTE_MIN_CHARS, since, repos }) as (DueNote & { at: string })[];
  return rows.map(({ at: _at, ...r }) => r);
}

function inputOf(db: DatabaseSync, n: DueNote): ProposalInput {
  const item = n.number === null ? null : (db.prepare("SELECT kind, title, state FROM items WHERE repo = ? AND number = ?").get(n.repo, n.number) as { kind: string; title: string; state: string } | undefined) ?? null;
  const d = n.decisionId ? (db.prepare("SELECT question, answer FROM decisions WHERE id = ?").get(n.decisionId) as { question: string; answer: string }) : null;
  return {
    ref: n.number === null ? n.repo : `${n.repo}#${n.number}`, repo: n.repo, item, decision: d ? { question: d.question, answer: d.answer } : null,
    note: n.note.slice(0, 2000), directions: activeDirections(db, n.repo).map((x) => x.text),
  };
}

export function saveProposal(db: DatabaseSync, n: DueNote, draft: string | null, at = new Date().toISOString()): void {
  db.prepare(`INSERT OR IGNORE INTO direction_proposals (source, repo, number, decision_id, note, draft, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n.source, n.repo, n.number, n.decisionId, n.note, draft, draft ? "open" : "none", at);
}

/** Judges the waiting notes, oldest first; returns how many were judged (stored as a draft or as none). */
export async function runProposals(db: DatabaseSync, p: { limit: number; usageRun: string; onHandled?: (n: number) => void; cancelled?: () => boolean }, log: (line: string) => void = console.log, deps: { model?: string } = {}): Promise<{ waiting: number; judged: number; drafts: number }> {
  const todo = dueNotes(db);
  const batch = todo.slice(0, Math.max(0, p.limit));
  let judged = 0, drafts = 0, handled = 0;
  await pool(batch.map((n, k) => async () => {
    if (p.cancelled?.()) return;
    const input = inputOf(db, n);
    const r = await runModelStep(db, DIRECTIONS_PROPOSE, input, {
      model: deps.model ?? PROMPT.models[0]!, cancelled: p.cancelled,
      usage: { run: p.usageRun, agent: `directions-${String(k).padStart(3, "0")}`, stage: "directions-propose", items: (ok) => (ok ? 1 : 0) },
    });
    p.onHandled?.(++handled);
    if (!r.ok) { log(`directions-propose: no valid answer for ${n.source}; judged again at the next run`); return; }
    saveProposal(db, n, r.value.draft);
    judged++;
    if (r.value.draft) drafts++;
  }), () => claudeRoom(db));
  log(`directions-propose: ${judged} of ${todo.length} notes judged, ${drafts} drafts`);
  return { waiting: todo.length, judged, drafts };
}

export class ProposalError extends Error {}

/** Accepts an open proposal: the (edited) text becomes a direction for the proposal's repo, or for every repo with `repo` '*'. */
export function acceptProposal(db: DatabaseSync, id: number, by: string, text?: string, repo?: string): number {
  const p = db.prepare("SELECT * FROM direction_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  if (!p) throw new ProposalError("no such proposal");
  if (p.state !== "open") throw new ProposalError(`the proposal is already ${p.state}`);
  const t = (text ?? p.draft ?? "").trim();
  if (!t) throw new ProposalError("a direction needs text");
  const dir = addDirection(db, repo ?? p.repo, t, by, p.decision_id);
  db.prepare("UPDATE direction_proposals SET state = 'accepted', decided_by = ?, decided_at = ?, direction_id = ? WHERE id = ?").run(by, new Date().toISOString(), dir, id);
  return dir;
}

export function dismissProposal(db: DatabaseSync, id: number, by: string): void {
  const r = db.prepare("UPDATE direction_proposals SET state = 'dismissed', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'").run(by, new Date().toISOString(), id);
  if (!r.changes) throw new ProposalError("no open proposal with that id");
}

export function openProposals(db: DatabaseSync, filter: { repo?: string; decisionId?: string } = {}): ProposalRow[] {
  return db.prepare(`SELECT * FROM direction_proposals WHERE state = 'open' AND (? IS NULL OR repo = ?) AND (? IS NULL OR decision_id = ?) ORDER BY id`)
    .all(filter.repo ?? null, filter.repo ?? null, filter.decisionId ?? null, filter.decisionId ?? null) as ProposalRow[];
}
