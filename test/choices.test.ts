// Decision choices: a core plus ticked extras composes into one resolution that runs through doCard; extras a core does
// not take are refused; a comment goes with the merge answer only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { validateCard } from "../src/conversations/cards.ts";
import { doCard } from "../src/conversations/act.ts";
import { applyDrafts, compose, coresFor, currentChoices, mergeChoices, writeChoices } from "../src/decide/choices.ts";
import { coreKey } from "../src/decide/choices-types.ts";
import { parseChoices } from "../src/decide/choices-parse.ts";
import { parsePrepareReply } from "../src/decide/prepare.ts";
import { insertTurn, opusBlock } from "../src/conversations/store.ts";
import { connect } from "../src/db.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { choicesView } from "../src/dash/api/conversations.ts";

mkdirSync(SCRATCH, { recursive: true });
const T0 = "2026-01-01T00:00:00Z";

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "choices-test-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  useTestAccount(db);
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, head_oid, created_at, updated_at, labels) VALUES ('app', ?, ?, 'OPEN', ?, 'Body', 'someone', ?, '${T0}', '${T0}', '[]')`);
  item.run(1, "issue", "Issue 1", null);
  item.run(2, "pr", "PR 2", "sha2");
  ask(db, [
    { id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }] },
    { id: "app#2:merge", kind: "merge", repo: "app", number: 2, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "hold", label: "Hold" }] },
  ]);
  setCommentApproval(db, "op", "app", true);
  return db;
}

const choose = (db: DatabaseSync, decision: string, key: string, ticked: Parameters<typeof compose>[1], params = {}) => {
  const d = getDecision(db, decision)!;
  const core = applyDrafts(db, d, coresFor(db, d), currentChoices(db, decision)).find((c) => c.key === key)!;
  return { d, core, composed: compose(core, ticked, params) };
};

describe("decision choices", () => {
  test("a merge core with a ticked open_issue extra composes, validates and runs through doCard", async () => {
    const db = fresh();
    const d = getDecision(db, "app#2:merge")!;
    writeChoices(db, {
      decisionId: d.id, repo: "app", number: 2, turnId: null, stamp: "x", seen: { head: "sha2", lastComment: null }, source: "prepare",
      drafts: { [coreKey.option("merge")]: { extras: [{ id: "open_issue", kind: "open_issue", on: true, repo: "app", title: "Follow up", body: "Check the edge case." }] } },
      added: [], pick: { core: coreKey.option("merge"), reason: "Looks right." },
    });
    assert.equal((db.prepare("SELECT recommended FROM decisions WHERE id = ?").get(d.id) as { recommended: string }).recommended, "merge");
    const view = choicesView(db, "app", 2)!;
    const merge = view.cores.find((c) => c.key === "o:merge")!;
    assert.deepEqual(merge.writes, ["merge"]);
    assert.deepEqual(merge.extras.map((e) => [e.id, e.on]), [["open_issue", true], ["comment", false]]);

    const { composed } = choose(db, d.id, "o:merge", [{ id: "open_issue", kind: "open_issue", repo: "app", title: "Follow up", body: "Check the edge case." }]);
    assert.ok("card" in composed);
    const v = validateCard(db, "app", 2, composed.card);
    assert.ok("card" in v, "note" in v ? v.note : "");
    const id = Number(db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, text, description) VALUES (0, 'app', 2, 'resolution', ?, NULL, ?)")
      .run(JSON.stringify(v.card.params), v.card.description).lastInsertRowid);
    const querier = { query: async () => ({}) };
    const exec = async () => ({ code: 0, stdout: "https://github.com/storytold/app/issues/7\n", stderr: "" });
    const { card } = await doCard(db, id, "op", { querier: querier as never, exec: exec as never });
    assert.equal(card.state, "done", card.error ?? "");
    assert.equal(getDecision(db, d.id)!.answer, "merge");
    assert.equal(currentChoices(db, d.id), undefined, "settling replaces the choices");
  });

  test("an extra the core does not take is refused", () => {
    const db = fresh();
    // Hold takes no open_issue; the merge answer takes no request_reviewers; a backlog core takes no extras.
    assert.ok("note" in choose(db, "app#2:merge", "o:hold", [{ id: "open_issue", kind: "open_issue", repo: "app", title: "t", body: "b" }]).composed);
    assert.ok("note" in choose(db, "app#2:merge", "o:merge", [{ id: "request_reviewers", kind: "request_reviewers", logins: ["x"] }]).composed);
    assert.ok("note" in choose(db, "app#2:merge", "backlog", [{ id: "comment", kind: "comment", text: "t" }]).composed);
  });

  test("merge takes a comment before the answer; a closing option takes none", () => {
    const db = fresh();
    const check = (decision: string, n: number, key: string) => {
      const c = choose(db, decision, key, [{ id: "comment", kind: "comment", text: "Thanks, merging." }]).composed;
      assert.ok("card" in c, "note" in c ? c.note : "");
      return validateCard(db, "app", n, c.card);
    };
    assert.ok("card" in check("app#2:merge", 2, "o:merge"));
    // Out of scope closes: comment is not an extra there, and a hand-built card is refused too.
    assert.ok("note" in choose(db, "app#1:scope", "o:close", [{ id: "comment", kind: "comment", text: "x" }]).composed);
    const raw = { kind: "resolution", steps: [{ kind: "comment" }], settle: { kind: "answer", option: "close" }, text: "Closing." };
    assert.ok("note" in validateCard(db, "app", 1, raw));
  });

  test("merging a turn's block replaces the listed cores whole, keeps the rest and caps the added cores", () => {
    const db = fresh();
    const base = { turnId: 5, stamp: "s", seen: { head: null, lastComment: null }, pick: { core: coreKey.option("take"), reason: "r" } };
    mergeChoices(db, "app#1:scope", { ...base, cores: { "o:take": { extras: [{ kind: "comment", on: true, text: "A" }] }, "o:close": { extras: [{ kind: "label", on: false, label: "bugfix" }] } } });
    const { row, notes } = mergeChoices(db, "app#1:scope", {
      ...base, cores: { "o:take": { extras: [{ kind: "comment", on: false, text: "B" }] } },
      add: [coreKey.close("completed"), coreKey.close("not_planned"), coreKey.review, coreKey.fixup].map((key) => ({ key, draft: { extras: [] } })),
    });
    assert.equal(row.drafts["o:take"]!.extras[0]!.text, "B");
    assert.ok(row.drafts["o:close"]);
    assert.equal(row.added.length, 3);
    assert.equal(notes.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decision_choices WHERE state = 'current'").get()!.n, 1);
  });

  const block = (o: unknown) => `Summary text.\n\`\`\`choices\n${JSON.stringify(o)}\n\`\`\``;

  test("parseChoices keeps a valid core with its extras and drops an extra the core does not take, with a note", () => {
    const db = fresh();
    const d = getDecision(db, "app#2:merge")!;
    const r = parseChoices(db, "app", 2, d, block({
      pick: { core: "o:merge", reason: "Looks right." },
      cores: [{ core: "o:merge", extras: [
        { kind: "comment", on: true, text: "Thanks, merging." },
        { kind: "open_issue", on: true, repo: "app", title: "Follow up", body: "Check the edge case." },
        { kind: "request_reviewers", on: true, logins: ["x"] },
      ] }],
    }))!;
    assert.deepEqual(r.choices!.cores["o:merge"]!.extras.map((e) => e.kind), ["comment", "open_issue"]);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0]!, /request_reviewers extra of o:merge/);
    assert.deepEqual(r.choices!.pick, { core: "o:merge", reason: "Looks right." });
    // A core that does not validate is dropped and a pick on it is lost; a fix-up core needs instructions.
    const bad = parseChoices(db, "app", 2, d, block({ pick: { core: "fixup-merge", reason: "x" }, cores: [{ core: "fixup-merge", instructions: "", extras: [] }] }))!;
    assert.equal(bad.pickLost, "fixup-merge");
    assert.deepEqual(bad.choices!.cores, {});
    assert.equal(parseChoices(db, "app", 2, d, "Only text.")!.choices, null);
  });

  test("a prepare reply with a choices block writes a choices row with the pick and the recommendation", () => {
    const db = fresh();
    const d = getDecision(db, "app#2:merge")!;
    const text = "The PR changes the export path and the reference app does the same, so it can be merged as it is after the follow-up is filed.";
    const got = parsePrepareReply(db, { repo: "app", n: 2, d, single: true }, `${text}\n\`\`\`choices\n${JSON.stringify({
      pick: { core: "o:merge", reason: "Same as the reference app." },
      cores: [{ core: "o:merge", extras: [{ kind: "open_issue", on: true, repo: "app", title: "Follow up", body: "Check the edge case." }] }],
      ask: { text: "Which version do you run?" },
    })}\n\`\`\``)!;
    assert.equal(got.pick, "merge");
    assert.ok(got.ask);
    insertTurn(db, "app", 2, { kind: "opus", login: "opus", body: got.text, block: opusBlock(got.text, [got.ask!], got.choices), cards: [got.ask!], choices: { decision: d, parsed: got.choices!, source: "prepare", by: "opus" } });
    const row = currentChoices(db, d.id)!;
    assert.equal(row.source, "prepare");
    assert.deepEqual(row.pick, { core: "o:merge", reason: "Same as the reference app." });
    assert.equal(row.drafts["o:merge"]!.extras[0]!.on, true);
    assert.ok(row.turnId);
    const rec = db.prepare("SELECT recommended, recommended_reason, recommended_by FROM decisions WHERE id = ?").get(d.id) as Record<string, string>;
    assert.deepEqual({ ...rec }, { recommended: "merge", recommended_reason: "Same as the reference app.", recommended_by: "opus" });
    // A single decision without a block is no valid reply; one that only takes a pick may come without.
    assert.equal(parsePrepareReply(db, { repo: "app", n: 2, d, single: true }, text), null);
    assert.equal(parsePrepareReply(db, { repo: "app", n: 2, d, single: false }, text)!.pick, null);
  });
});
