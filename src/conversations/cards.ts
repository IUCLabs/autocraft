// Action cards: what Opus may propose, checked by our code, and the one-line description of each that the operator reads.
// Descriptions are built here from the parameters; the model never writes them.
import type { DatabaseSync } from "node:sqlite";
import { optionsOf, type DecisionRow } from "../decisions.ts";
import { ALL_LABELS, sameLabel } from "../labels/set.ts";
import { COMMENT_MAX, type CardKind } from "./types.ts";

export type CardParams =
  | { kind: "comment"; text: string }
  | { kind: "answer"; option: string }
  | { kind: "label"; label: string }
  | { kind: "backlog" }
  | { kind: "duplicate"; of: number };

export type NewCard = { params: CardParams; text: string | null; description: string };

const ref = (repo: string, n: number) => `${repo}#${n}`;

/** The item's open decision: the newest unanswered one that is about this item alone and is not a duplicate-group decision. */
export function openDecision(db: DatabaseSync, repo: string, n: number): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM decisions WHERE repo = ? AND number = ? AND answer IS NULL AND id NOT LIKE '%:dupegroup:%'
    ORDER BY asked_at DESC, id DESC LIMIT 1`).get(repo, n) as DecisionRow | undefined;
}

export function describe(db: DatabaseSync, repo: string, n: number, p: CardParams): string {
  const it = ref(repo, n);
  switch (p.kind) {
    case "comment": return `Post the comment below on ${it}`;
    case "answer": {
      const d = openDecision(db, repo, n);
      const o = d ? optionsOf(d).find((x) => x.key === p.option) : undefined;
      return `Answer the open decision on ${it} with "${o?.label ?? p.option}"`;
    }
    case "label": return `Add the label "${p.label}" to ${it}`;
    case "backlog": return `Put ${it} in the Backlog: nothing is written to GitHub and no later step takes it up`;
    case "duplicate": return `Comment "Duplicate of #${p.of}." on ${it} and close it as a duplicate of ${ref(repo, p.of)}`;
  }
}

/** Model text for a public comment: no @mentions, whitespace at the ends trimmed. */
export const cleanComment = (s: string): string => s.replace(/@(?=\w)/g, "").trim();

/** One card as the model wrote it, checked against the item, or why it is dropped. */
export function validateCard(db: DatabaseSync, repo: string, n: number, raw: unknown): { card: NewCard } | { note: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a card that is not an object" };
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  const done = (params: CardParams, text: string | null = null): { card: NewCard } => ({ card: { params, text, description: describe(db, repo, n, params) } });
  switch (kind as CardKind) {
    case "comment": {
      const text = typeof c.text === "string" ? cleanComment(c.text) : "";
      if (!text) return { note: "dropped a comment card without text" };
      if (text.length > COMMENT_MAX) return { note: `dropped a comment card longer than ${COMMENT_MAX} characters` };
      return done({ kind: "comment", text }, text);
    }
    case "answer": {
      const d = openDecision(db, repo, n);
      if (!d) return { note: "dropped an answer card: the item has no open decision" };
      if (typeof c.option !== "string" || !optionsOf(d).some((o) => o.key === c.option)) return { note: `dropped an answer card: "${String(c.option).slice(0, 40)}" is not an option of the open decision` };
      return done({ kind: "answer", option: c.option });
    }
    case "label": {
      const l = typeof c.label === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, c.label as string)) : undefined;
      if (!l) return { note: `dropped a label card: "${String(c.label).slice(0, 40)}" is not a label the pipeline manages` };
      return done({ kind: "label", label: l.name });
    }
    case "backlog":
      if (!openDecision(db, repo, n)) return { note: "dropped a Backlog card: the item has no open decision" };
      return done({ kind: "backlog" });
    case "duplicate": {
      const of = c.of;
      if (!Number.isInteger(of) || of === n) return { note: "dropped a duplicate card without another item number" };
      if (!db.prepare("SELECT 1 FROM items WHERE repo = ? AND number = ?").get(repo, of as number)) return { note: `dropped a duplicate card: ${ref(repo, of as number)} is not in the mirror` };
      return done({ kind: "duplicate", of: of as number });
    }
    default:
      return { note: `dropped a card with unknown action "${String(kind).slice(0, 40)}"` };
  }
}

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

const MAX_CARDS = 8;
const FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

/** The reply's text and its valid cards. A reply with no text gets null. */
export function parseReply(db: DatabaseSync, repo: string, n: number, reply: string): Parsed | null {
  const m = FENCE.exec(reply.trimEnd());
  const text = (m ? reply.trimEnd().slice(0, m.index) : reply).trim();
  if (!text) return null;
  const notes: string[] = [];
  const cards: NewCard[] = [];
  if (m) {
    let list: unknown;
    try { list = JSON.parse(m[1]!); } catch { list = null; }
    if (!Array.isArray(list)) notes.push("dropped the actions block: it is not a JSON list");
    else {
      for (const raw of list.slice(0, 20)) {
        const v = validateCard(db, repo, n, raw);
        if (!("card" in v)) notes.push(v.note);
        else if (cards.length < MAX_CARDS) cards.push(v.card);
        else notes.push(`dropped a card beyond the ${MAX_CARDS} allowed per reply`);
      }
      if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
    }
  }
  return { text, cards, notes };
}
