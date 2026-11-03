// Act for duplicate group decisions: the stored comments are posted as they are, keep:N rebuilds them,
// a crash midway never repeats a write, a changed member waits or is skipped. Fake GitHub, no model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { runAct, writeEffect, type ActDeps } from "../src/act/index.ts";
import { connect } from "../src/db.ts";
import { getDecision } from "../src/decisions.ts";
import { duplicateHeld } from "../src/dupes/held.ts";
import { kindSetsOf, duplicateGroups } from "../src/dupes/plan.ts";
import { askGroupDecisions } from "../src/dupes/decide.ts";
import { cleanReason } from "../src/act/templates.ts";
import { runDupeCompare, type CompareDeps, type Reply } from "../src/dupes/compare.ts";
import { applyDuplicateAnswers, resetGroupAnswer } from "../src/dupes/decide.ts";
import { optionTextsOf, textsFor } from "../src/dupes/texts.ts";
import { carryAskText } from "../src/fixup/template.ts";
import { dupeGroupCloseComment, dupeGroupDetailsComment } from "../src/act/templates.ts";
import type { Querier } from "../src/mirror.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";


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

type Gh = { onRead?: (n: number) => void; heads?: Map<number, string>; closed?: Set<number>; failCloseOnce?: Set<number> };
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
      f.onRead?.(n);
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
  test("the comparison stores the exact texts of every option and the decision shows them", async () => {
    const db = await world();
    const text = (id: string, option: string, n: number, step: string) => textsFor(db, id, option).find((t) => t.number === n && t.step === step)?.text;
    assert.equal(text(PR_GROUP, "accept", 12, "close"), CLOSE_12);
    assert.match(CLOSE_12, /\nParts to carry over to #11: master-page handling in src\/a\.rs\.$/);
    assert.equal(text(PR_GROUP, "accept", 13, "close"), CLOSE_13);
    assert.equal(text(PR_GROUP, "accept", 11, "close"), undefined);
    assert.equal(text(PR_GROUP, "accept", 11, "suggestion"), carryAskText([{ number: 12, points: ["master-page handling in src/a.rs"] }]));
    // keep:12 has its own set, fixed now: #11 and #13 close onto #12.
    assert.equal(text(PR_GROUP, "keep:12", 11, "close"), "Closing as a duplicate of #12.");
    assert.equal(text(PR_GROUP, "keep:12", 13, "close"), "Closing as a duplicate of #12.");
    assert.equal(text(ISSUE_GROUP, "accept", 2, "close"), "Closing as a duplicate of #1.");
    const details = dupeGroupDetailsComment([{ number: 2, points: ["Happens on macOS 14 only."] }, { number: 3, points: ["Started after version 2.3.", "Log: panic in layout"] }]);
    assert.equal(text(ISSUE_GROUP, "accept", 1, "details"), details);
    assert.match(details!, /^Details from the closed duplicates:\n- #2: Happens on macOS 14 only\.\n- #3: Started after version 2\.3\.\n- #3: Log: panic in layout\.$/);
    const shown = optionTextsOf(db, PR_GROUP);
    assert.deepEqual(shown.map((o) => o.option).sort(), ["accept", "keep:12", "keep:13"]);
    assert.notEqual(shown[0]!.hash, shown[1]!.hash);
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

  test("keep:N posts the set stored for that option when the decision was asked", async () => {
    const db = await world();
    const before = textsFor(db, PR_GROUP, "keep:12");
    answer(db, PR_GROUP, "keep:12");
    assert.deepEqual(textsFor(db, PR_GROUP, "keep:12"), before);
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(writes(log), ["comment P11: Closing as a duplicate of #12.", "close P11", "comment P13: Closing as a duplicate of #12.", "close P13"]);
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

  test("a member that closed or whose head moved is skipped and recorded; the rest is closed", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    const log: string[] = [];
    const s = await run(db, fakes(log, { closed: new Set([13]), heads: new Map([[12, "newsha"]]) }));
    assert.deepEqual(writes(log), []);
    assert.deepEqual(s.skipped.map((x) => x.ref).sort(), ["app#12", "app#13"]);
    assert.ok(state(db, PR_GROUP).applied_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dupe_carries").get()!.n, 0);
  });

  test("a kept item that was closed stops the decision before any write", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    const log: string[] = [];
    await run(db, fakes(log, { closed: new Set([11]) }));
    assert.deepEqual(writes(log), []);
    assert.equal(state(db, PR_GROUP).applied_at, null);
  });

  test("a member that keeps failing is skipped after three tries and later groups go on", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    answer(db, ISSUE_GROUP, "accept");
    const bad = fakes([], {});
    const real = bad.querier.query.bind(bad.querier);
    bad.querier.query = async (q: string, v: object) => {
      if (q.includes("addComment") && (v as { id: string }).id === "P12") throw new Error("locked");
      return real(q, v);
    };
    for (let i = 0; i < 2; i++) assert.equal((await run(db, bad)).failed.length, 1);
    const s = await run(db, bad);
    assert.ok(s.skipped.some((x) => x.ref === "app#12"));
    const s2 = await run(db, bad);
    assert.ok(state(db, PR_GROUP).applied_at && state(db, ISSUE_GROUP).applied_at, JSON.stringify([s2, s]));
  });

  test("an undo while the run reads a member stops that decision before any write", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    const log: string[] = [];
    await run(db, fakes(log, { onRead: (n) => { if (n === 12) { db.prepare("UPDATE decisions SET answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?").run(PR_GROUP); resetGroupAnswer(db, PR_GROUP); } } }));
    assert.deepEqual(writes(log), []);
    assert.equal(state(db, PR_GROUP).applied_at, null);
  });

  test("undo and a new answer leave the stored texts of every option as they were shown", async () => {
    const db = await world();
    const all = () => JSON.stringify(optionTextsOf(db, PR_GROUP));
    const shown = all();
    answer(db, PR_GROUP, "keep:12");
    db.prepare("UPDATE decisions SET answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?").run(PR_GROUP);
    resetGroupAnswer(db, PR_GROUP);
    answer(db, PR_GROUP, "keep:13");
    assert.equal(all(), shown);
    const log: string[] = [];
    await run(db, fakes(log));
    assert.deepEqual(writes(log).filter((l) => l.startsWith("comment")), [`comment P11: ${textsFor(db, PR_GROUP, "keep:13").find((t) => t.number === 11)!.text}`, `comment P12: ${textsFor(db, PR_GROUP, "keep:13").find((t) => t.number === 12)!.text}`]);
  });

  test("a PR our Act closed is no longer a member of its group's comparison sets", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    await run(db, fakes([]));
    db.prepare("UPDATE items SET state = 'OPEN' WHERE repo = 'app' AND number IN (12, 13)").run();
    const g = duplicateGroups(db, "app").find((x) => x.members.includes(11))!;
    assert.deepEqual(kindSetsOf(db, g).flatMap((s) => s.members.map((m) => m.number)), [11]);
  });

  test("an answer waiting for Act is not met by a second decision for the same members", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    askGroupDecisions(db, "app", T1);
    assert.deepEqual(db.prepare("SELECT id FROM decisions WHERE id LIKE 'app:dupegroup:11%'").all().map((r: any) => r.id), [PR_GROUP]);
  });
});

describe("released members", () => {
  test("a member skipped as stale is released and the next comparison plans a new decision for it", async () => {
    const db = await world();
    answer(db, PR_GROUP, "accept");
    assert.equal(duplicateHeld(db, "app", 12), true);
    await run(db, fakes([], { heads: new Map([[12, "newsha"]]) }));
    assert.equal(duplicateHeld(db, "app", 12), false);
    assert.equal(db.prepare("SELECT role FROM dupe_group_items WHERE decision_id = ? AND number = 12").get(PR_GROUP)!.role, "stay");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'duplicate-member-released'").get()!.n, 1);
    // The mirror sees the new head; the comparison runs again for the released member.
    db.prepare("UPDATE items SET head_oid = 'newsha' WHERE repo = 'app' AND number = 12").run();
    const cd: CompareDeps = {
      fetchDiff: async () => ({ ok: true, text: "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\n" }),
      baseCheckout: async () => "/checkout/base",
      ask: (async (): Promise<Reply> => ({ text: JSON.stringify({ keep: 11, reason: "again", others: [{ number: 12, duplicate: true, better: [], carry: [] }] }), usage: USAGE })) as CompareDeps["ask"],
      now: () => new Date(T1),
    };
    db.prepare("UPDATE items SET state = 'CLOSED' WHERE repo = 'app' AND number = 13").run();
    const r = await runDupeCompare(db, {}, quiet, cd);
    assert.ok(r.asked.includes("app:dupegroup:12"));
    assert.deepEqual(db.prepare("SELECT number, role FROM dupe_group_items WHERE decision_id = 'app:dupegroup:12' ORDER BY number").all().map((x: any) => `${x.number}:${x.role}`), ["11:keep", "12:close"]);
    assert.equal(duplicateHeld(db, "app", 12), true);
  });
});

describe("cleanReason", () => {
  test("strips HTML tags, protocol-relative links and cross-repo references", () => {
    assert.equal(cleanReason("see <b>this</b> //evil.example/x and other/repo#12 plus <img src=x onerror=y> @bob"), "see this and plus bob.");
  });
});
