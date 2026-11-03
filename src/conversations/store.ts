// Conversation storage: the item block (written once), the turns in prompt order, and the cards of each Opus turn.
// Every turn stores the exact text its prompt block carries, so later prompts repeat earlier ones byte for byte.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { factsOf, optionsOf, type DecisionRow } from "../decisions.ts";
import { untrustedJson } from "../prompts/index.ts";
import { openDecision, type NewCard } from "./cards.ts";
import { ITEM_BODY_LIMIT, ITEM_COMMENT_LIMIT, ITEM_COMMENTS, ITEM_DIFF_LIMIT, MESSAGE_MAX, OPENING_MAX, type TurnKind } from "./types.ts";

export class ConversationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The pull request diff for the item block, or null (an issue, an unavailable or oversized diff). Injected: the default asks GitHub. */
export type DiffSource = (repo: string, number: number, head: string) => Promise<string | null>;
export type StoreDeps = { diff?: DiffSource; now?: () => Date };
const nowOf = (d?: StoreDeps) => (d?.now?.() ?? new Date()).toISOString();

export type ConversationRow = { repo: string; number: number; item_block: string; item_sig: string; created_at: string; created_by: string };
export type TurnRow = { id: number; repo: string; number: number; kind: TurnKind; login: string; at: string; body: string; block: string; status: string | null; error: string | null; notes: string | null };

export const conversationOf = (db: DatabaseSync, repo: string, n: number): ConversationRow | undefined =>
  db.prepare("SELECT * FROM conversations WHERE repo = ? AND number = ?").get(repo, n) as ConversationRow | undefined;

export const turnsOf = (db: DatabaseSync, repo: string, n: number): TurnRow[] =>
  db.prepare("SELECT * FROM conversation_turns WHERE repo = ? AND number = ? ORDER BY id").all(repo, n) as unknown as TurnRow[];

export const pendingTurn = (db: DatabaseSync, repo: string, n: number): TurnRow | undefined =>
  db.prepare("SELECT * FROM conversation_turns WHERE repo = ? AND number = ? AND kind = 'operator' AND status = 'pending'").get(repo, n) as TurnRow | undefined;

// ---- blocks ------------------------------------------------------------------

/** Text of operators and Opus must not close or open the frame the prompt puts around turns. */
const frameSafe = (t: string): string => t.replace(/<(\/?)(turn|item|actions|untrusted)\b/gi, "&lt;$1$2");

export function operatorBlock(login: string, text: string): string {
  return `<turn from="operator" login="${login.replace(/[^\w.-]/g, "")}">\n${frameSafe(text)}\n</turn>\n`;
}

export function opusBlock(text: string, cards: NewCard[]): string {
  const list = cards.map((c) => ({ ...c.params }));
  return `<turn from="opus">\n${frameSafe(text)}\n${cards.length ? `<actions>\n${JSON.stringify(list)}\n</actions>\n` : ""}</turn>\n`;
}

/** A turn from our code: a plain sentence and, when GitHub text is quoted, that data as untrusted JSON. */
export function systemBlock(text: string, data?: unknown): string {
  return `<turn from="system">\n${text}\n${data === undefined ? "" : `<untrusted>\n${untrustedJson(data)}\n</untrusted>\n`}</turn>\n`;
}

// ---- the item ----------------------------------------------------------------

type ItemRow = { repo: string; number: number; kind: string; state: string; title: string | null; body: string | null; author: string | null; author_association: string | null; labels: string | null; head_oid: string | null; additions: number | null; deletions: number | null; changed_files: number | null };

const itemRow = (db: DatabaseSync, repo: string, n: number): ItemRow | undefined =>
  db.prepare("SELECT repo, number, kind, state, title, body, author, author_association, labels, head_oid, additions, deletions, changed_files FROM items WHERE repo = ? AND number = ?").get(repo, n) as ItemRow | undefined;

/** Identifies the head commit and text a block or update turn described. */
const sigOf = (i: ItemRow): string => createHash("sha256").update(JSON.stringify([i.head_oid, i.title, i.body])).digest("hex").slice(0, 16);

const labelsOf = (i: ItemRow): string[] => {
  try { const l = JSON.parse(i.labels ?? "[]") as unknown; return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

const cut = (s: string | null, max: number): string => (s ?? "").slice(0, max);

function decisionPart(d: DecisionRow | undefined): unknown {
  if (!d) return null;
  return {
    question: d.question, facts: factsOf(d), summary: d.summary ?? "",
    options: optionsOf(d).map((o) => ({ key: o.key, label: o.label, hint: o.hint ?? "" })),
    recommended: d.recommended ?? null, recommended_reason: d.recommended_reason ?? null, answer: d.answer ?? null,
  };
}

/** The item block: everything about the item the conversation starts from, as untrusted JSON. Written once. */
export async function buildItemBlock(db: DatabaseSync, repo: string, n: number, deps?: StoreDeps): Promise<{ block: string; sig: string }> {
  const i = itemRow(db, repo, n);
  if (!i) throw new ConversationError(404, `no item ${repo}#${n} in the mirror`);
  const pr = i.kind === "pr";
  const comments = db.prepare(`SELECT author, body FROM comments WHERE repo = ? AND number = ? AND COALESCE(TRIM(body), '') <> ''
    AND COALESCE(author, '') NOT LIKE '%[bot]' ORDER BY created_at, id LIMIT ?`).all(repo, n, ITEM_COMMENTS) as { author: string | null; body: string }[];
  let diff: string | null = null;
  if (pr && i.head_oid && deps?.diff) diff = await deps.diff(repo, n, i.head_oid).catch(() => null);
  const data = {
    ref: `${repo}#${n}`, kind: pr ? "pull request" : "issue", state: i.state, title: i.title ?? "", body: cut(i.body, ITEM_BODY_LIMIT),
    author: i.author, author_association: i.author_association, labels: labelsOf(i),
    comments: comments.map((c) => ({ author: c.author, body: cut(c.body, ITEM_COMMENT_LIMIT) })),
    ...(pr ? { head: i.head_oid, lines: { additions: i.additions, deletions: i.deletions, files: i.changed_files }, diff: diff === null ? null : cut(diff, ITEM_DIFF_LIMIT) + (diff.length > ITEM_DIFF_LIMIT ? "\n[diff cut]" : "") } : {}),
    decision: decisionPart(openDecision(db, repo, n) ?? latestDecision(db, repo, n)),
  };
  return { block: untrustedJson(data), sig: sigOf(i) };
}

const latestDecision = (db: DatabaseSync, repo: string, n: number): DecisionRow | undefined =>
  db.prepare("SELECT * FROM decisions WHERE repo = ? AND number = ? AND id NOT LIKE '%:dupegroup:%' ORDER BY asked_at DESC, id DESC LIMIT 1").get(repo, n) as DecisionRow | undefined;

/** Creates the conversation with its item block when the item has none. Returns whether it was created. */
export async function ensureConversation(db: DatabaseSync, repo: string, n: number, by: string, deps?: StoreDeps): Promise<boolean> {
  if (conversationOf(db, repo, n)) return false;
  const { block, sig } = await buildItemBlock(db, repo, n, deps);
  return db.prepare("INSERT OR IGNORE INTO conversations (repo, number, item_block, item_sig, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(repo, n, block, sig, nowOf(deps), by).changes === 1;
}

// ---- turns -------------------------------------------------------------------

type NewTurn = { kind: TurnKind; login: string; body: string; block: string; status?: string | null; notes?: string[]; cards?: NewCard[] };

/**
 * Appends a turn. The operator turn that waits for its reply stays last: a turn added while it waits goes in front of it,
 * so the prompt keeps its order (earlier turns, then the new message). Returns the turn id.
 */
export function insertTurn(db: DatabaseSync, repo: string, n: number, t: NewTurn, deps?: StoreDeps): number {
  const insert = db.prepare("INSERT INTO conversation_turns (repo, number, kind, login, at, body, block, status, error, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    const wait = t.status === "pending" ? undefined : pendingTurn(db, repo, n);
    if (wait) db.prepare("DELETE FROM conversation_turns WHERE id = ?").run(wait.id);
    const id = Number(insert.run(repo, n, t.kind, t.login, nowOf(deps), t.body, t.block, t.status ?? null, null, t.notes?.length ? JSON.stringify(t.notes) : null).lastInsertRowid);
    for (const c of t.cards ?? []) {
      db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, repo, n, c.params.kind, JSON.stringify(c.params), c.text, c.description);
    }
    if (wait) insert.run(repo, n, wait.kind, wait.login, wait.at, wait.body, wait.block, wait.status, wait.error, wait.notes);
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Adds a system turn when the item's head commit or text differs from what the stored block or the last update turn described.
 * The block itself is never rewritten.
 */
export async function refreshItem(db: DatabaseSync, repo: string, n: number, deps?: StoreDeps): Promise<boolean> {
  const c = conversationOf(db, repo, n), i = itemRow(db, repo, n);
  if (!c || !i) return false;
  const sig = sigOf(i);
  if (sig === c.item_sig) return false;
  const pr = i.kind === "pr";
  let diff: string | null = null;
  if (pr && i.head_oid && deps?.diff) diff = await deps.diff(repo, n, i.head_oid).catch(() => null);
  const data = {
    title: i.title ?? "", body: cut(i.body, ITEM_BODY_LIMIT), state: i.state, labels: labelsOf(i),
    ...(pr ? { head: i.head_oid, lines: { additions: i.additions, deletions: i.deletions, files: i.changed_files }, diff: diff === null ? null : cut(diff, ITEM_DIFF_LIMIT) + (diff.length > ITEM_DIFF_LIMIT ? "\n[diff cut]" : "") } : {}),
  };
  const text = pr ? "The PR was updated: its head commit or text changed. The current state follows; it replaces the item block where they differ." : "The issue text was updated. The current text follows; it replaces the item block where they differ.";
  insertTurn(db, repo, n, { kind: "system", login: "system", body: text, block: systemBlock(text, data) }, deps);
  db.prepare("UPDATE conversations SET item_sig = ? WHERE repo = ? AND number = ?").run(sig, repo, n);
  return true;
}

/** An operator's message: creates the conversation when the item has none and queues the message for the Conversation step. */
export async function addOperatorMessage(db: DatabaseSync, repo: string, n: number, login: string, text: string, deps?: StoreDeps): Promise<number> {
  const body = text.trim();
  if (!body) throw new ConversationError(400, "the message is empty");
  if (body.length > MESSAGE_MAX) throw new ConversationError(400, `the message is longer than ${MESSAGE_MAX} characters`);
  if (!itemRow(db, repo, n)) throw new ConversationError(404, `no item ${repo}#${n} in the mirror`);
  if (pendingTurn(db, repo, n)) throw new ConversationError(409, "Opus has not answered the last message yet");
  await ensureConversation(db, repo, n, login, deps);
  await refreshItem(db, repo, n, deps);
  return insertTurn(db, repo, n, { kind: "operator", login, body, block: operatorBlock(login, body), status: "pending" }, deps);
}

/** Opus's opening turn (a question or proposal from the recommendation). Does nothing when the item already has a conversation. */
export async function startFromOpus(db: DatabaseSync, repo: string, n: number, opening: string, deps?: StoreDeps): Promise<boolean> {
  const text = opening.replace(/\r\n/g, "\n").trim().slice(0, OPENING_MAX);
  if (!text || conversationOf(db, repo, n) || !itemRow(db, repo, n)) return false;
  if (!(await ensureConversation(db, repo, n, "opus", deps))) return false;
  insertTurn(db, repo, n, { kind: "opus", login: "opus", body: text, block: opusBlock(text, []) }, deps);
  return true;
}

/** The pieces of the next prompt: the stored item block and the turn blocks, the pending message last. */
export function promptParts(db: DatabaseSync, repo: string, n: number): { item: string; turns: string; earlier: string; message: string } | null {
  const c = conversationOf(db, repo, n);
  const wait = pendingTurn(db, repo, n);
  if (!c || !wait) return null;
  const all = turnsOf(db, repo, n);
  const earlier = all.filter((t) => t.id !== wait.id).map((t) => t.block).join("");
  return { item: c.item_block, turns: earlier + wait.block, earlier, message: wait.block };
}

/** Stores Opus's reply to the pending message and marks the message answered. */
export function storeReply(db: DatabaseSync, repo: string, n: number, waitId: number, text: string, cards: NewCard[], notes: string[], deps?: StoreDeps): number {
  // Marked answered first: a pending message would keep itself last and put the reply in front of it.
  db.prepare("UPDATE conversation_turns SET status = 'answered', error = NULL WHERE id = ?").run(waitId);
  return insertTurn(db, repo, n, { kind: "opus", login: "opus", body: text, block: opusBlock(text, cards), notes, cards }, deps);
}

export function failTurn(db: DatabaseSync, waitId: number, error: string): void {
  db.prepare("UPDATE conversation_turns SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 300), waitId);
}

/** Conversations with a message waiting for Opus, oldest message first. */
export function pendingConversations(db: DatabaseSync): { repo: string; number: number; turnId: number }[] {
  return (db.prepare("SELECT repo, number, id AS turnId FROM conversation_turns WHERE kind = 'operator' AND status = 'pending' ORDER BY id").all() as { repo: string; number: number; turnId: number }[]);
}
