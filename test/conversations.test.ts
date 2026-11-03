// Opus conversations: the prompt keeps a stable start across turns, card validation, Do it runs once through fake writers,
// and viewers read but cannot write. Model calls go to a fake runner; GitHub to a fake querier.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setRunner } from "../src/classify/run.ts";
import { cleanComment, parseReply } from "../src/conversations/cards.ts";
import { doCard, dismissCard, editCard, sweepRunningCards } from "../src/conversations/act.ts";
import { answerPending } from "../src/conversations/run.ts";
import { addOperatorMessage, claimPending, conversationOf, refreshItem, startFromOpus, turnsOf } from "../src/conversations/store.ts";
import { connect } from "../src/db.ts";
import { recommend } from "../src/decide/recommend.ts";
import { ask } from "../src/decisions.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import * as conv from "../src/dash/api/conversations.ts";
import { HttpError } from "../src/dash/server/util.ts";
import type { Req } from "../src/dash/types.ts";
import type { Querier } from "../src/mirror.ts";

mkdirSync(SCRATCH, { recursive: true });
const quiet = () => {};
const T0 = "2026-01-01T00:00:00Z";

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "conv-test-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, head_oid, created_at, updated_at, labels) VALUES ('app', ?, ?, 'OPEN', ?, 'Body text', 'someone', ?, '${T0}', '${T0}', '[]')`);
  item.run(1, "issue", "Issue 1", null);
  item.run(2, "pr", "PR 2", "sha2");
  item.run(3, "issue", "Issue 3", null);
  ask(db, [{ id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }] }]);
  setCommentApproval(db, "op", "app", true);
  return db;
}

/** Answers every call with the next reply and records the prompts sent. */
function fakeModel(replies: string[], prompts: string[] = [], during?: () => Promise<void>) {
  let k = 0;
  const restore = setRunner(async (_cmd, _args, input) => {
    prompts.push(input);
    await during?.();
    return { code: 0, stdout: JSON.stringify({ type: "result", result: replies[Math.min(k++, replies.length - 1)], usage: { input_tokens: 10, output_tokens: 5 } }), stderr: "" };
  });
  return { prompts, restore };
}

const answerAll = (db: DatabaseSync) => answerPending(db, { checkout: async () => null, usageRun: "conv-test", log: quiet });
const say = (db: DatabaseSync, text: string, n = 1) => addOperatorMessage(db, "app", n, "op", text);

describe("conversation prompt", () => {
  test("each turn's prompt starts with the previous prompt minus its new message; an update is a system turn", async () => {
    const db = fresh();
    const { prompts, restore } = fakeModel(["First answer.\n```actions\n[{\"kind\":\"label\",\"label\":\"plugin candidate\"}]\n```", "Second answer.", "Third answer."]);
    try {
      await say(db, "What do you think?");
      assert.equal(await answerAll(db), 1);
      const block = conversationOf(db, "app", 1)!.item_block;
      await say(db, "And the second thing?");
      await answerAll(db);
      // The item changes after the block was written.
      db.prepare("UPDATE items SET body = 'Edited body' WHERE repo = 'app' AND number = 1").run();
      await say(db, "Anything new?");
      await answerAll(db);

      const [p1, p2, p3] = prompts as [string, string, string];
      const m1 = "<turn from=\"operator\" login=\"op\">\nWhat do you think?\n</turn>\n";
      const m2 = "<turn from=\"operator\" login=\"op\">\nAnd the second thing?\n</turn>\n";
      assert.ok(p1.endsWith(m1), "the new message is last");
      assert.ok(p1.includes(block));
      assert.ok(p2.startsWith(p1.slice(0, p1.length - m1.length)), "cache prefix holds for turn 2");
      assert.ok(p2.includes(m1 + "<turn from=\"opus\">\nFirst answer.\n<actions>"), "the earlier turns are sent as stored");
      assert.ok(p2.endsWith(m2));
      assert.ok(p3.startsWith(p2.slice(0, p2.length - m2.length)), "cache prefix holds for turn 3");
      // The update comes before the new message, and the stored block is untouched.
      const tail = p3.slice(p2.length);
      assert.match(tail, /^<turn from="opus">\nSecond answer\.\n<\/turn>\n/);
      assert.match(tail, /<turn from="system">\nThe issue was updated \(text\)[\s\S]*Edited body[\s\S]*<\/turn>\n<turn from="operator" login="op">\nAnything new\?/);
      assert.equal(conversationOf(db, "app", 1)!.item_block, block);
      assert.equal(p3.split(block).length, 2, "the item block appears once, unchanged");
    } finally {
      restore();
    }
  });

  test("a message that gets no usable reply is marked failed and can be sent again", async () => {
    const db = fresh();
    const { restore } = fakeModel(["   "]);
    try {
      await say(db, "Hello");
      assert.equal(await answerAll(db), 0);
      assert.equal(turnsOf(db, "app", 1)[0]!.status, "failed");
      await say(db, "Hello again");
    } finally {
      restore();
    }
  });
});

describe("turn order and claims", () => {
  test("an update or a Do it while Opus answers is held after the reply: one answer, stable order, cache prefix holds", async () => {
    const db = fresh();
    const prompts: string[] = [];
    const { restore } = fakeModel(["First answer.\n```actions\n[{\"kind\":\"comment\",\"text\":\"Hello.\"}]\n```", "Second answer."], prompts, async () => {
      if (prompts.length !== 1) return;
      db.prepare("UPDATE items SET body = 'Edited during the call', labels = '[\"infra\"]' WHERE repo = 'app' AND number = 1").run();
      assert.equal(await refreshItem(db, "app", 1), true);
    });
    try {
      await say(db, "First?");
      assert.equal(await answerAll(db), 1);
      assert.equal(prompts.length, 1, "answered once");
      assert.equal(turnsOf(db, "app", 1).filter((t) => t.kind === "operator")[0]!.status, "answered");
      assert.deepEqual(turnsOf(db, "app", 1).map((t) => t.kind), ["operator", "opus", "system"]);
      assert.equal(await answerAll(db), 0, "nothing left to answer");
      await say(db, "Second?");
      await answerAll(db);
      const [p1, p2] = prompts as [string, string];
      const m1 = "<turn from=\"operator\" login=\"op\">\nFirst?\n</turn>\n";
      assert.ok(p2.startsWith(p1.slice(0, p1.length - m1.length) + m1), "the first prompt is a prefix of the second");
      assert.match(p2.slice(p1.length), /^<turn from="opus">[\s\S]*<\/turn>\n<turn from="system">\nThe issue was updated \(text, labels\)[\s\S]*<turn from="operator" login="op">\nSecond\?/);
    } finally {
      restore();
    }
  });

  test("a message is claimed once, and a stale claim is released", async () => {
    const db = fresh();
    await say(db, "Hi");
    const a = claimPending(db, "app", 1), b = claimPending(db, "app", 1);
    assert.ok(a);
    assert.equal(b, null);
    await assert.rejects(() => say(db, "More"), /has not answered/);
    const later = { now: () => new Date(Date.now() + 3 * 3600_000) };
    assert.ok(claimPending(db, "app", 1, later), "released after the prompt timeouts");
  });
});

describe("cards", () => {
  test("comment text loses entities that hide mentions, HTML, images and links", () => {
    assert.equal(cleanComment("Thanks &#64;bob and &commat;amy and &amp;#x40;cy"), "Thanks bob and amy and cy");
    assert.equal(cleanComment("See [the docs](https://x.test/a) <b>now</b> ![img](https://x.test/i.png) https://y.test/z"), "See the docs now");
    assert.equal(cleanComment("Line one\n\n\n\nLine two @team"), "Line one\n\nLine two team");
  });

  test("a second type label is refused; an answer card names its decision", () => {
    const db = fresh();
    db.prepare("UPDATE items SET labels = '[\"bugfix\"]' WHERE repo = 'app' AND number = 1").run();
    const p = parseReply(db, "app", 1, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "label", label: "infra" }, { kind: "label", label: "security" }, { kind: "answer", option: "close" }])}\n\`\`\``)!;
    assert.deepEqual(p.cards.map((c) => c.params.kind), ["label", "answer"]);
    assert.equal(p.notes.length, 1);
    assert.deepEqual(p.cards[1]!.params, { kind: "answer", option: "close", decision: "app#1:scope" });
    assert.match(p.cards[1]!.description, /\(closes it on GitHub\)$/);
    // Act's checks apply to the duplicate close: not outside the pilot, not held by Backlog.
    const dup = `Text.\n\`\`\`actions\n[{"kind":"duplicate","of":3}]\n\`\`\``;
    assert.equal(parseReply(db, "app", 1, dup)!.cards.length, 1);
    db.prepare("UPDATE tracked_repos SET pipeline = 0").run();
    assert.match(parseReply(db, "app", 1, dup)!.notes[0]!, /outside the pilot/);
  });

  test("a changed label or a new comment sends an update turn; a card for an answered decision fails", async () => {
    const db = fresh();
    const [id] = await withCards(db, [{ kind: "answer", option: "take" }]);
    db.prepare("UPDATE decisions SET answer = 'close', answered_by = 'other', answered_at = ? WHERE id = 'app#1:scope'").run(T0);
    const r = await doCard(db, id!, "op", { querier: fakeGithub([]) });
    assert.equal(r.card.state, "failed");
    assert.match(r.card.error!, /decision changed/);
    assert.equal(db.prepare("SELECT answered_by FROM decisions WHERE id = 'app#1:scope'").get()!.answered_by, "other");
    db.prepare("UPDATE items SET labels = '[\"infra\"]' WHERE repo = 'app' AND number = 1").run();
    assert.equal(await refreshItem(db, "app", 1), true);
    assert.match(turnsOf(db, "app", 1).at(-1)!.block, /updated \(labels, decision\)/);
    assert.equal(await refreshItem(db, "app", 1), false);
  });

  test("running cards left by a crash are failed after ten minutes", async () => {
    const db = fresh();
    const [id] = await withCards(db, [{ kind: "backlog" }]);
    db.prepare("UPDATE conversation_cards SET state = 'running', acted_at = ? WHERE id = ?").run(T0, id);
    assert.equal(sweepRunningCards(db), 1);
    const c = db.prepare("SELECT state, error FROM conversation_cards WHERE id = ?").get(id) as { state: string; error: string };
    assert.deepEqual({ ...c }, { state: "failed", error: "outcome unknown; see the GitHub activity page" });
  });


  test("invalid cards are dropped with a note and valid ones get a description from the parameters", () => {
    const db = fresh();
    const reply = `Text.\n\`\`\`actions\n${JSON.stringify([
      { kind: "delete-everything" },
      { kind: "answer", option: "nope" },
      { kind: "answer", option: "close" },
      { kind: "label", label: "my own label" },
      { kind: "label", label: "Plugin Candidate" },
      { kind: "duplicate", of: 1 },
      { kind: "duplicate", of: 3 },
      { kind: "duplicate", of: 99 },
      { kind: "comment", text: "Thanks @bob, see the pack." },
      { kind: "comment", text: "" },
      { kind: "backlog" },
    ])}\n\`\`\``;
    const p = parseReply(db, "app", 1, reply)!;
    assert.deepEqual(p.cards.map((c) => c.params.kind), ["answer", "label", "duplicate", "comment", "backlog"]);
    assert.equal(p.notes.length, 6);
    assert.equal(p.cards[0]!.description, 'Answer the open decision on app#1 with "Out of scope" (closes it on GitHub)');
    assert.equal(p.cards[1]!.description, 'Add the label "plugin candidate" to app#1');
    assert.equal(p.cards[3]!.text, "Thanks bob, see the pack.");
    assert.equal(parseReply(db, "app", 1, "```actions\n[]\n```"), null, "no text, no reply");
    assert.equal(parseReply(db, "app", 1, "Hi\n```actions\nnot json\n```")!.notes.length, 1);
  });
});

function fakeGithub(log: string[]): Querier {
  return validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number; id?: string; body?: string };
      if (query.startsWith("mutation") && query.includes("addComment")) { log.push(`comment ${v.id}: ${v.body}`); return { addComment: { commentEdge: { node: { url: `https://x/${v.id}#c` } } } }; }
      if (query.startsWith("mutation")) { log.push(`close ${v.id}`); return {}; }
      return { repository: { issueOrPullRequest: { __typename: "Issue", id: `I${v.n}`, state: "OPEN" } } };
    },
  });
}

async function withCards(db: DatabaseSync, cards: object[]): Promise<number[]> {
  const { restore } = fakeModel([`Reply.\n\`\`\`actions\n${JSON.stringify(cards)}\n\`\`\``]);
  try {
    await say(db, "Please propose");
    await answerAll(db);
  } finally {
    restore();
  }
  return (db.prepare("SELECT id FROM conversation_cards ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}

describe("Do it", () => {
  test("a comment card runs once, with the edited text, and a second press does nothing", async () => {
    const db = fresh();
    const [id] = await withCards(db, [{ kind: "comment", text: "Original text." }]);
    editCard(db, id!, "op", "Edited text.");
    const log: string[] = [];
    const deps = { querier: fakeGithub(log) };
    const [a, b] = await Promise.all([doCard(db, id!, "op", deps), doCard(db, id!, "op", deps)]);
    assert.deepEqual([a.ran, b.ran].sort(), [false, true]);
    assert.deepEqual(log, ["comment I1: Edited text."]);
    const card = (await doCard(db, id!, "op", deps)).card;
    assert.equal(card.state, "done");
    assert.equal(card.result_url, "https://x/I1#c");
    assert.equal(card.acted_by, "op");
    assert.equal(log.length, 1);
    const audit = db.prepare("SELECT login, action FROM audit WHERE action = 'act-comment'").all() as { login: string }[];
    assert.deepEqual(audit.map((r) => r.login), ["op"]);
    assert.throws(() => editCard(db, id!, "op", "Too late"), /already done/);
    // What the operator ran reaches Opus as a system turn.
    assert.match(turnsOf(db, "app", 1).at(-1)!.block, /<turn from="system">\nThe operator op ran the proposed action[\s\S]*Edited text\./);
  });

  test("answer, duplicate and dismiss; an unapproved repo fails the card with the reason", async () => {
    const db = fresh();
    const [answer, dup, dismissed] = await withCards(db, [{ kind: "answer", option: "close" }, { kind: "duplicate", of: 3 }, { kind: "backlog" }]);
    const log: string[] = [];
    const deps = { querier: fakeGithub(log) };
    assert.equal((await doCard(db, answer!, "op", deps)).card.state, "done");
    assert.deepEqual({ ...db.prepare("SELECT answer, answered_by FROM decisions WHERE id = 'app#1:scope'").get() }, { answer: "close", answered_by: "op" });
    dismissCard(db, dismissed!, "op");
    assert.equal((await doCard(db, dismissed!, "op", deps)).ran, false);
    assert.equal(db.prepare("SELECT answer FROM decisions WHERE id = 'app#1:scope'").get()!.answer, "close");
    assert.equal((await doCard(db, dup!, "op", deps)).card.state, "done");
    assert.deepEqual(log, ["comment I1: Duplicate of #3.", "close I1"]);

    const db2 = fresh();
    db2.prepare("DELETE FROM settings WHERE key LIKE 'comment_approved:%'").run();
    const [c] = await withCards(db2, [{ kind: "comment", text: "Hi." }]);
    const failed = (await doCard(db2, c!, "op", deps)).card;
    assert.equal(failed.state, "failed");
    assert.match(failed.error!, /not approved/);
    assert.equal((await doCard(db2, c!, "op", deps)).ran, false);
    assert.equal(log.length, 2, "nothing was written");
  });
});

function req(role: "operator" | "viewer", params: Record<string, string>, json?: unknown): Req {
  return { method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), json, csrf: "", nonce: "",
    user: { login: role === "operator" ? "op" : "view", role, canWrite: async () => role === "operator", canRead: async () => true } };
}

describe("access", () => {
  test("a viewer reads the conversation and cannot write; the write routes are operator-only", async () => {
    const db = fresh();
    const { restore } = fakeModel(["Reply.\n```actions\n[{\"kind\":\"backlog\"}]\n```"]);
    try {
      await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Hi" }));
      await answerAll(db);
    } finally {
      restore();
    }
    const view = await conv.getConversation(db, req("viewer", { repo: "app", n: "1" }));
    assert.equal(view.exists, true);
    assert.deepEqual(view.turns.map((t) => t.login), ["op", "opus"]);
    assert.equal(view.turns[1]!.actions[0]!.state, "proposed");
    const cardId = String(view.turns[1]!.actions[0]!.id);
    for (const f of [
      () => conv.postMessage(db, req("viewer", { repo: "app", n: "1" }, { text: "Hi" })),
      () => conv.doIt(db, req("viewer", { id: cardId })),
      () => conv.dismiss(db, req("viewer", { id: cardId })),
      () => conv.editCardText(db, req("viewer", { id: cardId }, { text: "x" })),
    ]) await assert.rejects(f, (e) => e instanceof HttpError && e.status === 403);
    assert.equal(db.prepare("SELECT state FROM conversation_cards").get()!.state, "proposed");
    const writes = apiRoutes().filter((r) => r.method === "POST" && /conversation/.test(r.pattern));
    assert.equal(writes.length, 4);
    assert.ok(writes.every((r) => r.operator === true));
    // A second message while Opus has not answered the first is refused.
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "More" }));
    await assert.rejects(() => conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Again" })), (e) => e instanceof HttpError && e.status === 409);
  });
});

describe("Opus starts a conversation", () => {
  test("a recommendation with an opening question stores it as the first Opus turn, once", async () => {
    const db = fresh();
    const reply = { recommended: "take", reason: "Fits.", conversation: "Take it, but use the language pack from craft-i18n?" };
    const restore = setRunner(async () => ({ code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(reply), usage: { input_tokens: 1, output_tokens: 1 } }), stderr: "" }));
    try {
      assert.equal(await recommend(db, ["app#1:scope"], { checkout: async () => null, usageRun: "r", log: quiet }), 1);
      const turns = turnsOf(db, "app", 1);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]!.login, "opus");
      assert.match(turns[0]!.body, /language pack/);
      assert.equal(conversationOf(db, "app", 1)!.created_by, "opus");
      assert.equal(await startFromOpus(db, "app", 1, "Another opening"), false);
    } finally {
      restore();
    }
  });
});
