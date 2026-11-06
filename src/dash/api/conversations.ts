// Opus conversations on items. Everyone who may see the repo reads them; only operators write, edit, run and dismiss.
import type { DatabaseSync } from "node:sqlite";
import type { CardEdit, Conversation, ConversationCard, ConversationTurn } from "../../../web/src/api/types.ts";
import { buttonLabel, cardEffect, cardLines, type CardParams } from "../../conversations/cards.ts";
import { cardOf, cardRepos, dismissCard, doCard, editCard, sweepRunningCards, type ActDeps, type CardRow } from "../../conversations/act.ts";
import { ConversationError, addOperatorMessage, conversationOf, includesOf, pendingTurn, setInclude, staleOf, turnsOf, type IncludeRow, type StoreDeps } from "../../conversations/store.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { needVisible } from "./visible.ts";
import { slugOf } from "../../owners.ts";
import { canSettle, canSettleCached } from "../../settlers.ts";

const isOperator = (req: Req): boolean => req.user.role === "operator";

function guard<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ConversationError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

async function guardAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ConversationError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** `who`: the viewer, for the card's `canSettle` (an operator, or a maintainer under the rule of src/settlers.ts, from cached permissions). */
export function cardView(db: DatabaseSync, c: CardRow, who?: { login: string; role: string }): ConversationCard {
  const params = JSON.parse(c.params) as CardParams;
  const effect = c.kind === "answer" || c.kind === "close" || c.kind === "resolution" ? cardEffect(db, params) : null;
  const lines = cardLines(db, params, c.description);
  const commentStep = params.kind === "resolution" ? params.steps.findIndex((x) => x.kind === "comment") : params.kind === "comment" || (params.kind === "close" && c.text !== null) ? 0 : -1;
  const issueAt = params.kind === "resolution" ? params.steps.findIndex((x) => x.kind === "open_issue") : -1;
  const fixupAt = params.kind === "resolution" ? params.steps.findIndex((x) => x.kind === "fixup") : -1;
  const issueStep = params.kind === "resolution" ? params.steps[issueAt] : undefined;
  const fixupStep = params.kind === "resolution" ? params.steps[fixupAt] : undefined;
  const stale = c.state === "proposed" ? staleOf(db, c.repo, c.number, c.seen) : undefined;
  return {
    steps: lines.steps,
    ...(commentStep >= 0 && { commentStep }),
    ...(issueStep?.kind === "open_issue" && { issue: { step: issueAt, repo: issueStep.repo, title: issueStep.title, body: issueStep.body } }),
    ...(fixupStep?.kind === "fixup" && { fixup: { step: fixupAt, instructions: fixupStep.instructions, merge: fixupStep.merge } }),
    ...(params.kind === "resolution" && params.settle?.kind === "answer" && { option: params.settle.option }),
    ...(stale && { stale }),
    ...(lines.settles && { settles: lines.settles }),
    label: buttonLabel(db, params),
    canSettle: !!who && canSettleCached(db, who.login, who.role, cardRepos(c, params)),
    id: c.id, kind: c.kind as ConversationCard["kind"], title: c.description, state: c.state as ConversationCard["state"],
    ...(c.text !== null && { text: c.text }),
    ...(effect && { writes: effect }),
    ...(c.state === "done" && { done: { at: c.acted_at ?? "", link: c.result_url ?? "", label: c.result ?? "Done" } }),
    ...(c.state === "failed" && c.error && { error: c.error }),
    ...(c.acted_by && { by: c.acted_by }),
    ...(c.acted_at && { at: c.acted_at }),
    ...(c.edited_by && { edited: true, editedBy: c.edited_by }),
  };
}

/** The conversation plus the maintainer posts shared with Opus. */
export type ConversationView = Conversation & { includes: IncludeRow[] };

export function conversationView(db: DatabaseSync, repo: string, n: number, who?: { login: string; role: string }): ConversationView {
  // A card left Running by a crash must not show as running until the next restart.
  sweepRunningCards(db);
  const c = conversationOf(db, repo, n);
  const includes = includesOf(db, repo, n);
  if (!c) return { repo, number: n, exists: false, pending: false, startedBy: null, turns: [], includes };
  const cards = db.prepare("SELECT * FROM conversation_cards WHERE repo = ? AND number = ? ORDER BY id").all(repo, n) as unknown as CardRow[];
  const turns: ConversationTurn[] = turnsOf(db, repo, n).map((t) => ({
    id: t.id, kind: t.kind, login: t.login, at: t.at, body: t.body,
    actions: cards.filter((x) => x.turn_id === t.id).map((x) => cardView(db, x, who)),
    notes: t.notes ? (JSON.parse(t.notes) as string[]) : [],
    ...(t.status && { status: t.status as ConversationTurn["status"] }),
    ...(t.error && { error: t.error }),
  }));
  const wait = pendingTurn(db, repo, n);
  const progress = wait?.status === "answering" && wait.progress ? (JSON.parse(wait.progress) as string[]) : [];
  return { repo, number: n, exists: true, pending: !!wait, ...(progress.length > 0 && { progress }), startedBy: c.created_by, turns, includes };
}

function itemOf(req: Req): { repo: string; n: number } {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "the item number must be a whole number");
  return { repo: req.params.repo!, n };
}

/** The edit a card-edit request carries: any of text, issue ({title, body}) and instructions. */
function cardEdit(req: Req): CardEdit {
  const b = req.json as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be an object");
  const edit: CardEdit = {};
  if (b.text !== undefined) { if (typeof b.text !== "string") throw new HttpError(400, "text must be a string"); edit.text = b.text; }
  if (b.instructions !== undefined) { if (typeof b.instructions !== "string") throw new HttpError(400, "instructions must be a string"); edit.instructions = b.instructions; }
  if (b.issue !== undefined) {
    const i = b.issue as Record<string, unknown> | null;
    if (!i || typeof i !== "object" || typeof i.title !== "string" || typeof i.body !== "string") throw new HttpError(400, "issue must be an object with a title and a body");
    edit.issue = { title: i.title, body: i.body };
  }
  if (Object.keys(edit).length === 0) throw new HttpError(400, "the body must have a text, an issue or instructions");
  return edit;
}

function text(req: Req): string {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b) || typeof (b as { text?: unknown }).text !== "string") throw new HttpError(400, "the body must be an object with a text");
  return (b as { text: string }).text;
}

/** `ask: false` stores the message without asking Opus. */
function ask(req: Req): boolean {
  const a = (req.json as { ask?: unknown } | null)?.ask;
  if (a !== undefined && typeof a !== "boolean") throw new HttpError(400, "ask must be true or false");
  return a !== false;
}

function needOperator(req: Req): void {
  if (!isOperator(req)) throw new HttpError(403, "only operators write in conversations");
}

export async function getConversation(db: DatabaseSync, req: Req): Promise<ConversationView> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  return conversationView(db, repo, n, req.user);
}

export async function postMessage(db: DatabaseSync, req: Req, deps?: StoreDeps): Promise<ConversationView> {
  needOperator(req);
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  await guardAsync(() => addOperatorMessage(db, repo, n, req.user.login, text(req), deps, ask(req)));
  return conversationView(db, repo, n, req.user);
}

/** Shares a maintainer post with Opus (`on`) or stops sharing it; the next asked message carries it. */
export async function postInclude(db: DatabaseSync, req: Req, deps?: StoreDeps): Promise<ConversationView> {
  needOperator(req);
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  const b = req.json as { source?: unknown; on?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.source !== "string" || typeof b.on !== "boolean") throw new HttpError(400, "the body must be an object with a source and on (true or false)");
  guard(() => setInclude(db, repo, n, b.source as string, b.on as boolean, req.user.login, deps));
  return conversationView(db, repo, n, req.user);
}

/** The card, for someone who settles it: an operator with write access on its repo, or a maintainer under the rule of src/settlers.ts on every repo it writes to. */
async function needCard(db: DatabaseSync, req: Req): Promise<CardRow> {
  const id = Number(req.params.id);
  const c = Number.isInteger(id) ? cardOf(db, id) : undefined;
  if (!c) throw new HttpError(404, `no card ${req.params.id}`);
  await needVisible(db, req, c.repo);
  if (isOperator(req)) {
    if (!(await req.user.canWrite(c.repo).catch(() => false))) throw new HttpError(403, `no write access to ${slugOf(c.repo)}`);
  } else if (!(await canSettle(db, req.user, cardRepos(c, JSON.parse(c.params) as CardParams)))) {
    throw new HttpError(403, "only an operator, or a maintainer with write access where the app acts for them, runs cards");
  }
  return c;
}

export async function editCardText(db: DatabaseSync, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  const edit = cardEdit(req);
  // The fix-up instructions go to the fix-up model: only an operator writes them.
  if (edit.instructions !== undefined && !isOperator(req)) throw new HttpError(403, "only operators edit a fix-up's instructions");
  return cardView(db, guard(() => editCard(db, c.id, req.user.login, edit)), req.user);
}

export async function dismiss(db: DatabaseSync, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  return cardView(db, guard(() => dismissCard(db, c.id, req.user.login, { role: req.user.role })), req.user);
}

/** Runs the card once; a second press returns the card as it is. */
export async function doIt(db: DatabaseSync, req: Req, deps?: ActDeps): Promise<ConversationCard> {
  const c = await needCard(db, req);
  const b = req.json as { skip?: unknown; note?: unknown } | null;
  if (b?.note !== undefined && typeof b.note !== "string") throw new HttpError(400, "note must be a string");
  if (b?.skip !== undefined && (!Array.isArray(b.skip) || b.skip.some((k) => !Number.isInteger(k)))) throw new HttpError(400, "skip must be a list of step positions");
  const skip = (b?.skip as number[] | undefined) ?? [];
  return cardView(db, (await guardAsync(() => doCard(db, c.id, req.user.login, { ...deps, skip, note: b?.note as string | undefined, noteStaysOut: !isOperator(req), role: req.user.role, canWrite: (r) => req.user.canWrite(r) }))).card, req.user);
}
