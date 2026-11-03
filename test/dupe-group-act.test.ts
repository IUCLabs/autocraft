// Act for duplicate group decisions: the stored comments are posted as they are, keep:N rebuilds them,
// a crash midway never repeats a write, a changed member waits or is skipped. Fake GitHub, no model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { commentPreview, runAct, writeEffect, type ActDeps } from "../src/act/index.ts";
import { connect } from "../src/db.ts";
import { getDecision } from "../src/decisions.ts";
import { runDupeCompare, type CompareDeps, type Reply } from "../src/dupes/compare.ts";
import { applyDuplicateAnswers } from "../src/dupes/decide.ts";
import { dupeGroupCloseComment, dupeGroupDetailsComment } from "../src/act/templates.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";

// Documents are validated against GitHub's schema when the helper exists in this tree.
const GQL = "./gql.ts";
const validating: (q: Querier) => Querier = await import(GQL).then((m: any) => m.validating as (q: Querier) => Querier, () => (q: Querier) => q);

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "dupe-group-act-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-06-01T00:00:00Z";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null };
const quiet = () => {};
const PR_GROUP = "app:dupegroup:11";
const ISSUE_GROUP = "app:dupegroup:1";

/** Issues 1 (kept), 2, 3 and PRs 11 (kept), 12, 13, each set a group; the comparison replies are fixed. */
async function world(): Promise<DatabaseSync> {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at) VALUES ('app', 'op', ?)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, created_at, updated_at, comments_count, embed_hash, head_oid)
    VALUES ('app', ?, ?, 'OPEN', ?, 'body', ?, ?, 0, ?, ?)`);
  for (const n of [1, 2, 3, 11, 12, 13]) item.run(n, n < 10 ? "issue" : "pr", `Item ${n}`, `2026-01-0${n % 9 + 1}T00:00:00Z`, T0, `h${n}`, n < 10 ? null : `sha${n}`);
  const pair = db.prepare(`INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at)
    VALUES ('app', ?, ?, ?, ?, 0.95, 0.95, 'duplicate', ?, ?, ?)`);
  for (const [a, b] of [[1, 2], [1, 3], [11, 12], [11, 13]]) pair.run(a, b, `h${a}`, `h${b}`, a, T0, T0);
  const cd: CompareDeps = {
    fetchDiff: async () => ({ ok: true, text: "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\n" }),
    baseCheckout: async () => "/checkout/base",
    ask: (async (id: string): Promise<Reply> => ({
      text: id === "dupes.compare-prs.opus"
        ? JSON.stringify({ keep: 11, reason: "most complete", others: [{ number: 12, duplicate: true, better: ["master pages"], carry: ["master-page handling in src/a.rs"] }, { number: 13, duplicate: true, better: [], carry: [] }] })
        : JSON.stringify({ keep: 1, reason: "first report", others: [{ number: 2, adds: ["Happens on macOS 14 only."] }, { number: 3, adds: ["Started after version 2.3.", "Log: panic in layout"] }] }),
      usage: USAGE,
    })) as CompareDeps["ask"],
    now: () => new Date(T1),
  };
  await runDupeCompare(db, {}, quiet, cd);
  setCommentApproval(db, "op", "app", true);
  return db;
}

const answer = (db: DatabaseSync, id: string, key: string) => {
  db.prepare("UPDATE decisions SET answer = ?, answered_by = 'op', answered_at = ? WHERE id = ?").run(key, T1, id);
  applyDuplicateAnswers(db, T1);
};
const state = (db: DatabaseSync, id: string) => getDecision(db, id)!;

type Gh = { heads?: Map<number, string>; closed?: Set<number>; failCloseOnce?: Set<number> };
function fakes(log: string[], f: Gh = {}): ActDeps {
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number; id?: string; body?: string };
      if (query.includes("addComment")) { log.push(`comment ${v.id}: ${v.body}`); return { addComment: { commentEdge: { node: { url: `https://x/${v.id}#c` } } } }; }
      if (query.startsWith("mutation")) {
        const n = Number(v.id!.slice(1));
        if (f.failCloseOnce?.delete(n)) throw new Error("boom");
        log.push(`close ${v.id}`);
        return {};
      }
      const n = v.n!;
      const st = f.closed?.has(n) ? "CLOSED" : "OPEN";
      return { repository: { issueOrPullRequest: n < 10 ? { __typename: "Issue", id: `I${n}`, state: st } : { __typename: "PullRequest", id: `P${n}`, state: st, headRefOid: f.heads?.get(n) ?? `sha${n}` } } };
    },
  });
  return { querier, now: () => new Date(T1) };
}
const run = (db: DatabaseSync, d: ActDeps, limit?: number) => runAct(db, { repo: "app", dryRun: false, limit }, quiet, d);
const writes = (log: string[]) => log.filter((l) => !l.startsWith("read"));
const CLOSE_12 = dupeGroupCloseComment({ kept: 11, carry: ["master-page handling in src/a.rs"] });
const CLOSE_13 = dupeGroupCloseComment({ kept: 11, carry: [] });

describe("group comments", () => {
  test("the comparison stores the exact texts and the decision shows them", async () => {
    const db = await world();
    const rows = db.prepare("SELECT number, comment FROM dupe_group_items WHERE decision_id IN (?, ?) ORDER BY number").all(PR_GROUP, ISSUE_GROUP) as { number: number; comment: string | null }[];
    const text = new Map(rows.map((r) => [r.number, r.comment]));
    assert.equal(text.get(12), CLOSE_12);
    assert.equal(text.get(13), CLOSE_13);
    assert.equal(text.get(11), null);
    assert.equal(text.get(2), "Closing as a duplicate of #1.");
    assert.equal(text.get(1), dupeGroupDetailsComment([{ number: 2, points: ["Happens on macOS 14 only."] }, { number: 3, points: ["Started after version 2.3.", "Log: panic in layout"] }]));
    assert.match(text.get(1)!, /^Details from the closed duplicates:\n- #2: Happens on macOS 14 only\.\n- #3: Started after version 2\.3\.\n- #3: Log: panic in layout\.$/);
    const preview = commentPreview(state(db, PR_GROUP), db)!;
    assert.ok(preview.includes(CLOSE_12) && preview.includes(CLOSE_13));
    assert.equal(writeEffect("duplicate", "keep:12"), writeEffect("duplicate", "accept"));
  });

  test("details bullets are plain: links, mentions and extra length are cleaned, at most six", () => {
    const t = dupeGroupDetailsComment([{ number: 5, points: ["see [log](http://evil.example/x) @bob", ...Array.from({ length: 9 }, (_, i) => `point ${i}`)] }])!;
    const lines = t.split("\n").slice(1);
    assert.equal(lines.length, 6);
    assert.equal(lines[0], "- #5: see log bob.");
    assert.ok(lines.every((l) => /^- #5: [^@]*$/.test(l) && !l.includes("http")));
  });
});

describe("act on group decisions", () => {
  test("accept posts exactly the stored texts, closes the members, sets applied_at, and runs once", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    answer(db, ISSUE_GROUP, "accept");
    const log: string[] = [];
    const s = await run(db, fakes(log));
    assert.deepEqual(writes(log), [
      `comment I1: ${dupeGroupDetailsComment([{ number: 2, points: ["Happens on macOS 14 only."] }, { number: 3, points: ["Started after version 2.3.", "Log: panic in layout"] }])}`,
      "comment I2: Closing as a duplicate of #1.", "close I2", "comment I3: Closing as a duplicate of #1.", "close I3",
      `comment P12: ${CLOSE_12}`, "close P12", `comment P13: ${CLOSE_13}`, "close P13",
    ]);
    assert.deepEqual(s.done.sort(), ["app#12", "app#13", "app#2", "app#3"]);
    for (const id of [PR_GROUP, ISSUE_GROUP]) assert.ok(state(db, id).applied_at);
    assert.deepEqual(db.prepare("SELECT number, state FROM dupe_carries").all().map((r) => ({ ...r })), [{ number: 11, state: "queued" }]);
    const again: string[] = [];
    await run(db, fakes(again));
    assert.deepEqual(writes(again), []);
  });

  test("nothing is written without comment approval, and a dry run writes nothing", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    db.prepare("DELETE FROM settings WHERE key LIKE 'comment_approved:%'").run();
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(log, []);
    setCommentApproval(db, "op", "app", true);
    await runAct(db, { repo: "app", dryRun: true }, quiet, fakes(log));
    assert.deepEqual(log, []);
    assert.equal(state(db, PR_GROUP).applied_at, null);
  });

  test("keep:N rebuilds the texts for the new roles and posts those", async () => {
    const db = await world();
    answer(db, PR_GROUP, "keep:12");
    const text = (n: number) => (db.prepare("SELECT comment FROM dupe_group_items WHERE decision_id = ? AND number = ?").get(PR_GROUP, n) as { comment: string | null }).comment;
    assert.equal(text(11), "Closing as a duplicate of #12.");
    assert.equal(text(13), "Closing as a duplicate of #12.");
    assert.equal(text(12), null);
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(writes(log), ["comment P11: Closing as a duplicate of #12.", "close P11", "comment P13: Closing as a duplicate of #12.", "close P13"]);
    // The issue group is untouched: its texts still name #1.
    assert.equal(state(db, ISSUE_GROUP).applied_at, null);
  });

  test("a crash between comment and close does not comment twice; the limit stops the run", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    const log: string[] = [];
    const s = await run(db, fakes(log, { failCloseOnce: new Set([12]) }));
    assert.equal(s.failed.length, 1);
    assert.deepEqual(writes(log), [`comment P12: ${CLOSE_12}`]);
    assert.equal(state(db, PR_GROUP).applied_at, null);
    const log2: string[] = [];
    await run(db, fakes(log2), 1);
    assert.deepEqual(writes(log2), ["close P12"]);
    const log3: string[] = [];
    await run(db, fakes(log3));
    assert.deepEqual(writes(log3), [`comment P13: ${CLOSE_13}`, "close P13"]);
    assert.ok(state(db, PR_GROUP).applied_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'act-comment' AND target = 'app#12'").get()!.n, 1);
  });

  test("a member that closed is skipped for good; one whose head moved waits for a later run", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    const log: string[] = [];
    const s = await run(db, fakes(log, { closed: new Set([13]), heads: new Map([[12, "newsha"]]) }));
    assert.deepEqual(writes(log), []);
    assert.deepEqual(s.skipped.map((x) => x.ref).sort(), ["app#12", "app#13"]);
    assert.equal(state(db, PR_GROUP).applied_at, null);
    // The mirror sees the new head: the stored comment still goes out.
    db.prepare("UPDATE items SET head_oid = 'newsha' WHERE repo = 'app' AND number = 12").run();
    const log2: string[] = [];
    await run(db, fakes(log2, { closed: new Set([13]), heads: new Map([[12, "newsha"]]) }));
    assert.deepEqual(writes(log2), [`comment P12: ${CLOSE_12}`, "close P12"]);
    assert.ok(state(db, PR_GROUP).applied_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dupe_carries").get()!.n, 1);
  });
});
