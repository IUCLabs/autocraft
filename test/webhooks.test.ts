import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { drainSyncRequests, handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";

const SECRET = "hook-secret";
function scratch() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "hook-")), "m.db"));
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos VALUES ('a','t','x', 1)");
  return db;
}
const deliver = (db: ReturnType<typeof scratch>, event: string, payload: unknown, sign = true) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return handleDelivery(db, SECRET, { event, ...(sign ? { signature: signatureOf(SECRET, raw) } : {}) }, raw, safeEqual);
};
const queued = (db: ReturnType<typeof scratch>) => db.prepare("SELECT repo, number FROM sync_requests ORDER BY number").all().map((r) => ({ ...r }));

test("a signed delivery queues one row per item, a bad or missing signature and an untracked repo queue nothing", () => {
  const db = scratch();
  const body = (n: number, full = "storytold/a") => ({ repository: { full_name: full, name: full.split("/")[1] }, issue: { number: n } });
  assert.equal(deliver(db, "issues", body(7)).status, 202);
  assert.equal(deliver(db, "issue_comment", body(7)).status, 202);
  assert.equal(deliver(db, "issues", body(8)).status, 202);
  assert.deepEqual(queued(db), [{ repo: "a", number: 7 }, { repo: "a", number: 8 }], "a burst collapses to one row per item");
  assert.equal(deliver(db, "issues", body(9), false).status, 401);
  const raw = Buffer.from(JSON.stringify(body(9)));
  assert.equal(handleDelivery(db, SECRET, { event: "issues", signature: signatureOf("other", raw) }, raw, safeEqual).status, 401);
  assert.equal(handleDelivery(db, null, { event: "issues", signature: signatureOf("", raw) }, raw, safeEqual).status, 401, "no secret set: refused");
  assert.equal(deliver(db, "issues", body(10, "storytold/zzz")).status, 202);
  assert.equal(deliver(db, "issues", body(11, "someoneelse/a")).status, 202);
  assert.equal(deliver(db, "ping", {}).status, 200);
  const pr = { repository: { full_name: "storytold/a", name: "a" }, check_suite: { pull_requests: [{ number: 12, base: { repo: { name: "a" } } }, { number: 99, base: { repo: { name: "fork" } } }] } };
  assert.equal(deliver(db, "check_suite", pr).status, 202);
  assert.deepEqual(queued(db), [{ repo: "a", number: 7 }, { repo: "a", number: 8 }, { repo: "a", number: 12 }]);
});

test("the drain re-reads a queued item, sets synced_at and clears the request", async () => {
  const db = scratch();
  deliver(db, "issues", { repository: { full_name: "storytold/a", name: "a" }, issue: { number: 5 } });
  const node = {
    __typename: "Issue", repository: { name: "a", owner: { login: "storytold" } }, number: 5, title: "t", body: "", url: "u", author: { login: "x" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null, comments: { nodes: [] },
  };
  const calls: Record<string, unknown>[] = [];
  const c = validating({ spent: 0, remaining: 4000 as number | null, async query(_q: string, v: Record<string, unknown>) { calls.push(v); return { repository: { issueOrPullRequest: node } }; } });
  assert.equal(await drainSyncRequests(db, c), 1);
  assert.deepEqual(calls, [{ owner: "storytold", name: "a", number: 5 }]);
  const row = db.prepare("SELECT title, synced_at FROM items WHERE repo = 'a' AND number = 5").get() as { title: string; synced_at: string };
  assert.equal(row.title, "t");
  assert.match(row.synced_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(queued(db), []);
});
