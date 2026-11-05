// Opus conversations: the prompt keeps a stable start across turns, card validation, Do it runs once through fake writers,
// and viewers read but cannot write. Model calls go to a fake runner; GitHub to a fake querier.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setApproval as setLabelApproval } from "../src/labels/approval.ts";
import { setRunner } from "../src/classify/run.ts";
import { cleanComment, parseReply } from "../src/conversations/cards.ts";
import { doCard } from "../src/conversations/act.ts";
import { answerPending } from "../src/conversations/run.ts";
import { connect } from "../src/db.ts";
import { ask } from "../src/decisions.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import * as conv from "../src/dash/api/conversations.ts";
import { HttpError } from "../src/dash/server/util.ts";
import type { Req } from "../src/dash/types.ts";

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






  test("invalid resolutions are dropped with a note and valid ones get lines from the parameters", () => {
    const db = fresh();
    const R = (steps: unknown[], settle: unknown, extra: Record<string, unknown> = {}) => ({ kind: "resolution", steps, settle, ...extra });
    const reply = `Text.\n\`\`\`actions\n${JSON.stringify([
      { kind: "delete-everything" },
      { kind: "comment", text: "an old kind" },
      R([], { kind: "answer", option: "nope" }),
      R([{ kind: "label", label: "my own label" }], { kind: "backlog" }),
      R([{ kind: "label", label: "Plugin Candidate" }], { kind: "answer", option: "take" }),
      R([{ kind: "duplicate", of: 1 }], null),
      R([{ kind: "duplicate", of: 3 }], null),
      R([{ kind: "duplicate", of: 99 }], null),
      R([{ kind: "close", reason: "completed" }, { kind: "comment" }], null, { text: "Done." }),
      R([{ kind: "comment" }, { kind: "comment" }], { kind: "backlog" }, { text: "Twice." }),
      R([{ kind: "comment" }], { kind: "answer", option: "close" }, { text: "Closing." }),
      R([{ kind: "comment" }], { kind: "answer", option: "take" }, { text: "Thanks @bob, see the pack." }),
      R([{ kind: "comment" }], { kind: "backlog" }, { text: "" }),
      R([{ kind: "label", label: "bugfix" }], null),
      R([{ kind: "comment" }], null, { text: "Which version?" }),
      R([{ kind: "comment" }], null, { text: "Second question?" }),
    ])}\n\`\`\``;
    const p = parseReply(db, "app", 1, reply)!;
    const kinds = p.cards.map((c) => JSON.stringify(c.params.kind === "resolution" ? [c.params.steps.map((x) => x.kind), c.params.settle?.kind ?? null] : null));
    assert.deepEqual(kinds, [
      '[["label"],"answer"]', '[["duplicate"],"handled"]', '[["comment"],"answer"]', '[["comment"],null]',
    ]);
    assert.equal(p.notes.length, 12);
    assert.equal(p.cards[0]!.description, 'On app#1: Add the label "plugin candidate"; Answers the scope question with "Wanted"');
    assert.equal(p.cards[2]!.text, "Thanks bob, see the pack.");
    assert.equal(parseReply(db, "app", 1, "```actions\n[]\n```"), null, "no text, no reply");
    assert.equal(parseReply(db, "app", 1, "Hi\n```actions\nnot json\n```")!.notes.length, 1);
    // No open decision: a settle is refused and steps alone are fine.
    const none = parseReply(db, "app", 3, `Hi\n\`\`\`actions\n${JSON.stringify([R([{ kind: "label", label: "bugfix" }], null), R([], { kind: "backlog" })])}\n\`\`\``)!;
    assert.equal(none.cards.length, 1);
    assert.equal(none.notes.length, 1);
  });
});

describe("Do it", () => {
  test("a close card comments, closes with the state reason and answers the item's open decision as handled", async () => {
    const db = fresh();
    const sent: { q: string; v: Record<string, unknown> }[] = [];
    const querier = { query: async (q: string, v: Record<string, unknown> = {}) => {
      sent.push({ q, v });
      return q.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } } : {};
    } };
    const params = JSON.stringify({ kind: "close", reason: "completed", pr: false });
    const id = Number(db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', 1, 'close', ?, 'Done in an earlier PR.', 'x')").run(params).lastInsertRowid);
    const { card } = await doCard(db, id, "op", { querier: querier as never });
    assert.equal(card.state, "done", card.error ?? "");
    assert.ok(sent.some((x) => x.q.includes("closeIssue") && x.v.reason === "COMPLETED"));
    const d = db.prepare("SELECT answer, applied_at FROM decisions WHERE id = 'app#1:scope'").get() as { answer: string; applied_at: string | null };
    assert.equal(d.answer, "handled");
    assert.ok(d.applied_at);
  });

  const resolution = (db: DatabaseSync, steps: unknown[], settle: unknown, text: string | null) => {
    const p = parseReply(db, "app", 1, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps, settle, ...(text && { text }) }])}\n\`\`\``)!;
    assert.equal(p.cards.length, 1, p.notes.join("; "));
    return Number(db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', 1, 'resolution', ?, ?, ?)")
      .run(JSON.stringify(p.cards[0]!.params), p.cards[0]!.text, p.cards[0]!.description).lastInsertRowid);
  };
  const github = (failLabel: boolean) => {
    const sent: string[] = [];
    const querier = { query: async (q: string) => {
      sent.push(q.includes("addComment") ? "comment" : q.includes("addLabelsToLabelable") ? "label" : q.includes("issueOrPullRequest") ? "read" : "other");
      if (q.includes("issueOrPullRequest")) return { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } };
      if (q.includes("addComment")) return { addComment: { commentEdge: { node: { url: "https://x.test/c" } } } };
      if (q.includes("repository(")) return { repository: { id: "R_1", l0: { id: "L_1", name: "bugfix" }, l1: null } };
      if (failLabel) throw new Error("label add failed");
      return { m0: { clientMutationId: null } };
    } };
    return { sent, querier };
  };

  test("a resolution runs its steps in order, then answers the decision with the operator's login; a failing step leaves it open", async () => {
    const ok = fresh();
    setLabelApproval(ok, "op", "app", true);
    const g = github(false);
    const id = resolution(ok, [{ kind: "comment" }, { kind: "label", label: "bugfix" }], { kind: "answer", option: "take" }, "Thanks.");
    const { card } = await doCard(ok, id, "op", { querier: g.querier as never });
    assert.equal(card.state, "done", card.error ?? "");
    assert.deepEqual(g.sent.filter((x) => x === "comment" || x === "label"), ["comment", "label"]);
    const d = ok.prepare("SELECT answer, answered_by FROM decisions WHERE id = 'app#1:scope'").get() as { answer: string; answered_by: string };
    assert.deepEqual({ ...d }, { answer: "take", answered_by: "op" });

    const bad = fresh();
    setLabelApproval(bad, "op", "app", true);
    const b = github(true);
    const failed = (await doCard(bad, resolution(bad, [{ kind: "comment" }, { kind: "label", label: "bugfix" }], { kind: "answer", option: "take" }, "Thanks."), "op", { querier: b.querier as never })).card;
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /Already done: Post the comment below/);
    assert.equal(bad.prepare("SELECT answer FROM decisions WHERE id = 'app#1:scope'").get()!.answer, null);
  });

  test("a message with ask false is stored without a pending state and queues no Opus reply", async () => {
    const db = fresh();
    await conv.postMessage(db, req("operator", { repo: "app", n: "3" }, { text: "Note for later", ask: false }));
    const row = db.prepare("SELECT status, seq FROM conversation_turns WHERE repo = 'app' AND number = 3").get() as { status: string | null; seq: number | null };
    assert.equal(row.status, null);
    assert.ok(row.seq);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversation_turns WHERE status = 'pending'").get()!.n, 0);
    // A shared maintainer post rides in the next asked turn once.
    db.prepare("INSERT INTO decision_comments (id, decision_id, login, at, body) VALUES ('c1', 'app#1:scope', 'maint', ?, 'I think it is fine @x')").run(T0);
    await conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c1", on: true }));
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Look at this" }));
    const blocks = db.prepare("SELECT block FROM conversation_turns WHERE repo = 'app' AND number = 1 AND kind = 'operator'").all() as { block: string }[];
    assert.equal(blocks.filter((b) => b.block.includes('<included from="maintainer" login="maint"') && b.block.includes("I think it is fine ")).length, 1);
    assert.ok(!blocks[0]!.block.includes("@x"));
    // A source from another item's decision is refused.
    db.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('app#3:scope', 'scope', 'app', 3, 'Scope?', '[]', ?)").run(T0);
    db.prepare("INSERT INTO decision_comments (id, decision_id, login, at, body) VALUES ('c3', 'app#3:scope', 'maint', ?, 'Other item')").run(T0);
    await assert.rejects(() => conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c3", on: true })), (e) => e instanceof HttpError && e.status === 400);
    // The next asked message carries nothing again.
    db.prepare("UPDATE conversation_turns SET status = 'answered' WHERE repo = 'app' AND number = 1").run();
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "And now?" }));
    const last = db.prepare("SELECT block FROM conversation_turns WHERE repo = 'app' AND number = 1 AND kind = 'operator' ORDER BY id DESC LIMIT 1").get() as { block: string };
    assert.ok(last.block.includes("And now?") && !last.block.includes("<included"));
    await assert.rejects(() => conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c1", on: false })), (e) => e instanceof HttpError && e.status === 409);
    // A question can follow at once.
    await conv.postMessage(db, req("operator", { repo: "app", n: "3" }, { text: "What do you think?" }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversation_turns WHERE status = 'pending' AND number = 3").get()!.n, 1);
  });
});

function req(role: "operator" | "viewer", params: Record<string, string>, json?: unknown): Req {
  return { method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), json, csrf: "", nonce: "",
    user: { login: role === "operator" ? "op" : "view", role, canWrite: async () => role === "operator", canRead: async () => true } };
}

describe("access", () => {
  test("a viewer reads the conversation and cannot write; the write routes are operator-only", async () => {
    const db = fresh();
    const { restore } = fakeModel(["Reply.\n```actions\n[{\"kind\":\"resolution\",\"steps\":[],\"settle\":{\"kind\":\"backlog\"}}]\n```"]);
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
    assert.equal(writes.length, 5);
    assert.ok(writes.every((r) => r.operator === true));
    // A second message while Opus has not answered the first is refused.
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "More" }));
    await assert.rejects(() => conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Again" })), (e) => e instanceof HttpError && e.status === 409);
  });
});

describe("Opus starts a conversation", () => {
});
