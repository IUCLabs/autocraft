// Action cards: what Opus may propose, checked by our code, and the one-line description of each that the operator reads.
// Descriptions are built here from the parameters; the model never writes them.
import { REFERENCE_LEAK } from "../review/opus-parse.ts";
import type { DatabaseSync } from "node:sqlite";
import { writeEffect } from "../act/index.ts";
import { optionsOf, getDecision, type DecisionRow, type Kind } from "../decisions.ts";
import { backlogHeldSql, notOwnIntegrationSql } from "../dupes/held.ts";
import { ALL_LABELS, isTypeLabel, sameLabel } from "../labels/set.ts";
import { pilotSql } from "../pilot.ts";
import { CLOSE_REASONS, COMMENT_MAX, RESOLVE_MAX, type CardKind, type CloseReason } from "./types.ts";

export type CardParams =
  | { kind: "comment"; text: string }
  | { kind: "answer"; option: string; decision: string; stamp?: string }
  | { kind: "label"; label: string }
  | { kind: "backlog"; decision: string; stamp?: string }
  | { kind: "duplicate"; of: number }
  | { kind: "resolve"; decision: string; summary: string; stamp?: string }
  | { kind: "close"; reason: CloseReason; pr: boolean };

export type NewCard = { params: CardParams; text: string | null; description: string };

const ref = (repo: string, n: number) => `${repo}#${n}`;

/** The item's open decision: the newest unanswered one that is about this item alone and is not a duplicate-group decision. */
export function openDecision(db: DatabaseSync, repo: string, n: number): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM decisions WHERE repo = ? AND number = ? AND answer IS NULL AND id NOT LIKE '%:dupegroup:%'
    ORDER BY asked_at DESC, id DESC LIMIT 1`).get(repo, n) as DecisionRow | undefined;
}

/** Identifies the state of a decision a card was written for: its ask time and how often it was answered, undone or reopened. A re-ask or Reopen keeps the id, so the id alone cannot tell. */
export function decisionStamp(db: DatabaseSync, d: DecisionRow): string {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE target = ? AND action IN ('answer', 'undo', 'reopen')").get(d.id) as { n: number }).n;
  return `${d.asked_at}|${n}`;
}

/** The GitHub write that answering with this card's option causes later (the Act step does it), or null when it writes nothing. */
export function cardEffect(db: DatabaseSync, p: CardParams): string | null {
  if (p.kind === "close") return p.pr ? "closes the PR on GitHub" : `closes the issue as ${p.reason === "completed" ? "completed" : "not planned"} on GitHub`;
  if (p.kind !== "answer" || !p.decision) return null;
  const d = getDecision(db, p.decision);
  return d ? writeEffect(d.kind as Kind, p.option) : null;
}

/** The primary button's label: the action in a few words, from the parameters and the item. */
export function buttonLabel(db: DatabaseSync, p: CardParams): string {
  switch (p.kind) {
    case "comment": return "Post comment";
    case "answer": {
      const d = getDecision(db, p.decision);
      const o = d ? optionsOf(d).find((x) => x.key === p.option) : undefined;
      return `Answer "${o?.label ?? p.option}"`;
    }
    case "label": return "Add label";
    case "backlog": return "Move to Backlog";
    case "resolve": return "Close decision";
    case "duplicate": return "Close as duplicate";
    case "close": return p.pr ? "Close PR" : "Close issue";
  }
}

export function describe(db: DatabaseSync, repo: string, n: number, p: CardParams, text: string | null = null): string {
  const it = ref(repo, n);
  switch (p.kind) {
    case "comment": return `Post the comment below on ${it}`;
    case "answer": {
      const d = getDecision(db, p.decision);
      const o = d ? optionsOf(d).find((x) => x.key === p.option) : undefined;
      const effect = cardEffect(db, p);
      return `Answer the open decision on ${it} with "${o?.label ?? p.option}"${effect ? ` (${effect})` : ""}`;
    }
    case "label": return `Add the label "${p.label}" to ${it}`;
    case "backlog": return `Put ${it} in the Backlog: nothing is written to GitHub and no later step takes it up`;
    case "resolve": return `Close the open decision on ${it} as handled in the conversation ("${p.summary}"): nothing is written to GitHub`;
    case "close": {
      const how = p.pr ? "" : p.reason === "completed" ? " as completed" : " as not planned";
      return `${text ? `Post the comment below on ${it}, then close` : "Close"} ${it}${how}; its open decisions are closed as handled`;
    }
    case "duplicate": return `Comment "Duplicate of #${p.of}." on ${it} and close it as a duplicate of ${ref(repo, p.of)}`;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", num: "#", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", colon: ":", sol: "/", period: ".", excl: "!", bsol: "\\" };

/** Decodes numeric and the common named HTML entities, also when encoded twice (`&amp;#64;`). */
export function decodeEntities(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,8}));?/gi, (m, d: string | undefined, h: string | undefined, name: string | undefined) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? m;
      const cp = d ? Number(d) : parseInt(h!, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Model text for a public comment, cleaned like the Act step's comments: entities decoded first (so `&#64;user` cannot notify),
 * then raw HTML, images, links (Markdown, autolinks and bare URLs, keeping a Markdown link's text), cross-repo references and every
 * @ removed. An operator who edits a card may add links back.
 */
export function cleanComment(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = decodeEntities(t)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "")
      .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
      .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "")
      .replace(/<\/?[a-z!][^>]*>/gi, "")
      .replace(/<?\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>]*>?/gi, "")
      .replace(/\b[\w.-]+\/[\w.-]+#\d+/g, "")
      .replace(/[@\uFF20\uFE6B]/g, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Why Act would not close this item (an integration PR of ours, held by Backlog, outside the pilot), or null. */
export function closeRefusal(db: DatabaseSync, repo: string, n: number): string | null {
  const has = (cond: string) => !!db.prepare(`SELECT 1 FROM items i WHERE i.repo = ? AND i.number = ? AND ${cond}`).get(repo, n);
  if (!has("1 = 1")) return `${ref(repo, n)} is not in the mirror`;
  if (!has(notOwnIntegrationSql("i"))) return `${ref(repo, n)} is an integration PR the pipeline opened`;
  if (!has(pilotSql("i"))) return `${ref(repo, n)} is outside the pilot`;
  if (has(backlogHeldSql("i"))) return `${ref(repo, n)} is held by a Backlog answer`;
  return null;
}

/** The type label the item has besides `label` (type labels are exclusive), or null. */
export function otherTypeLabel(db: DatabaseSync, repo: string, n: number, label: string): string | null {
  if (!isTypeLabel(label)) return null;
  const row = db.prepare("SELECT labels FROM items WHERE repo = ? AND number = ?").get(repo, n) as { labels: string | null } | undefined;
  let have: unknown[] = [];
  try { have = JSON.parse(row?.labels ?? "[]") as unknown[]; } catch { /* unreadable labels count as none */ }
  return have.map(String).find((l) => isTypeLabel(l) && !sameLabel(l, label)) ?? null;
}

/** One card as the model wrote it, checked against the item, or why it is dropped. */
export function validateCard(db: DatabaseSync, repo: string, n: number, raw: unknown, drop: ReadonlySet<string> = new Set()): { card: NewCard } | { note: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a card that is not an object" };
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  const done = (params: CardParams, text: string | null = null): { card: NewCard } => ({ card: { params, text, description: describe(db, repo, n, params, text) } });
  switch (kind as CardKind) {
    case "comment": {
      const text = typeof c.text === "string" ? cleanComment(c.text) : "";
      if (!text) return { note: "dropped a comment card without text" };
      if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a comment card that mentions the reference folder or its documentation" };
      if (text.length > COMMENT_MAX) return { note: `dropped a comment card longer than ${COMMENT_MAX} characters` };
      return done({ kind: "comment", text }, text);
    }
    case "answer": {
      const d = openDecision(db, repo, n);
      if (!d) return { note: "dropped an answer card: the item has no open decision" };
      if (typeof c.option !== "string" || !optionsOf(d).some((o) => o.key === c.option)) return { note: `dropped an answer card: "${String(c.option).slice(0, 40)}" is not an option of the open decision` };
      return done({ kind: "answer", option: c.option, decision: d.id, stamp: decisionStamp(db, d) });
    }
    case "label": {
      const l = typeof c.label === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, c.label as string)) : undefined;
      if (!l) return { note: `dropped a label card: "${String(c.label).slice(0, 40)}" is not a label the pipeline manages` };
      const other = otherTypeLabel(db, repo, n, l.name);
      if (other) return { note: `dropped a label card: the item already has the type label "${other}" and an item has one type label` };
      return done({ kind: "label", label: l.name });
    }
    case "backlog": {
      const d = openDecision(db, repo, n);
      if (!d) return { note: "dropped a Backlog card: the item has no open decision" };
      return done({ kind: "backlog", decision: d.id, stamp: decisionStamp(db, d) });
    }
    case "resolve": {
      const d = openDecision(db, repo, n);
      if (!d) return { note: "dropped a resolve card: the item has no open decision" };
      const summary = typeof c.summary === "string" ? cleanComment(c.summary).replace(/\s+/g, " ") : "";
      if (!summary) return { note: "dropped a resolve card without a summary" };
      if (REFERENCE_LEAK.test(summary)) return { note: "dropped a resolve card that mentions the reference folder or its documentation" };
      if (summary.length > RESOLVE_MAX) return { note: `dropped a resolve card with a summary longer than ${RESOLVE_MAX} characters` };
      return done({ kind: "resolve", decision: d.id, summary, stamp: decisionStamp(db, d) });
    }
    case "duplicate": {
      const of = c.of;
      if (!Number.isInteger(of) || of === n) return { note: "dropped a duplicate card without another item number" };
      if (!db.prepare("SELECT 1 FROM items WHERE repo = ? AND number = ?").get(repo, of as number)) return { note: `dropped a duplicate card: ${ref(repo, of as number)} is not in the mirror` };
      const why = closeRefusal(db, repo, n);
      if (why) return { note: `dropped a duplicate card: ${why}` };
      return done({ kind: "duplicate", of: of as number });
    }
    case "close": {
      const reason = c.reason;
      if (!CLOSE_REASONS.includes(reason as CloseReason)) return { note: "dropped a close card without the reason completed or not_planned" };
      const why = closeRefusal(db, repo, n);
      if (why) return { note: `dropped a close card: ${why}` };
      const row = db.prepare("SELECT kind, state FROM items WHERE repo = ? AND number = ?").get(repo, n) as { kind: string; state: string };
      if (row.state !== "OPEN") return { note: `dropped a close card: ${ref(repo, n)} is not open` };
      let text: string | null = null;
      if (c.text !== undefined && c.text !== null && c.text !== "") {
        text = typeof c.text === "string" ? cleanComment(c.text) : "";
        if (!text) return { note: "dropped a close card whose comment is empty after cleaning" };
        if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a close card whose comment mentions the reference folder or its documentation" };
        if (text.length > COMMENT_MAX) return { note: `dropped a close card whose comment is longer than ${COMMENT_MAX} characters` };
      }
      const pr = row.kind === "pr";
      return done({ kind: "close", reason: reason as CloseReason, pr }, text);
    }
    default:
      return { note: `dropped a card with unknown action "${String(kind).slice(0, 40)}"` };
  }
}

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

const MAX_CARDS = 8;
const FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

/** The cleaned text of each comment card of a reply, with its field (`cards[i].text`, i the position in the actions block), for the reference checks. */
export function commentTexts(reply: string): { field: string; text: string }[] {
  const m = FENCE.exec(reply.trimEnd());
  if (!m) return [];
  let list: unknown;
  try { list = JSON.parse(m[1]!); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).flatMap((c: { kind?: unknown; text?: unknown }, i) => {
    const text = c && (c.kind === "comment" || c.kind === "close") && typeof c.text === "string" ? cleanComment(c.text) : "";
    return text ? [{ field: `cards[${i}].text`, text }] : [];
  });
}

/** The reply's text and its valid cards. A reply with no text gets null. `drop`: cleaned comment texts the reply lint still flagged after the fix turn; their cards are dropped. */
export function parseReply(db: DatabaseSync, repo: string, n: number, reply: string, drop: ReadonlySet<string> = new Set()): Parsed | null {
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
        const v = validateCard(db, repo, n, raw, drop);
        if (!("card" in v)) notes.push(v.note);
        else if (cards.length < MAX_CARDS) cards.push(v.card);
        else notes.push(`dropped a card beyond the ${MAX_CARDS} allowed per reply`);
      }
      if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
    }
  }
  return { text, cards, notes };
}
