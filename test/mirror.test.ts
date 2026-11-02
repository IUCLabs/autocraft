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
import { acquireLock, lowPriority, runSync, searchSince, type Client } from "../src/mirror.ts";
import { connect } from "../src/db.ts";
import { itemText, textHash } from "../src/embed/text.ts";
import { inputHash } from "../src/runner/classify.ts";

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
  db.exec("INSERT INTO repos (name, synced_at, high_water) VALUES ('a','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z'),('b','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('repos_refreshed_at','2999-01-01T00:00:00Z'),('search_catchup_at','2999-01-01T00:00:00Z')");
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
  assert.match(String(c.calls[0].variables.q), /updated:2026-11-02T09:28:00Z\.\.2026-11-02T10:05:00Z/);
  const rows = db.prepare("SELECT repo, number, detail_level FROM items ORDER BY number").all();
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ repo: "a", number: 1, detail_level: "full" }, { repo: "b", number: 3, detail_level: "light" }]);
  assert.equal(hw(db), "2026-11-02T10:00:00Z", "the high water is the newest updatedAt, not the start time");
});

// A fake search over `all`: honours `updated:A..B`, pages by cursor, and reports the true match count.
function searchClient(all: ReturnType<typeof node>[]) {
  const c = {
    spent: 0, remaining: 4000 as number | null, queries: [] as string[], windows: [] as { from: string; to: string; matches: number }[],
    async query(query: string, v: Record<string, unknown>) {
      c.queries.push(query);
      assert.ok(query.includes("search("), "only search queries are expected");
      const m = /updated:(\S+)\.\.(\S+)/.exec(String(v.q))!;
      const hits = all.filter((n) => n.updatedAt >= m[1] && n.updatedAt <= m[2]);
      const start = Number(v.after ?? 0), size = Number(v.first);
      if (!v.after) c.windows.push({ from: m[1], to: m[2], matches: hits.length });
      const end = Math.min(start + size, 1000, hits.length);
      return { search: { issueCount: hits.length, pageInfo: { hasNextPage: end < Math.min(1000, hits.length), endCursor: String(end) }, nodes: hits.slice(start, end) } };
    },
  };
  return c;
}
const at = (sec: number) => new Date(Date.UTC(2026, 10, 2, 10, 0, 0) + sec * 1000).toISOString().replace(".000Z", "Z");

test("a window with more than 1,000 matches is split into slices; nothing falls back to per-repo passes", async () => {
  const { db } = scratch();
  const all = Array.from({ length: 2500 }, (_, i) => node(i % 2 ? "a" : "b", i + 1, "OPEN", at(i % 1200)));
  const c = searchClient(all);
  const r = await runSync(db, c, opts, new Date("2026-11-02T10:30:00Z"));
  assert.equal(r.mode, "search");
  assert.equal(r.items, 2500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()!.n, 2500);
  assert.ok(c.queries.every((q) => q.includes("search(")), "no per-repo query");
  const leaves = c.windows.filter((w) => w.matches <= 1000);
  assert.ok(leaves.length >= 3, "split until each slice fits");
  assert.ok(c.windows.length > leaves.length, "over-cap windows were probed and cut");
  assert.equal(hw(db), at(1199));
});

test("an item the search index showed late is picked up by the hourly catch-up", async () => {
  const { db } = scratch();
  db.exec("DELETE FROM settings WHERE key='search_catchup_at'");
  const late = node("a", 7, "OPEN", "2026-11-02T09:10:00Z"); // older than the high water minus the 2 minute overlap
  const seen = [node("b", 8, "OPEN", "2026-11-02T09:31:00Z")];
  const all = [...seen, late];
  // the index lagged: the minute window (from 09:28) misses the late item, the catch-up window reaches it
  const c = searchClient(all);
  await runSync(db, c, opts, new Date("2026-11-02T10:05:00Z"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE repo='a' AND number=7").get()!.n, 1);
  assert.ok(c.windows.some((w) => w.from === "2026-11-02T09:01:00Z" && w.to === "2026-11-02T09:31:00Z"), "catch-up window is [high water - 30 min, high water]");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='search_catchup_at'").get()!.value, "2026-11-02T10:05:00Z");
  const again = searchClient(all);
  await runSync(db, again, opts, new Date("2026-11-02T10:06:00Z"));
  assert.equal(again.windows.length, 1, "no second catch-up within the hour");
});

test("the high water stays put when the search finds nothing", async () => {
  const { db } = scratch();
  await runSync(db, searchClient([]), opts, new Date("2026-11-02T10:30:00Z"));
  assert.equal(hw(db), "2026-11-02T09:30:00Z");
});

test("a run stores the points it used and the budget left", async () => {
  const { db } = scratch();
  const c = fakeClient([node("a", 1)]);
  const spend = c.query;
  c.query = async (q, v) => { c.spent += 3; c.remaining = 3990; return spend(q, v); };
  await runSync(db, c, opts, new Date("2026-11-02T10:05:00Z"));
  const get = (k: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value: string }).value;
  assert.equal(get("sync_points_last_run"), "3");
  assert.equal(get("sync_rate_remaining"), "3990");
});

test("sync stores the text hashes the planner compares", async () => {
  const { db } = scratch();
  const n = { ...node("a", 1), title: "Crash on open", body: "<!-- t -->See [docs](http://x.y) now\n```\ncode\n```" };
  await runSync(db, fakeClient([n]), opts, new Date("2026-11-02T10:05:00Z"));
  const row = db.prepare("SELECT * FROM items WHERE number=1").get() as Record<string, string>;
  assert.equal(row.embed_hash, textHash(itemText(n.title, n.body)));
  assert.equal(row.class_hash, inputHash({ repo: "a", number: 1, kind: "issue", title: n.title, body: n.body, lines_changed: null, files_changed: null, author_association: "NONE" }));
  const { pending } = await import("../src/embed/store.ts");
  assert.equal(pending(db, "m").length, 1);
  db.exec(`INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES ('a', 1, 'm', '${row.embed_hash}', x'00', 'x')`);
  assert.equal(pending(db, "m").length, 0);
  assert.equal(pending(db, "other").length, 1);
  db.prepare("UPDATE items SET embed_hash = NULL WHERE number = 1").run(); // legacy row: hash is filled from the text
  assert.equal(pending(db, "m").length, 0);
  assert.equal(db.prepare("SELECT embed_hash FROM items WHERE number = 1").get()!.embed_hash, row.embed_hash);
  db.prepare("UPDATE items SET body = 'new text' WHERE number = 1").run(); // an edit outside sync clears the hashes
  assert.equal(pending(db, "m").length, 1);
});

test("a full re-sync resumes after the last finished repo and leaves the org high water alone", async () => {
  const { db } = scratch();
  const seen: string[] = [];
  let fail = true;
  const repo = (name: string) => ({ name, visibility: "PUBLIC", defaultBranchRef: null, pullRequests: { totalCount: 0 }, issues: { totalCount: 0 } });
  const c = {
    spent: 0, remaining: 4000 as number | null,
    async query(query: string, v: Record<string, unknown>) {
      if (query.includes("repositories(")) return { organization: { repositories: { pageInfo: { hasNextPage: false }, nodes: ["a", "b"].map(repo) } } };
      seen.push(String(v.name));
      if (v.name === "b" && fail) throw new Error("boom");
      return { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    },
  };
  const full = { ...opts, full: true };
  await assert.rejects(runSync(db, c, full, new Date("2026-11-02T11:00:00Z")), /boom/);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='full_sync_cursor'").get()!.value, "tracked|a");
  fail = false;
  seen.length = 0;
  await runSync(db, c, full, new Date("2026-11-02T11:00:00Z"));
  assert.ok(!seen.includes("a"), "repo a was not fetched again");
  assert.ok(seen.includes("b"));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='full_sync_cursor'").get(), undefined);
  assert.equal(hw(db), "2026-11-02T09:30:00Z");
});

test("a low-priority client waits for the minute sync and pauses when the budget is low", async () => {
  const log: string[] = [];
  let busy = 2;
  const inner = { spent: 0, remaining: 4000 as number | null, async query() { log.push("query"); inner.remaining = 100; return {}; } } as unknown as Client;
  const q = lowPriority(inner, {
    busy: () => busy-- > 0, minRemaining: 500, wait: async () => { log.push("wait"); },
    pause: async () => { log.push("pause"); inner.remaining = 5000; },
  });
  await q.query("x", {});
  assert.deepEqual(log, ["wait", "wait", "query"]);
  await q.query("x", {});
  assert.deepEqual(log.slice(3), ["pause", "query"]);
});

test("an unset org high water or a never-synced tracked repo skips the search", async () => {
  const { db } = scratch();
  db.exec("UPDATE repos SET synced_at=NULL, high_water=NULL WHERE name='b'");
  const c = fakeClient([]);
  const empty = { ...c, async query(q: string, v: Record<string, unknown>) { c.calls.push({ query: q, variables: v }); throw new Error("stop"); } };
  await assert.rejects(runSync(db, empty, opts), /stop/);
  assert.ok(!c.calls[0].query.includes("search("));
  db.exec("UPDATE repos SET synced_at='x' WHERE name='b'; DELETE FROM settings WHERE key='org_high_water'");
  c.calls.length = 0;
  await assert.rejects(runSync(db, empty, opts), /stop/);
  assert.ok(!c.calls[0].query.includes("search("));
});

test("a synced tracked repo with no items still allows the search", async () => {
  const { db } = scratch();
  db.exec("UPDATE repos SET high_water=NULL WHERE name='b'");
  const r = await runSync(db, fakeClient([]), opts, new Date("2026-11-02T10:05:00Z"));
  assert.equal(r.mode, "search");
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
