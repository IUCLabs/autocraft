import assert from "node:assert/strict";
import { test } from "node:test";
import { untilCutoff } from "../src/mirror.ts";

const page = (...times: string[]) => times.map((updatedAt) => ({ updatedAt }));

test("incremental sync stops at the first old item and requests no further page", async () => {
  let fetched = 0;
  async function* pages() {
    for (const p of [page("2026-02", "2026-01"), page("2025-12"), page("2025-11")]) {
      fetched++;
      yield p;
    }
  }
  const out: string[][] = [];
  for await (const p of untilCutoff(pages(), "2026-01")) out.push(p.map((n) => n.updatedAt));
  assert.deepEqual(out, [["2026-02", "2026-01"]]);
  assert.equal(fetched, 2);
});

test("no cutoff keeps every page", async () => {
  async function* pages() {
    yield page("a");
    yield page("b");
  }
  let n = 0;
  for await (const _ of untilCutoff(pages(), null)) n++;
  assert.equal(n, 2);
});

// ---- search-based incremental sync ----
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, runSync, searchSince } from "../src/mirror.ts";
import { connect } from "../src/db.ts";

const node = (repo: string, number: number, state = "OPEN", updatedAt = "2026-11-02T10:00:00Z") => ({
  __typename: "Issue", repository: { name: repo }, number, title: `t${number}`, body: "", url: "u", author: { login: "a" },
  authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, state,
  labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null,
  comments: { nodes: [] },
});

function fakeClient(nodes: unknown[], issueCount = nodes.length, failAfter = Infinity) {
  const c = {
    spent: 0, remaining: 4000 as number | null, calls: [] as { query: string; variables: Record<string, unknown> }[],
    async query(query: string, variables: Record<string, unknown>) {
      c.calls.push({ query, variables });
      if (c.calls.length > failAfter) throw new Error("boom");
      return { search: { issueCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
    },
  };
  return c;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fastsync-"));
  const db = connect(join(dir, "m.db"));
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos VALUES ('a','t','x'),('b','t','x')");
  db.exec("INSERT INTO repos (name, high_water) VALUES ('a','2026-11-02T09:00:00Z'),('b','2026-11-02T09:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('repos_refreshed_at','2999-01-01T00:00:00Z')");
  return { dir, db };
}
const opts = { only: [], all: false, full: false, perRepo: false };
const hw = (db: ReturnType<typeof connect>) => (db.prepare("SELECT value FROM settings WHERE key='org_high_water'").get() as { value: string }).value;

test("search starts two minutes before the stored high water", () => {
  assert.equal(searchSince("2026-11-02T09:30:00Z"), "2026-11-02T09:28:00Z");
});

test("search mode writes tracked results, ignores untracked, advances the high water", async () => {
  const { db } = scratch();
  const c = fakeClient([node("a", 1), node("zzz", 2), node("b", 3, "CLOSED")]);
  const r = await runSync(db, c, opts, new Date("2026-11-02T10:05:00Z"));
  assert.deepEqual(r, { mode: "search", items: 2 });
  assert.equal(c.calls.length, 1);
  assert.match(String(c.calls[0].variables.q), /updated:>=2026-11-02T09:28:00Z/);
  const rows = db.prepare("SELECT repo, number, detail_level FROM items ORDER BY number").all();
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ repo: "a", number: 1, detail_level: "full" }, { repo: "b", number: 3, detail_level: "light" }]);
  assert.equal(hw(db), "2026-11-02T10:05:00Z");
});

test("more than 1,000 matches falls back to per-repo passes and writes nothing from the search", async () => {
  const { db } = scratch();
  const c = {
    spent: 0, remaining: 1 as number | null, queries: [] as string[],
    async query(query: string) {
      c.queries.push(query);
      if (query.includes("search(")) return { search: { issueCount: 1001, pageInfo: {}, nodes: [node("a", 1)] } };
      if (query.includes("repositories(")) {
        const repo = (name: string) => ({ name, visibility: "PUBLIC", defaultBranchRef: null, pullRequests: { totalCount: 0 }, issues: { totalCount: 0 } });
        return { organization: { repositories: { pageInfo: { hasNextPage: false }, nodes: [repo("a"), repo("b")] } } };
      }
      return { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    },
  };
  const r = await runSync(db, c, opts, new Date("2026-11-02T10:05:00Z"));
  assert.equal(r.mode, "per-repo");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()!.n, 0);
  assert.ok(c.queries.some((q) => q.includes("repository(owner")));
});

test("an unset org high water or a never-synced tracked repo skips the search", async () => {
  const { db } = scratch();
  db.exec("UPDATE repos SET high_water=NULL WHERE name='b'");
  const c = fakeClient([]);
  const empty = { ...c, async query(q: string, v: Record<string, unknown>) { c.calls.push({ query: q, variables: v }); throw new Error("stop"); } };
  await assert.rejects(runSync(db, empty, opts), /stop/);
  assert.ok(!c.calls[0].query.includes("search("));
  db.exec("UPDATE repos SET high_water='x' WHERE name='b'; DELETE FROM settings WHERE key='org_high_water'");
  c.calls.length = 0;
  await assert.rejects(runSync(db, empty, opts), /stop/);
  assert.ok(!c.calls[0].query.includes("search("));
});

test("a failed run leaves the high water unchanged", async () => {
  const { db } = scratch();
  const c = fakeClient([node("a", 1)], 1, 0);
  await assert.rejects(runSync(db, c, opts, new Date("2026-11-02T10:05:00Z")), /boom/);
  assert.equal(hw(db), "2026-11-02T09:30:00Z");
});

test("the repo list refreshes only when older than 15 minutes", async () => {
  const { db } = scratch();
  db.exec("UPDATE settings SET value='2026-11-02T09:00:00Z' WHERE key='repos_refreshed_at'");
  const c = fakeClient([]);
  const withList = { ...c, query: async (q: string, v: Record<string, unknown>) =>
    q.includes("repositories(") ? { organization: { repositories: { pageInfo: { hasNextPage: false }, nodes: [] } } } : c.query(q, v) };
  await runSync(db, withList, opts, new Date("2026-11-02T10:00:00Z"));
  const at = (db.prepare("SELECT value FROM settings WHERE key='repos_refreshed_at'").get() as { value: string }).value;
  assert.ok(at > "2026-11-02T09:00:00Z");
});

test("a second lock holder is refused, and a stale lock is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "x.lock");
  const release = acquireLock(path);
  assert.ok(release);
  assert.equal(acquireLock(path), null);
  release();
  const again = acquireLock(path);
  assert.ok(again);
  again();
  writeFileSync(path, "2147483646");
  const taken = acquireLock(path);
  assert.ok(taken);
  taken();
});
