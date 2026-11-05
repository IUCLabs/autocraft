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

/** One GitHub write of a resolution. The comment step's text is the card's `text`. */
export type Step =
  | { kind: "comment" }
  | { kind: "label"; label: string }
  | { kind: "close"; reason: CloseReason; pr: boolean }
  | { kind: "duplicate"; of: number };

/** How a resolution ends the item's open decision. `stamp` identifies the decision state it was written for. */
export type Settle =
  | { kind: "answer"; decision: string; option: string; stamp: string }
  | { kind: "handled"; decision: string; summary: string; stamp: string }
  | { kind: "backlog"; decision: string; stamp: string };

/** The legacy kinds (everything below `resolution`) stay runnable for cards stored before resolutions; new Opus output only produces `resolution`. */
export type CardParams =
  | { kind: "resolution"; steps: Step[]; settle: Settle | null }
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

const closeEffect = (p: { reason: CloseReason; pr: boolean }): string => p.pr ? "closes the PR on GitHub" : `closes the issue as ${p.reason === "completed" ? "completed" : "not planned"} on GitHub`;
const decisionWrite = (db: DatabaseSync, decision: string, option: string): string | null => {
  const d = getDecision(db, decision);
  return d ? writeEffect(d.kind as Kind, option) : null;
};

/** The GitHub write that answering with this card's option causes later (the Act step does it), or null when it writes nothing. For a resolution: every closing write it makes, joined. */
export function cardEffect(db: DatabaseSync, p: CardParams): string | null {
  if (p.kind === "resolution") {
    const parts: string[] = [];
    for (const st of p.steps) {
      if (st.kind === "close") parts.push(closeEffect(st));
      else if (st.kind === "duplicate") parts.push("closes it as a duplicate on GitHub");
    }
    if (p.settle?.kind === "answer") {
      const w = decisionWrite(db, p.settle.decision, p.settle.option);
      if (w) parts.push(w);
    }
    return parts.length ? parts.join("; ") : null;
  }
  if (p.kind === "close") return closeEffect(p);
  if (p.kind !== "answer" || !p.decision) return null;
  return decisionWrite(db, p.decision, p.option);
}

/** The word for a decision in the card lines: "scope", "close", "merge" ... ; "open" for kinds without a name of their own. */
const questionWord = (d: DecisionRow | undefined): string => (d && d.kind !== "other" ? d.kind : "open");
const optionLabel = (d: DecisionRow | undefined, key: string): string => (d ? optionsOf(d).find((x) => x.key === key)?.label : undefined) ?? key;

/** One plain line for a step. */
export function stepLine(st: Step): string {
  switch (st.kind) {
    case "comment": return "Post the comment below";
    case "label": return `Add the label "${st.label}"`;
    case "close": return st.pr ? "Close the PR" : `Close the issue as ${st.reason === "completed" ? "completed" : "not planned"}`;
    case "duplicate": return `Close as a duplicate of #${st.of}`;
  }
}

/** One plain line for how a card ends the open decision. */
export function settleLine(db: DatabaseSync, s: Settle): string {
  const d = getDecision(db, s.decision);
  switch (s.kind) {
    case "answer": return `Answers the ${questionWord(d)} question with "${optionLabel(d, s.option)}"`;
    case "handled": return `Closes the ${questionWord(d)} question as handled`;
    case "backlog": return "Moves the item to the Backlog";
  }
}

/** The steps and settlement lines of any card, resolution or legacy (`description` is the legacy card's one line). */
export function cardLines(db: DatabaseSync, p: CardParams, description: string): { steps: string[]; settles?: string } {
  if (p.kind === "resolution") return { steps: p.steps.map(stepLine), ...(p.settle && { settles: settleLine(db, p.settle) }) };
  const steps = [description];
  switch (p.kind) {
    case "answer": return { steps, settles: settleLine(db, { kind: "answer", decision: p.decision, option: p.option, stamp: p.stamp ?? "" }) };
    case "backlog": return { steps, settles: "Moves the item to the Backlog" };
    case "resolve": return { steps, settles: settleLine(db, { kind: "handled", decision: p.decision, summary: p.summary, stamp: p.stamp ?? "" }) };
    case "close": case "duplicate": return { steps, settles: "Closes the open questions as handled" };
    default: return { steps };
  }
}

/** The primary button's label: the action in a few words, from the parameters and the item. Server-written. */
export function buttonLabel(db: DatabaseSync, p: CardParams): string {
  switch (p.kind) {
    case "resolution": {
      const close = p.steps.find((x) => x.kind === "close");
      if (close) return close.pr ? "Close PR" : "Close issue";
      if (p.steps.some((x) => x.kind === "duplicate")) return "Close as duplicate";
      if (p.settle?.kind === "answer") return `Answer "${optionLabel(getDecision(db, p.settle.decision), p.settle.option)}"`;
      if (p.settle?.kind === "backlog") return "Move to Backlog";
      if (p.settle) return "Close question";
      return p.steps.some((x) => x.kind === "comment") ? "Post comment" : "Add label";
    }
    case "comment": return "Post comment";
    case "answer": {
      const d = getDecision(db, p.decision);
      return `Answer "${optionLabel(d, p.option)}"`;
    }
    case "label": return "Add label";
    case "backlog": return "Move to Backlog";
    case "resolve": return "Close decision";
    case "duplicate": return "Close as duplicate";
    case "close": return p.pr ? "Close PR" : "Close issue";
  }
}

/** The one-line description stored with a resolution: its steps and settlement. */
export function describe(db: DatabaseSync, repo: string, n: number, p: CardParams & { kind: "resolution" }): string {
  const lines = cardLines(db, p, "");
  return `On ${ref(repo, n)}: ${[...lines.steps, ...(lines.settles ? [lines.settles] : [])].join("; ")}`;
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

type Checked<T> = { value: T } | { note: string };

/** Model text for a comment step, cleaned and checked. */
function commentText(raw: unknown, drop: ReadonlySet<string>): Checked<string> {
  const text = typeof raw === "string" ? cleanComment(raw) : "";
  if (!text) return { note: "dropped a resolution whose comment step has no text" };
  if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a resolution whose comment mentions the reference folder or its documentation" };
  if (text.length > COMMENT_MAX) return { note: `dropped a resolution whose comment is longer than ${COMMENT_MAX} characters` };
  return { value: text };
}

function labelStep(db: DatabaseSync, repo: string, n: number, raw: unknown): Checked<Step> {
  const l = typeof raw === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, raw)) : undefined;
  if (!l) return { note: `dropped a resolution: "${String(raw).slice(0, 40)}" is not a label the pipeline manages` };
  const other = otherTypeLabel(db, repo, n, l.name);
  if (other) return { note: `dropped a resolution: the item already has the type label "${other}" and an item has one type label` };
  return { value: { kind: "label", label: l.name } };
}

function closeStep(db: DatabaseSync, repo: string, n: number, reason: unknown): Checked<Step> {
  if (!CLOSE_REASONS.includes(reason as CloseReason)) return { note: "dropped a resolution whose close step has no reason of completed or not_planned" };
  const why = closeRefusal(db, repo, n);
  if (why) return { note: `dropped a resolution: ${why}` };
  const row = db.prepare("SELECT kind, state FROM items WHERE repo = ? AND number = ?").get(repo, n) as { kind: string; state: string };
  if (row.state !== "OPEN") return { note: `dropped a resolution: ${ref(repo, n)} is not open` };
  return { value: { kind: "close", reason: reason as CloseReason, pr: row.kind === "pr" } };
}

function duplicateStep(db: DatabaseSync, repo: string, n: number, of: unknown): Checked<Step> {
  if (!Number.isInteger(of) || of === n) return { note: "dropped a resolution whose duplicate step names no other item number" };
  if (!db.prepare("SELECT 1 FROM items WHERE repo = ? AND number = ?").get(repo, of as number)) return { note: `dropped a resolution: ${ref(repo, of as number)} is not in the mirror` };
  const why = closeRefusal(db, repo, n);
  if (why) return { note: `dropped a resolution: ${why}` };
  return { value: { kind: "duplicate", of: of as number } };
}

const MAX_STEPS = 6;

/** The settlement the model asked for, checked against the item's open decision `d`. */
function settleOf(db: DatabaseSync, d: DecisionRow, raw: unknown): Checked<Settle> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a resolution whose settle is not an object" };
  const s = raw as Record<string, unknown>;
  const stamp = decisionStamp(db, d);
  switch (s.kind) {
    case "answer":
      if (typeof s.option !== "string" || !optionsOf(d).some((o) => o.key === s.option)) return { note: `dropped a resolution: "${String(s.option).slice(0, 40)}" is not an option of the open decision` };
      return { value: { kind: "answer", decision: d.id, option: s.option, stamp } };
    case "backlog":
      return { value: { kind: "backlog", decision: d.id, stamp } };
    case "handled": {
      const summary = typeof s.summary === "string" ? cleanComment(s.summary).replace(/\s+/g, " ") : "";
      if (!summary) return { note: "dropped a resolution that settles as handled without a summary" };
      if (REFERENCE_LEAK.test(summary)) return { note: "dropped a resolution whose summary mentions the reference folder or its documentation" };
      if (summary.length > RESOLVE_MAX) return { note: `dropped a resolution with a summary longer than ${RESOLVE_MAX} characters` };
      return { value: { kind: "handled", decision: d.id, summary, stamp } };
    }
    default:
      return { note: `dropped a resolution with unknown settle "${String(s.kind).slice(0, 40)}"` };
  }
}

/** What a close or duplicate step settles the open decision as when the model named no settlement. */
function closeSettle(db: DatabaseSync, repo: string, d: DecisionRow, closing: Extract<Step, { kind: "close" | "duplicate" }>): Settle {
  const summary = closing.kind === "duplicate" ? `Closed as a duplicate of ${ref(repo, closing.of)} in the conversation`
    : closing.pr ? "Closed in the conversation" : `Closed as ${closing.reason === "completed" ? "completed" : "not planned"} in the conversation`;
  return { kind: "handled", decision: d.id, summary, stamp: decisionStamp(db, d) };
}

/**
 * One resolution as the model wrote it, checked against the item, or why it is dropped. Rules: at most one comment step and one
 * close or duplicate step, which comes last; with an open decision the card settles it (a lone comment step may leave it open: the
 * "ask" card); a close or duplicate step settles it as handled; an answer whose option already writes to GitHub takes no comment,
 * close or duplicate step; without an open decision there is no settlement.
 */
function validateResolution(db: DatabaseSync, repo: string, n: number, c: Record<string, unknown>, drop: ReadonlySet<string>): { card: NewCard } | { note: string } {
  if (!Array.isArray(c.steps) || c.steps.length > MAX_STEPS) return { note: "dropped a resolution without a list of steps" };
  const steps: Step[] = [];
  for (const raw of c.steps) {
    const st = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    let r: Checked<Step>;
    switch (st.kind) {
      case "comment": r = { value: { kind: "comment" } }; break;
      case "label": r = labelStep(db, repo, n, st.label); break;
      case "close": r = closeStep(db, repo, n, st.reason); break;
      case "duplicate": r = duplicateStep(db, repo, n, st.of); break;
      default: r = { note: `dropped a resolution with unknown step "${String(st.kind).slice(0, 40)}"` };
    }
    if ("note" in r) return r;
    steps.push(r.value);
  }
  const count = (k: Step["kind"]) => steps.filter((x) => x.kind === k).length;
  const closing = steps.filter((x): x is Extract<Step, { kind: "close" | "duplicate" }> => x.kind === "close" || x.kind === "duplicate");
  if (count("comment") > 1) return { note: "dropped a resolution with more than one comment step" };
  if (closing.length > 1) return { note: "dropped a resolution that closes the item twice" };
  if (closing.length === 1 && steps[steps.length - 1] !== closing[0]) return { note: "dropped a resolution whose close step is not last" };
  let text: string | null = null;
  if (count("comment") === 1) {
    const t = commentText(c.text, drop);
    if ("note" in t) return t;
    text = t.value;
  } else if (c.text !== undefined && c.text !== null && c.text !== "") return { note: "dropped a resolution with a comment text but no comment step" };

  const d = openDecision(db, repo, n);
  let settle: Settle | null = null;
  if (c.settle !== undefined && c.settle !== null) {
    if (!d) return { note: "dropped a resolution: the item has no open decision to settle" };
    const s = settleOf(db, d, c.settle);
    if ("note" in s) return s;
    settle = s.value;
  }
  if (closing[0]) {
    if (settle && settle.kind !== "handled") return { note: "dropped a resolution that closes the item and settles the question another way than handled" };
    if (d && !settle) settle = closeSettle(db, repo, d, closing[0]);
  }
  if (settle?.kind === "answer" && steps.some((x) => x.kind === "comment" || x.kind === "close" || x.kind === "duplicate") && decisionWrite(db, settle.decision, settle.option)) {
    return { note: "dropped a resolution: the answer already writes to GitHub, so it takes no comment or close step" };
  }
  if (d && !settle && !(steps.length === 1 && steps[0]!.kind === "comment")) return { note: "dropped a resolution that leaves the open decision unsettled" };
  if (!settle && steps.length === 0) return { note: "dropped a resolution without steps or settlement" };
  const params: CardParams = { kind: "resolution", steps, settle };
  return { card: { params, text, description: describe(db, repo, n, params) } };
}

/** One card as the model wrote it, checked against the item, or why it is dropped. Only resolutions are accepted. */
export function validateCard(db: DatabaseSync, repo: string, n: number, raw: unknown, drop: ReadonlySet<string> = new Set()): { card: NewCard } | { note: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: "dropped a card that is not an object" };
  const c = raw as Record<string, unknown>;
  if (c.kind !== "resolution") return { note: `dropped a card with unknown action "${String(c.kind).slice(0, 40)}"` };
  return validateResolution(db, repo, n, c, drop);
}

/** The "ask and keep the question open" card: a lone comment step on an item with an open decision. */
const isAsk = (c: NewCard): boolean => c.params.kind === "resolution" && !c.params.settle;

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

const MAX_RESOLUTIONS = 3;
const FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

/** The cleaned text of each comment of a reply, with its field (`cards[i].text`, i the position in the actions block), for the reference checks. */
export function commentTexts(reply: string): { field: string; text: string }[] {
  const m = FENCE.exec(reply.trimEnd());
  if (!m) return [];
  let list: unknown;
  try { list = JSON.parse(m[1]!); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).flatMap((c: { kind?: unknown; text?: unknown }, i) => {
    const text = c && c.kind === "resolution" && typeof c.text === "string" ? cleanComment(c.text) : "";
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
      const hasDecision = !!openDecision(db, repo, n);
      let asks = 0, resolutions = 0;
      for (const raw of list.slice(0, 20)) {
        const v = validateCard(db, repo, n, raw, drop);
        if (!("card" in v)) { notes.push(v.note); continue; }
        if (hasDecision && isAsk(v.card)) {
          if (asks++ >= 1) notes.push("dropped a second card that only asks and keeps the question open");
          else cards.push(v.card);
        } else if (resolutions++ >= MAX_RESOLUTIONS) notes.push(`dropped a resolution beyond the ${MAX_RESOLUTIONS} allowed per reply`);
        else cards.push(v.card);
      }
      if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
    }
  }
  return { text, cards, notes };
}
