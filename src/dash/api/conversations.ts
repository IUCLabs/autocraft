// Opus conversations on items. Everyone who may see the repo reads them; only operators write, edit, run and dismiss.
import type { DatabaseSync } from "node:sqlite";
import type { Conversation, ConversationCard, ConversationTurn } from "../../../web/src/api/types.ts";
import { cardOf, dismissCard, doCard, editCard, type ActDeps, type CardRow } from "../../conversations/act.ts";
import { ConversationError, addOperatorMessage, conversationOf, pendingTurn, turnsOf, type StoreDeps } from "../../conversations/store.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { needVisible } from "./visible.ts";

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

export function cardView(c: CardRow): ConversationCard {
  return {
    id: c.id, kind: c.kind as ConversationCard["kind"], title: c.description, state: c.state as ConversationCard["state"],
    ...(c.text !== null && { text: c.text }),
    ...(c.state === "done" && { done: { at: c.acted_at ?? "", link: c.result_url ?? "", label: c.result ?? "Done" } }),
    ...(c.state === "failed" && c.error && { error: c.error }),
    ...(c.acted_by && { by: c.acted_by }),
    ...(c.acted_at && { at: c.acted_at }),
    ...(c.edited_by && { edited: true }),
  };
}

export function conversationView(db: DatabaseSync, repo: string, n: number): Conversation {
  const c = conversationOf(db, repo, n);
  if (!c) return { repo, number: n, exists: false, pending: false, startedBy: null, turns: [] };
  const cards = db.prepare("SELECT * FROM conversation_cards WHERE repo = ? AND number = ? ORDER BY id").all(repo, n) as unknown as CardRow[];
  const turns: ConversationTurn[] = turnsOf(db, repo, n).map((t) => ({
    id: t.id, kind: t.kind, login: t.login, at: t.at, body: t.body,
    actions: cards.filter((x) => x.turn_id === t.id).map(cardView),
    notes: t.notes ? (JSON.parse(t.notes) as string[]) : [],
    ...(t.status && { status: t.status as ConversationTurn["status"] }),
    ...(t.error && { error: t.error }),
  }));
  return { repo, number: n, exists: true, pending: !!pendingTurn(db, repo, n), startedBy: c.created_by, turns };
}

function itemOf(req: Req): { repo: string; n: number } {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "the item number must be a whole number");
  return { repo: req.params.repo!, n };
}

function text(req: Req): string {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b) || typeof (b as { text?: unknown }).text !== "string") throw new HttpError(400, "the body must be an object with a text");
  return (b as { text: string }).text;
}

function needOperator(req: Req): void {
  if (!isOperator(req)) throw new HttpError(403, "only operators write in conversations");
}

export async function getConversation(db: DatabaseSync, req: Req): Promise<Conversation> {
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  return conversationView(db, repo, n);
}

export async function postMessage(db: DatabaseSync, req: Req, deps?: StoreDeps): Promise<Conversation> {
  needOperator(req);
  const { repo, n } = itemOf(req);
  await needVisible(db, req, repo);
  await guardAsync(() => addOperatorMessage(db, repo, n, req.user.login, text(req), deps));
  return conversationView(db, repo, n);
}

async function needCard(db: DatabaseSync, req: Req): Promise<CardRow> {
  needOperator(req);
  const id = Number(req.params.id);
  const c = Number.isInteger(id) ? cardOf(db, id) : undefined;
  if (!c) throw new HttpError(404, `no card ${req.params.id}`);
  await needVisible(db, req, c.repo);
  if (!(await req.user.canWrite(c.repo).catch(() => false))) throw new HttpError(403, `no write access to storytold/${c.repo}`);
  return c;
}

export async function editCardText(db: DatabaseSync, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  return cardView(guard(() => editCard(db, c.id, req.user.login, text(req))));
}

export async function dismiss(db: DatabaseSync, req: Req): Promise<ConversationCard> {
  const c = await needCard(db, req);
  return cardView(guard(() => dismissCard(db, c.id, req.user.login)));
}

/** Runs the card once; a second press returns the card as it is. */
export async function doIt(db: DatabaseSync, req: Req, deps?: ActDeps): Promise<ConversationCard> {
  const c = await needCard(db, req);
  return cardView((await guardAsync(() => doCard(db, c.id, req.user.login, deps))).card);
}
