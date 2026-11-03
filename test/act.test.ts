import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf, setCommentApproval } from "../src/act/approval.ts";
import { askCloseDecisions, closeDecisionId, commentPreview, runAct, writeEffect, type ActDeps } from "../src/act/index.ts";
import { getDecision } from "../src/decisions.ts";
import { MERGE_OPTIONS, HEAD_FACT } from "../src/merge/queue.ts";
import { prCloseComment, scopeCloseComment } from "../src/act/templates.ts";
import { ask } from "../src/decisions.ts";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "act-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const quiet = () => {};

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at) VALUES ('app', 'op', ?)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('helper', 'maintainer')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES ('app', ?, ?, 'OPEN', ?, 'someone', ?, '${T0}', '${T0}')`);
  item.run(1, "issue", "Issue 1", null);
  item.run(2, "pr", "PR 2", "sha2");
  item.run(3, "pr", "PR 3", "sha3");
  item.run(4, "pr", "PR 4", "sha4");
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason, duplicate_of) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'S', ?, ?, ?)`);
  review.run(2, "sha2", "close", "Does not match the reference app @bob", null);
  review.run(3, "sha3", "close", "Same fix as #2", "app#2");
  review.run(4, "sha4", "hold", "unsure", null);
  setCommentApproval(db, "op", "app", true);
  return db;
}

type Gh = { heads?: Map<number, string>; closed?: Set<number>; failClose?: Set<number> };
function fakes(log: string[], f: Gh = {}): ActDeps {
  const querier: Querier = {
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number; id?: string; body?: string };
      if (query.startsWith("mutation") && query.includes("addComment")) { log.push(`comment ${v.id}: ${v.body}`); return { addComment: { commentEdge: { node: { url: `https://x/${v.id}#c` } } } }; }
      if (query.startsWith("mutation")) {
        if (f.failClose?.has(Number(v.id!.slice(1)))) throw new Error("boom");
        log.push(`close ${v.id}`);
        return {};
      }
      log.push(`read ${v.n}`);
      const n = v.n!;
      const state = f.closed?.has(n) ? "CLOSED" : "OPEN";
      return { repository: { issueOrPullRequest: n === 1 ? { __typename: "Issue", id: "I1", state } : { __typename: "PullRequest", id: `P${n}`, state, headRefOid: f.heads?.get(n) ?? `sha${n}` } } };
    },
  };
  return { querier, now: () => new Date(T1) };
}

const answer = (db: DatabaseSync, id: string, by: string, key: string) =>
  db.prepare("UPDATE decisions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(key, by, T1, id);
const scope = (db: DatabaseSync, n: number, publicText: string | null = null) =>
  ask(db, [{ id: `app#${n}:scope`, kind: "scope", repo: "app", number: n, question: "Scope?", options: [{ key: "take", label: "T" }, { key: "close", label: "C" }], public_text: publicText }]);
const rows = (db: DatabaseSync, t: string) => db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
const run = (db: DatabaseSync, d: ActDeps, limit?: number) => runAct(db, { repo: "app", dryRun: false, limit }, quiet, d);

describe("act", () => {
  test("only an operator's close answer acts, and not without the repo's approval", async () => {
    const db = fresh();
    scope(db, 1);
    scope(db, 2);
    answer(db, "app#1:scope", "helper", "close");
    answer(db, "app#2:scope", "op", "take");
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(log.filter((l) => !l.startsWith("read")), []);
    answer(db, "app#1:scope", "op", "close");
    setCommentApproval(db, "op", "app", false);
    assert.equal(commentApprovalOf(db, "app"), null);
    const s = await run(db, fakes(log));
    assert.match(s.note!, /not approved/);
    assert.deepEqual(log, []);
    assert.equal(rows(db, "actions").length, 0);
  });

  test("scope close comments, closes, records, audits and is idempotent", async () => {
    const db = fresh();
    scope(db, 1, "Not part of the reference app.");
    answer(db, "app#1:scope", "op", "close");
    const log: string[] = [];
    const s = await run(db, fakes(log));
    assert.deepEqual(s.done, ["app#1"]);
    assert.deepEqual(log, ["read 1", `comment I1: ${scopeCloseComment("Not part of the reference app.")}`, "close I1"]);
    const a = rows(db, "actions");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.state, "done");
    assert.equal(a[0]!.comment_url, "https://x/I1#c");
    assert.ok(db.prepare("SELECT applied_at FROM decisions WHERE id = 'app#1:scope'").get());
    assert.deepEqual(rows(db, "audit").filter((r) => String(r.action).startsWith("act-")).map((r) => r.action), ["act-comment", "act-close"]);
    const before = log.length;
    await run(db, fakes(log));
    assert.equal(log.length, before);
    assert.equal(rows(db, "actions").length, 1);
  });

  test("an item closed already is skipped without a comment", async () => {
    const db = fresh();
    scope(db, 1);
    answer(db, "app#1:scope", "op", "close");
    const log: string[] = [];
    const s = await run(db, fakes(log, { closed: new Set([1]) }));
    assert.equal(s.skipped.length, 1);
    assert.deepEqual(log, ["read 1"]);
    assert.equal(rows(db, "actions")[0]!.state, "skipped");
    assert.ok((db.prepare("SELECT applied_at FROM decisions WHERE id = 'app#1:scope'").get() as { applied_at: string | null }).applied_at);
  });

  test("Close? is asked once per head, not for holds, and a moved head is skipped", async () => {
    const db = fresh();
    const log: string[] = [];
    const s = await run(db, fakes(log));
    assert.deepEqual(s.asked, [closeDecisionId("app", 2, "sha2"), closeDecisionId("app", 3, "sha3")]);
    assert.deepEqual(askCloseDecisions(db, "app", T1), []);
    const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(closeDecisionId("app", 2, "sha2")) as { question: string; options: string; public_text: string };
    assert.equal(d.question, "Close this PR?");
    assert.deepEqual((JSON.parse(d.options) as { key: string }[]).map((o) => o.key), ["close", "hold", "keep"]);
    assert.ok(!d.public_text.includes("@"));
    assert.equal(rows(db, "decisions").filter((r) => r.id === closeDecisionId("app", 4, "sha4")).length, 0);

    answer(db, closeDecisionId("app", 2, "sha2"), "op", "close");
    answer(db, closeDecisionId("app", 3, "sha3"), "op", "close");
    const log2: string[] = [];
    const s2 = await run(db, fakes(log2, { heads: new Map([[2, "newer"]]) }));
    assert.deepEqual(s2.skipped.map((x) => x.ref), ["app#2"]);
    assert.deepEqual(s2.done, ["app#3"]);
    assert.equal(log2.filter((l) => l.startsWith("comment")).length, 1);
  });

  test("Merge? Close comments and closes like Close?, merge and hold write nothing here", async () => {
    const db = fresh();
    const id = "app#2:merge@sha2";
    ask(db, [{ id, kind: "merge", repo: "app", number: 2, question: "Merge this PR?", facts: [`${HEAD_FACT}sha2`], options: Object.values(MERGE_OPTIONS).map((o) => ({ ...o })), recommended: "merge" }]);
    assert.equal(commentPreview(getDecision(db, id)!), prCloseComment({ repo: "app", reason: null, duplicateOf: null }));
    assert.deepEqual(Object.values(MERGE_OPTIONS).map((o) => writeEffect("merge", o.key)), ["merges on GitHub", null, "closes the PR on GitHub"]);
    answer(db, id, "op", "merge");
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(log, []);
    db.prepare("UPDATE decisions SET answer = 'close' WHERE id = ?").run(id);
    const log2: string[] = [];
    const s = await run(db, fakes(log2));
    assert.deepEqual(s.done, ["app#2"]);
    assert.match(log2.join("\n"), /comment .*Closing this pull request\./);
    assert.ok(log2.some((l) => l.startsWith("close")));
  });

  test("a duplicate gets the Duplicate of line", async () => {
    assert.equal(prCloseComment({ repo: "app", reason: "x", duplicateOf: "app#2" }), "Closing this pull request. Duplicate of #2.");
    assert.equal(prCloseComment({ repo: "app", reason: "x", duplicateOf: "other#9" }), "Closing this pull request. Duplicate of storytold/other#9.");
    assert.equal(prCloseComment({ repo: "app", reason: "Too broad", duplicateOf: null }), "Closing this pull request.\nReason: Too broad.");
    const db = fresh();
    await run(db, fakes([]));
    answer(db, closeDecisionId("app", 3, "sha3"), "op", "close");
    const log: string[] = [];
    await run(db, fakes(log));
    assert.ok(log.some((l) => l.endsWith("Closing this pull request. Duplicate of #2.")));
  });

  test("a failed close keeps the posted comment and does not comment twice on retry", async () => {
    const db = fresh();
    scope(db, 2);
    answer(db, "app#2:scope", "op", "close");
    const log: string[] = [];
    const s = await run(db, fakes(log, { failClose: new Set([2]) }));
    assert.equal(s.failed.length, 1);
    assert.equal(rows(db, "actions")[0]!.state, "failed");
    await run(db, fakes(log));
    assert.equal(log.filter((l) => l.startsWith("comment")).length, 1);
    assert.equal(rows(db, "actions")[0]!.state, "done");
  });
});

describe("comment text from a model", () => {
  test("cleanReason drops URLs, Markdown links and mentions", async () => {
    const { cleanReason } = await import("../src/act/templates.ts");
    assert.equal(cleanReason("See [the docs](https://x.example/a) or https://evil.example/p?q=1 and www.evil.example, thanks @bob"), "See the docs or and thanks bob.");
    assert.equal(cleanReason("<https://evil.example> ![img](http://a.b/c.png)"), "img.");
  });
});
