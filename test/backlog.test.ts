// Backlog: an answer every decision offers last. It writes nothing to GitHub, holds the items out of the
// later steps, can be reopened by an operator, and can be given in bulk outside the pilot.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { setCommentApproval } from "../src/act/approval.ts";
import { runAct, type ActDeps } from "../src/act/index.ts";
import { selectCandidates as decideCandidates } from "../src/decide/select.ts";
import { answer, getOne, listDecisions, reopen, backlogBulk } from "../src/dash/api/decisions.ts";
import type { Req } from "../src/dash/types.ts";
import { connect } from "../src/db.ts";
import { actionable, ask, backlogOpen, getDecision } from "../src/decisions.ts";
import { notHeldSql } from "../src/dupes/held.ts";
import { textsHash } from "../src/dupes/texts.ts";
import { buildQueue } from "../src/merge/queue.ts";
import { setPilot } from "../src/pilot.ts";
import type { Querier } from "../src/mirror.ts";
import { selectCandidates as reviewCandidates } from "../src/review/candidates.ts";
import { finalizeReviews } from "./fixture.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "backlog-test-"));
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const quiet = () => {};

const REPOS = ["app", "other"];
const question = (id: string, kind: string, repo: string, number: number | null, extra: Record<string, unknown> = {}) => ({
  id, kind, repo, ...(number === null ? { items: [{ repo, number: 2 }, { repo, number: 3 }] } : { number }), question: `Q ${id}`,
  options: [{ key: "yes", label: "Yes" }, { key: "close", label: "Close" }], asked_at: T0, ...extra,
});

/** Issues 1-3 and PRs 4-9 in `app`, one issue and one PR in `other`; classified and (PRs) reviewed. */
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  for (const r of REPOS) db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at) VALUES (?, 'op', ?)").run(r, T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('viewer', 'viewer')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, head_oid, additions, deletions, changed_files, created_at, updated_at)
    VALUES (?, ?, ?, 'OPEN', ?, 'stranger', ?, 10, 0, 1, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, 'jev', 'r1', '${T0}', 'bugfix', ?, '{"top":0.95}')`);
  const review = db.prepare(`INSERT INTO reviews (repo, number, head_oid, run_id, at, model, size, verdict, reason) VALUES (?, ?, ?, 'rv', '${T0}', 'm', 'S', 'take', 'fine')`);
  for (const [repo, n, kind] of [["app", 1, "issue"], ["app", 2, "issue"], ["app", 3, "issue"], ["app", 4, "pr"], ["app", 5, "pr"], ["app", 6, "pr"], ["app", 7, "pr"], ["app", 8, "pr"], ["app", 9, "pr"], ["other", 1, "issue"], ["other", 2, "pr"]] as const) {
    item.run(repo, n, kind, `${kind} ${n}`, kind === "pr" ? `sha${n}` : null);
    jev.run(repo, n, JSON.stringify(n <= 3 || repo === "other" ? ["needs decision"] : []));
    if (kind === "pr") review.run(repo, n, `sha${n}`);
  }
  finalizeReviews(db);
  setCommentApproval(db, "op", "app", true);
  return db;
}

const req = (role: "operator" | "viewer", params: Record<string, string> = {}, json?: unknown, query = ""): Req =>
  ({ method: "POST", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(), json, csrf: "", nonce: "",
    user: { login: role === "operator" ? "op" : "viewer", role, canWrite: async () => role === "operator", canRead: async () => true } }) as unknown as Req;

/** A group decision about issues 1-3 as the group step stores it: members, roles and the comment texts of "accept". */
function askGroup(db: DatabaseSync, members: number[] = [1, 2, 3]): string {
  const id = `app:dupegroup:${members[0]}`;
  ask(db, [{ ...question(id, "duplicate", "app", members[0]!), options: [{ key: "accept", label: "Use this answer" }, { key: "distinct", label: "Not duplicates" }] }]);
  db.prepare("INSERT INTO dupe_groups (decision_id, repo, source) VALUES (?, 'app', 'model')").run(id);
  for (const n of members) db.prepare("INSERT INTO dupe_group_items (decision_id, repo, number, kind, role, target, base_role, base_target) VALUES (?, 'app', ?, 'issue', ?, ?, ?, ?)")
    .run(id, n, n === members[0] ? "keep" : "close", n === members[0] ? null : members[0], n === members[0] ? "keep" : "close", n === members[0] ? null : members[0]);
  db.prepare("INSERT INTO dupe_group_texts (decision_id, number, option, step, text) VALUES (?, 2, 'accept', 'close', 'Duplicate of #1.')").run(id);
  return id;
}

function recorder(log: string[]): ActDeps {
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number; id?: string; body?: string };
      if (query.startsWith("mutation")) { log.push(query.includes("addComment") ? `comment ${v.id}` : `close ${v.id}`); return query.includes("addComment") ? { addComment: { commentEdge: { node: { url: "https://x/c" } } } } : {}; }
      return { repository: { issueOrPullRequest: { __typename: "Issue", id: `I${v.n}`, state: "OPEN" } } };
    },
  });
  return { querier, now: () => new Date(T1) };
}

describe("Backlog", () => {
  test("every kind offers it last, and answering it needs no comment hash", async () => {
    const db = fresh();
    const group = askGroup(db);
    ask(db, ["scope", "duplicate", "close", "merge", "split", "other"].map((k, i) => question(`d-${k}`, k, "app", 4 + i % 3)));
    for (const id of ["d-scope", "d-duplicate", "d-close", "d-merge", "d-split", "d-other", group]) {
      const d = await getOne(db, req("operator", { id }));
      assert.equal(d.options.at(-1)!.key, "backlog", id);
      assert.equal(d.options.at(-1)!.label, "Backlog");
    }
    // The group's own answer needs the hash of its stored comments; Backlog stores none.
    await assert.rejects(answer(db, req("operator", { id: group }, { answer: "accept" })), /comments for this answer changed/);
    const done = await answer(db, req("operator", { id: group }, { answer: "backlog" }));
    assert.equal(done.answer, "backlog");
    assert.deepEqual(actionable(db), []);
    assert.ok(textsHash([]));
  });

  test("it writes nothing to GitHub and holds the item from Decide, Review, Act and Merge", async () => {
    const db = fresh();
    // Issue 1 answered close (writes), issue 2 backlogged (batch with 3), PR 4 backlogged, PR 5 a group member.
    ask(db, [question("s-close", "scope", "app", 1), question("s-batch", "scope", "app", null), question("s-pr", "scope", "app", 4)]);
    const group = askGroup(db, [5, 6]);
    db.prepare("UPDATE dupe_group_items SET kind = 'pr' WHERE decision_id = ?").run(group);
    ask(db, [question("m-7", "merge", "app", 7)]);
    const open = (kind: string) => (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = ? AND answer IS NULL").get(kind) as { n: number }).n;
    assert.ok(open("scope") === 3);
    for (const [id, a] of [["s-close", "close"], ["s-batch", "backlog"], ["s-pr", "backlog"], [group, "backlog"], ["m-7", "backlog"]] as const)
      await answer(db, req("operator", { id }, { answer: a }));
    // The close answer is applied by Act; the others write nothing.
    const log: string[] = [];
    await runAct(db, { repo: "app", dryRun: false }, quiet, recorder(log));
    const written = log.filter((l) => l.startsWith("comment") || l.startsWith("close"));
    assert.deepEqual(written, ["comment I1", "close I1"]);
    for (const id of ["s-batch", "s-pr", group, "m-7"]) assert.equal(getDecision(db, id)!.applied_at, null, id);

    const free = (db.prepare(`SELECT number FROM items i WHERE repo = 'app' AND ${notHeldSql("i")} ORDER BY number`).all() as { number: number }[]).map((r) => r.number);
    assert.deepEqual(free, [1, 8, 9]);
    // Issue 1 has an answered scope decision, issues 2 and 3 are backlogged: Decide asks about none of them.
    assert.deepEqual(decideCandidates(db, "r1", ["app"]).map((c) => c.number), []);
    const states = new Map(buildQueue(db, { repo: "app" }).map((e) => [e.number, e.state]));
    assert.equal(states.get(7), "held-duplicate");
    assert.notEqual(states.get(8), "held-duplicate");
    // Review takes up unreviewed PRs only: forget the reviews, then 4 (backlogged) and 5, 6 (group) and 7 (Merge?) stay out.
    db.exec("DELETE FROM reviews");
    assert.deepEqual(reviewCandidates(db, "app").map((c) => c.number), [8, 9]);
  });

  test("the Backlog view lists them and Reopen makes the decision open again", async () => {
    const db = fresh();
    ask(db, [question("s1", "scope", "app", 1), question("s2", "scope", "app", 2)]);
    await answer(db, req("operator", { id: "s1" }, { answer: "backlog" }));
    await answer(db, req("operator", { id: "s2" }, { answer: "yes" }));
    const ids = async (status: string) => (await listDecisions(db, req("viewer", {}, undefined, `status=${status}`), async () => [])).decisions.map((d) => d.id);
    assert.deepEqual(await ids("open"), []);
    assert.deepEqual(await ids("backlog"), ["s1"]);
    assert.deepEqual(await ids("answered"), ["s2"]);
    await assert.rejects(reopen(db, req("viewer", { id: "s1" })), /only the operator/);
    await assert.rejects(reopen(db, req("operator", { id: "s2" })), /not in the Backlog/);
    const d = await reopen(db, req("operator", { id: "s1" }));
    assert.equal(d.answer, null);
    assert.deepEqual(await ids("open"), ["s1"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'reopen' AND target = 's1'").get() as { n: number }).n, 1);
    const free = db.prepare(`SELECT 1 FROM items i WHERE repo = 'app' AND number = 1 AND ${notHeldSql("i")}`).get();
    assert.ok(free !== undefined, "an open scope decision does not hold; the item waits on its answer");
  });

  test("bulk Backlog outside the pilot: a dry run writes nothing, apply moves only non-pilot open decisions", async () => {
    const db = fresh();
    ask(db, [question("a1", "scope", "app", 1), question("a2", "scope", "app", 2), question("o1", "scope", "other", 1), question("o2", "merge", "other", 2), question("done", "scope", "other", 1)]);
    db.prepare("UPDATE decisions SET answer = 'yes', answered_by = 'op', answered_at = ? WHERE id = 'done'").run(T1);
    // No pilot set: nothing is outside it.
    assert.deepEqual(backlogOpen(db, { outsidePilot: true }, "cli", true).decisions, []);
    setPilot(db, "op", ["app"]);
    const dry = backlogOpen(db, { outsidePilot: true }, "cli", false);
    assert.deepEqual(dry.decisions.map((d) => d.id).sort(), ["o1", "o2"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE answer = 'backlog'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'answer'").get() as { n: number }).n, 0);

    const res = await backlogBulk(db, req("operator", {}, { outsidePilot: true, apply: true }));
    assert.deepEqual([res.applied, res.count], [true, 2]);
    const answers = Object.fromEntries((db.prepare("SELECT id, answer, answered_by FROM decisions").all() as { id: string; answer: string | null; answered_by: string | null }[]).map((r) => [r.id, [r.answer, r.answered_by]]));
    assert.deepEqual(answers, { a1: [null, null], a2: [null, null], o1: ["backlog", "op"], o2: ["backlog", "op"], done: ["yes", "op"] });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'answer' AND details LIKE '%backlog%'").get() as { n: number }).n, 2);
    await assert.rejects(backlogBulk(db, req("viewer", {}, { outsidePilot: true })), /only operators/);
    // --repo moves every open decision of the repo.
    const repo = backlogOpen(db, { repo: "app" }, "cli", true);
    assert.deepEqual(repo.decisions.map((d) => d.id).sort(), ["a1", "a2"]);
  });
});
