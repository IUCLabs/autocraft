import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { reconcileRepo, runSync } from "../src/mirror.ts";
import { trackRepo, untrackRepo } from "../src/repos.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const issue = (repo: string, number: number, state = "OPEN", updatedAt = "2026-11-02T10:00:00Z"): N => ({
  __typename: "Issue", repository: { name: repo }, number, title: `t${number}`, body: "", url: "u", author: { login: "a" },
  authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, state,
  labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null,
  comments: { nodes: [{ id: `c${number}`, author: { login: "a" }, createdAt: "2026-01-02T00:00:00Z", body: "hi" }] },
});

type Fake = {
  search?: N[]; // everything the search index returns, by updatedAt
  listing?: N[]; // per-repo listing source
  one?: Record<string, N | null>; // `repo#number` -> node for the single-item query
  failListing?: boolean;
};

// Answers search windows, per-repo listings and single-item reads from `f`.
function fake(f: Fake) {
  const c = validating({
    spent: 0, remaining: 4000 as number | null, kinds: [] as string[],
    async query(query: string, v: Record<string, unknown>): Promise<N> {
      if (query.includes("search(")) {
        c.kinds.push("search");
        const m = /updated:(\S+)\.\.(\S+)/.exec(String(v.q))!;
        const hits = (f.search ?? []).filter((n) => n.updatedAt >= m[1] && n.updatedAt <= m[2]);
        const start = Number(v.after ?? 0), end = Math.min(start + Number(v.first), 1000, hits.length);
        return { search: { issueCount: hits.length, pageInfo: { hasNextPage: end < Math.min(1000, hits.length), endCursor: String(end) }, nodes: hits.slice(start, end) } };
      }
      if (query.includes("issueOrPullRequest")) {
        c.kinds.push("one");
        return { repository: { issueOrPullRequest: f.one?.[`${v.name}#${v.number}`] ?? null } };
      }
      c.kinds.push("listing");
      if (f.failListing) throw new Error("listing failed");
      const isIssue = query.includes("issues(first");
      const states = v.states as string[];
      const nodes = isIssue ? (f.listing ?? []).filter((n) => n.repository.name === v.name && states.includes(n.state)) : [];
      return { repository: { [isIssue ? "issues" : "pullRequests"]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
    },
  });
  return c;
}

function scratch() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "syncgaps-")), "m.db"));
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos VALUES ('a','t','x')");
  db.exec("INSERT INTO repos (name, synced_at, high_water, reconciled_at) VALUES ('a','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('repos_refreshed_at','2999-01-01T00:00:00Z'),('search_catchup_at','2999-01-01T00:00:00Z')");
  return db;
}
const opts = { only: [], all: false, full: false, perRepo: false };
const setting = (db: ReturnType<typeof connect>, key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;
const stateOf = (db: ReturnType<typeof connect>, n: number) => (db.prepare("SELECT state FROM items WHERE repo='a' AND number=?").get(n) as { state: string } | undefined)?.state;

test("an item the index showed 8 minutes after its updatedAt is read by the next minute run", async () => {
  const db = scratch();
  // updatedAt 8 minutes before the high water: outside the old 2 minute overlap
  const c = fake({ search: [issue("a", 1, "OPEN", "2026-11-02T09:22:00Z")] });
  await runSync(db, c, opts, new Date("2026-11-02T10:00:00Z"));
  assert.equal(stateOf(db, 1), "OPEN");
  assert.deepEqual(c.kinds, ["search"], "one search page in the normal case");
});

test("a one-second window over the search cap is listed per repo and the high water stays put when that fails", async () => {
  const db = scratch();
  setting(db, "org_high_water");
  db.exec("UPDATE settings SET value='2026-11-02T10:00:00Z' WHERE key='org_high_water'");
  const crowd = Array.from({ length: 1100 }, (_, i) => issue("zzz", i + 1, "OPEN", "2026-11-02T10:00:00Z"));
  const mine = issue("a", 5, "OPEN", "2026-11-02T10:00:00Z");
  const failing = fake({ search: [...crowd, mine], listing: [mine], failListing: true });
  await assert.rejects(runSync(db, failing, opts, new Date("2026-11-02T10:00:30Z")), /listing failed/);
  assert.equal(setting(db, "org_high_water"), "2026-11-02T10:00:00Z");
  assert.equal(db.prepare("SELECT high_water FROM repos WHERE name='a'").get()!.high_water, "2026-11-02T09:00:00Z");

  const ok = fake({ search: [...crowd, mine, issue("a", 6, "OPEN", "2026-11-02T10:00:10Z")], listing: [mine] });
  const r = await runSync(db, ok, opts, new Date("2026-11-02T10:00:30Z"));
  assert.equal(r.mode, "search");
  assert.equal(stateOf(db, 5), "OPEN", "read through the per-repo listing");
  assert.equal(stateOf(db, 6), "OPEN", "the later, untruncated window is read by search");
  assert.ok(ok.kinds.includes("listing"));
  assert.equal(db.prepare("SELECT high_water FROM repos WHERE name='a'").get()!.high_water, "2026-11-02T10:00:10Z");
});

test("tracking a repo again resets its high water so the next sync reads it in full", () => {
  const db = scratch();
  assert.equal(untrackRepo(db, "t", "a"), true);
  db.exec("UPDATE repos SET high_water='2026-11-02T09:00:00Z', synced_at='2026-11-02T09:00:00Z' WHERE name='a'");
  assert.equal(trackRepo(db, "t", "a"), true);
  const r = db.prepare("SELECT high_water, synced_at, reconciled_at FROM repos WHERE name='a'").get()!;
  assert.deepEqual({ ...r }, { high_water: null, synced_at: null, reconciled_at: null });
});

test("the daily reconcile closes a vanished open item and re-reads one that was closed", async () => {
  const db = scratch();
  const c0 = fake({ search: [issue("a", 1), issue("a", 2), issue("a", 3)] });
  await runSync(db, c0, opts, new Date("2026-11-02T10:05:00Z"));
  assert.deepEqual([1, 2, 3].map((n) => stateOf(db, n)), ["OPEN", "OPEN", "OPEN"]);
  // GitHub now lists only #1 as open; #2 closed, #3 deleted
  const c = fake({ listing: [issue("a", 1)], one: { "a#2": issue("a", 2, "CLOSED", "2026-11-02T11:00:00Z") } });
  const r = await reconcileRepo(db, c, "a", new Date("2026-11-03T10:00:00Z"));
  assert.deepEqual(r, { open: 1, updated: 1, gone: 1 });
  assert.deepEqual([1, 2, 3].map((n) => stateOf(db, n)), ["OPEN", "CLOSED", "CLOSED"]);
  assert.equal(db.prepare("SELECT updated_at FROM items WHERE number=2").get()!.updated_at, "2026-11-02T11:00:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='item-gone' AND target='a#3'").get()!.n, 1);
  assert.equal(db.prepare("SELECT reconciled_at FROM repos WHERE name='a'").get()!.reconciled_at, "2026-11-03T10:00:00Z");
});

test("a sync run reconciles only the repo reconciled longest ago, and only when it is over a day old", async () => {
  const db = scratch();
  db.exec("INSERT INTO tracked_repos VALUES ('b','t','x')");
  db.exec("INSERT INTO repos (name, synced_at, high_water, reconciled_at) VALUES ('b','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z','2026-11-01T08:00:00Z')");
  const c = fake({});
  await runSync(db, c, opts, new Date("2026-11-02T10:00:00Z"));
  assert.equal(c.kinds.filter((k) => k === "listing").length, 2, "issues and PRs of one repo");
  assert.equal(db.prepare("SELECT reconciled_at FROM repos WHERE name='b'").get()!.reconciled_at, "2026-11-02T10:00:00Z");
  assert.equal(db.prepare("SELECT reconciled_at FROM repos WHERE name='a'").get()!.reconciled_at, "2026-11-02T09:00:00Z");
  const again = fake({});
  await runSync(db, again, opts, new Date("2026-11-02T10:01:00Z"));
  assert.ok(!again.kinds.includes("listing"), "nothing is due");
});

test("an item re-read with the same updatedAt writes nothing", async () => {
  const db = scratch();
  const n = issue("a", 1);
  await runSync(db, fake({ search: [n] }), opts, new Date("2026-11-02T10:05:00Z"));
  db.exec(`CREATE TEMP TABLE writes (t TEXT);
    CREATE TEMP TRIGGER w1 AFTER UPDATE ON items BEGIN INSERT INTO writes VALUES ('update'); END;
    CREATE TEMP TRIGGER w2 AFTER INSERT ON comments BEGIN INSERT INTO writes VALUES ('comment'); END;`);
  await runSync(db, fake({ search: [n] }), opts, new Date("2026-11-02T10:06:00Z"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes").get()!.n, 0);
  await runSync(db, fake({ search: [{ ...n, title: "new", updatedAt: "2026-11-02T10:06:00Z" }] }), opts, new Date("2026-11-02T10:07:00Z"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes").get()!.n, 2, "a changed item is still written");
});
