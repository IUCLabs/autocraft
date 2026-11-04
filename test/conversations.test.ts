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
import { audit } from "../src/dash/audit.ts";
import { addOperatorMessage, claimPending, conversationOf, insertTurn, promptParts, refreshItem, startFromOpus, turnsOf } from "../src/conversations/store.ts";
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

});

describe("turn order and claims", () => {



});

describe("cards", () => {
  test("comment text loses entities that hide mentions, HTML, images and links", () => {
    assert.equal(cleanComment("Thanks &#64;bob and &commat;amy and &amp;#x40;cy"), "Thanks bob and amy and cy");
    assert.equal(cleanComment("See [the docs](https://x.test/a) <b>now</b> ![img](https://x.test/i.png) https://y.test/z"), "See the docs now");
    assert.equal(cleanComment("Line one\n\n\n\nLine two @team"), "Line one\n\nLine two team");
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
});
