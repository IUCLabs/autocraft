// Settled type labels, the full-text index and the Items browser.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { ItemList } from "../web/src/api/types.ts";
import { settle, settledOf } from "../src/classify/settled.ts";
import { connect } from "../src/db.ts";
import { listItems, quickSearch } from "../src/dash/api/items.ts";
import { funnelByRepo } from "../src/dash/api/stats.ts";
import { runSync } from "../src/mirror.ts";
import { scopeToTracked } from "../src/repos.ts";
import type { Req } from "../src/dash/types.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const freshPath = () => join(mkdtempSync(join(SCRATCH, "items-test-")), "m.db");
const fresh = () => connect(freshPath());
const req = (qs: string) => ({ query: new URLSearchParams(qs), user: { login: "op", role: "operator" } }) as unknown as Req;
const refs = (l: ItemList) => l.rows.map((r) => `${r.repo}#${r.number}`).sort();

describe("settled type label", () => {
  const jev = (label: string, top: number, flags: string[] = []) => ({ label, top, flags });
  test("Jev sure: Jev's label and flags", async () => {
    const s = settle(jev("bugfix", 0.95, ["security"]), { label: "infra", flags: ["needs decision"] });
    assert.deepEqual([s.status, s.label, s.source, s.flags], ["settled", "bugfix", "jev", ["security"]]);
  });
  test("Jev unsure and Haiku agrees: settled by Haiku, flags of both", async () => {
    const s = settle(jev("small extra", 0.6, ["security"]), { label: "small extra", flags: ["needs decision"] });
    assert.deepEqual([s.status, s.label, s.source, s.flags], ["settled", "small extra", "haiku", ["security", "needs decision"]]);
  });
  test("Jev unsure and Haiku pending: waiting", async () => {
    const s = settle(jev("small extra", 0.89), null);
    assert.deepEqual([s.status, s.label], ["waiting", null]);
  });
  test("Jev unsure and Haiku disagrees: disagree", async () => {
    const s = settle(jev("small extra", 0.5), { label: "plugin candidate", flags: [] });
    assert.deepEqual([s.status, s.label, s.jevLabel, s.haikuLabel], ["disagree", null, "small extra", "plugin candidate"]);
  });
  test("no Jev verdict: unclassified", async () => {
    assert.equal(settle(null, { label: "bugfix", flags: [] }).status, "unclassified");
  });
});

function seed(db: DatabaseSync): void {
  const now = "2026-11-02T10:00:00Z";
  const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("photocraft", 1, "pr", "OPEN", "Add wave filter", "Distorts the layer", "alice", now, "2026-11-02T09:00:00Z");
  ins.run("photocraft", 2, "issue", "OPEN", "Crash on save", "Saving a big file crashes", "bob", now, "2026-11-01T09:00:00Z");
  ins.run("photocraft", 3, "pr", "CLOSED", "Faster export", "speed", "carol", now, "2026-10-01T09:00:00Z");
  ins.run("filmcraft", 4, "pr", "OPEN", "Timeline wave view", "audio", "Alice", now, "2026-11-02T08:00:00Z");
  ins.run("untracked-repo", 5, "pr", "OPEN", "Add wave filter elsewhere", "x", "dave", now, now);
  const com = db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES (?,?,?,?,?,?,?)");
  com.run("photocraft", 2, "c1", "comment", "erin", now, "The quokka plugin causes it");
  com.run("photocraft", 1, "c2", "comment", "erin", now, "looks good");
  const cls = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?,?,?,?,?,?,?,?)");
  const p = (top: number) => JSON.stringify({ top });
  cls.run("photocraft", 1, "jev", "r1", now, "small extra", '["needs decision"]', p(0.97));
  cls.run("photocraft", 2, "jev", "r1", now, "bugfix", "[]", p(0.6));
  cls.run("photocraft", 2, "haiku", "r1", now, "bugfix", '["security"]', null);
  cls.run("photocraft", 3, "jev", "r1", now, "performance", "[]", p(0.5));
  cls.run("filmcraft", 4, "jev", "r1", now, "small extra", "[]", p(0.7));
  cls.run("filmcraft", 4, "haiku", "r1", now, "plugin candidate", "[]", null);
  db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name) VALUES ('photocraft'), ('filmcraft')");
}

describe("Items browser", () => {
  const db = fresh();
  seed(db);
  scopeToTracked(db);

  test("full text finds a word in a title and in a comment body, in tracked repos only", async () => {
    assert.deepEqual(refs((await listItems(db, req("q=wave")))), ["filmcraft#4", "photocraft#1"]);
    const c = (await listItems(db, req("q=quokka")));
    assert.deepEqual(refs(c), ["photocraft#2"]);
    assert.equal(c.rows[0]!.snippet?.field, "comment");
    assert.match(c.rows[0]!.snippet!.text, /\u0002quokka\u0003/);
    assert.deepEqual(refs((await listItems(db, req("q=%22wave+filter%22")))), ["photocraft#1"]);
    assert.deepEqual(refs((await listItems(db, req("q=quok*")))), ["photocraft#2"]);
    assert.deepEqual(refs((await listItems(db, req("q=wave+-timeline")))), ["photocraft#1"]);
    assert.deepEqual(refs((await listItems(db, req("q=%22unbalanced+NOT+(")))), []);
  });

  test("filters combine and counts per status ignore the status filter", async () => {
    const all = (await listItems(db, req("state=all")));
    assert.equal(all.total, 4);
    assert.deepEqual(all.byStatus, { settled: 2, waiting: 1, disagree: 1, unclassified: 0 });
    assert.deepEqual(refs((await listItems(db, req("")))), ["filmcraft#4", "photocraft#1", "photocraft#2"]);
    assert.deepEqual(refs((await listItems(db, req("status=unsettled&state=all")))), ["filmcraft#4", "photocraft#3"]);
    assert.deepEqual(refs((await listItems(db, req("label=bugfix")))), ["photocraft#2"]);
    assert.deepEqual(refs((await listItems(db, req("flag=security")))), ["photocraft#2"]);
    assert.deepEqual(refs((await listItems(db, req("q=wave&repo=photocraft&kind=pr&status=settled")))), ["photocraft#1"]);
    assert.deepEqual(refs((await listItems(db, req("author=alice")))), ["filmcraft#4", "photocraft#1"]);
    assert.deepEqual(refs((await listItems(db, req("since=2026-11-02")))), ["filmcraft#4", "photocraft#1"]);
    const sorted = (await listItems(db, req("sort=number&desc=0")));
    assert.deepEqual(sorted.rows.map((r) => r.number), [1, 2, 4]);
    assert.equal(sorted.rows[1]!.settled.source, "haiku");
    await assert.rejects(async () => listItems(db, req("mode=semantic")), /mode/);
  });

  test("Progress counts settled, waiting and disagreeing open items", async () => {
    const f = funnelByRepo(db);
    const p = f.find((r) => r.repo === "photocraft")!, fc = f.find((r) => r.repo === "filmcraft")!;
    assert.deepEqual([p.classified, p.second_opinion, p.disagreement], [2, 0, 0]);
    assert.deepEqual([fc.classified, fc.second_opinion, fc.disagreement], [0, 0, 1]);
    assert.equal(settledOf(db, "photocraft", 3).status, "waiting");
  });

  test("a new verdict shows without a rebuild", async () => {
    db.prepare("INSERT INTO main.classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('photocraft', 3, 'haiku', 'r1', ?, 'performance', '[]')")
      .run("2026-11-02T10:00:01Z");
    assert.deepEqual(refs((await listItems(db, req("label=performance&state=all")))), ["photocraft#3"]);
  });

  test("top-bar search: numbers, logins and words", async () => {
    assert.deepEqual((await quickSearch(db, req("q=photocraft%232"))).map((h) => h.number), [2]);
    assert.deepEqual((await quickSearch(db, req("q=carol"))).map((h) => h.number), [3]);
    assert.deepEqual((await quickSearch(db, req("q=crash"))).map((h) => h.number), [2]);
    assert.deepEqual((await quickSearch(db, req("q=timel"))).map((h) => h.number), [4]);
  });
});

test("the index follows sync writes", async () => {
  const path = freshPath();
  const db = connect(path);
  // the sync writes on its own connection, as in production; the dashboard's is scoped
  const dash = connect(path);
  db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos VALUES ('a','t','x')");
  db.exec("INSERT INTO repos (name, synced_at, high_water) VALUES ('a','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('repos_refreshed_at','2999-01-01T00:00:00Z')");
  const node = (title: string, comment: string, updatedAt: string) => ({
    __typename: "Issue", repository: { name: "a" }, number: 1, title, body: "", url: "u", author: { login: "a" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 1 }, stateReason: null,
    comments: { nodes: [{ id: "c1", author: { login: "b" }, createdAt: updatedAt, body: comment }] },
  });
  const client = (n: unknown) => ({
    spent: 0, remaining: 4000,
    async query() { return { search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [n] } }; },
  });
  const opts = { only: [], all: false, full: false, perRepo: false };
  await runSync(db, client(node("alpha title", "zebra comment", "2026-11-02T10:00:00Z")), opts, new Date("2026-11-02T10:05:00Z"));
  scopeToTracked(dash);
  assert.equal((await listItems(dash, req("q=alpha"))).total, 1);
  assert.equal((await listItems(dash, req("q=zebra"))).total, 1);
  await runSync(db, client(node("gamma title", "yak comment", "2026-11-02T10:06:00Z")), opts, new Date("2026-11-02T10:10:00Z"));
  assert.equal((await listItems(dash, req("q=alpha"))).total, 0);
  assert.equal((await listItems(dash, req("q=zebra"))).total, 0);
  assert.equal((await listItems(dash, req("q=gamma"))).total, 1);
  assert.equal((await listItems(dash, req("q=yak"))).total, 1);
  db.exec("INSERT INTO items_fts (items_fts) VALUES ('integrity-check')");
  db.exec("INSERT INTO comments_fts (comments_fts) VALUES ('integrity-check')");
});
