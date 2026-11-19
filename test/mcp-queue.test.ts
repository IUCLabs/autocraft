// The Inbox MCP server's merge queue tools: an operator's agent queues, weights and withdraws PRs with the Queue page's
// own handlers (pre-approval, fast track); other roles only read the queue.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { Role } from "../src/dash/types.ts";
import { fastTrackList } from "../src/fasttrack.ts";
import { preapprovalOf } from "../src/preapproval/index.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = (): World => (current = world().repo());
afterEach(() => current?.close());

const envOf = (w: World, role: Role, login = role === "operator" ? OPERATOR : "maint"): McpEnv => ({
  db: w.db, baseUrl: null, limiter: new RateLimiter(60, 3600_000), canAnswer: false, expensive: () => 0,
  user: () => ({ login, role, canWrite: async () => true, canRead: async () => true }),
});

let id = 0;
async function rpc(env: McpEnv, method: string, params?: Record<string, unknown>): Promise<any> {
  return (await handleMcp(env, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }))!.result;
}
async function call(env: McpEnv, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(env, "tools/call", { name, arguments: args });
  return { text: r.content[0].text as string, isError: r.isError === true };
}
const names = async (env: McpEnv): Promise<string[]> => (await rpc(env, "tools/list")).tools.map((t: { name: string }) => t.name);
const weights = (w: World) => fastTrackList(w.db).map((f) => [f.number, f.weight]);
const data = (text: string): any => JSON.parse(text.slice(text.indexOf(">>>\n") + 4, text.lastIndexOf("\n<<<end untrusted>>>")));

describe("merge queue tools", () => {
  test("only an operator is offered the write tools and told about them; everyone reads the queue", async () => {
    const w = fresh();
    const op = envOf(w, "operator"), maint = envOf(w, "maintainer"), viewer = envOf(w, "viewer");
    for (const n of ["queue_pr", "set_weight", "cancel_queued", "list_merge_queue"]) assert.ok((await names(op)).includes(n), n);
    for (const env of [maint, viewer]) {
      const list = await names(env);
      assert.ok(list.includes("list_merge_queue"));
      assert.deepEqual(list.filter((n) => ["queue_pr", "set_weight", "cancel_queued"].includes(n)), []);
    }
    assert.match((await rpc(op, "initialize", { protocolVersion: "2025-06-18" })).instructions, /queue_pr/);
    assert.doesNotMatch((await rpc(maint, "initialize", { protocolVersion: "2025-06-18" })).instructions, /queue_pr/);
  });

  test("a maintainer's call is refused and changes nothing, also when the role changed after tools/list", async () => {
    const w = fresh().pr(1);
    const maint = envOf(w, "maintainer");
    for (const [name, args] of [["queue_pr", { item: "app#1" }], ["set_weight", { item: "app#1", weight: 9 }], ["cancel_queued", { item: "app#1" }]] as const) {
      const r = await call(maint, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /only operators steer the merge queue/);
    }
    assert.equal(preapprovalOf(w.db, "app", 1), null);
    assert.deepEqual(weights(w), []);
  });

  test("queue_pr pre-approves the PR at its head and fast-tracks it with the weight, as the Queue page does", async () => {
    const w = fresh().pr(1).pr(2);
    const op = envOf(w, "operator");
    const r = await call(op, "queue_pr", { item: "app#1", weight: 8 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Added to the merge queue/);
    assert.match(r.text, /weight 8, 1 of 1/);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "review");
    assert.equal(preapprovalOf(w.db, "app", 1)?.by, OPERATOR);
    assert.deepEqual(weights(w), [[1, 8]]);
    // The default weight; a URL works as the item too.
    assert.equal((await call(op, "queue_pr", { item: "https://github.com/storytold/app/pull/2" })).isError, false);
    assert.deepEqual(weights(w), [[1, 8], [2, 5]]);
    // Queued twice: the pre-approval's own refusal comes back.
    const again = await call(op, "queue_pr", { item: "app#1" });
    assert.equal(again.isError, true);
    assert.match(again.text, /already has a pre-approved merge in progress/);
  });

  test("set_weight changes, adds without approving, and removes; its arguments are checked", async () => {
    const w = fresh().pr(1).pr(2);
    const op = envOf(w, "operator");
    await call(op, "queue_pr", { item: "app#1", weight: 8 });
    assert.match((await call(op, "set_weight", { item: "app#1", weight: 3 })).text, /Set the weight\. app#1 is fast-tracked with weight 3/);
    assert.match((await call(op, "set_weight", { item: "app#2", weight: 6 })).text, /not approved by this/);
    assert.deepEqual(weights(w), [[2, 6], [1, 3]]);
    assert.equal(preapprovalOf(w.db, "app", 2), null);
    assert.match((await call(op, "set_weight", { item: "app#2", remove: true })).text, /Took app#2 off/);
    assert.match((await call(op, "set_weight", { item: "app#2", remove: true })).text, /was not fast-tracked/);
    assert.deepEqual(weights(w), [[1, 3]]);
    for (const args of [{ item: "app#1", weight: 11 }, { item: "app#1", weight: 2.5 }, { item: "app#1", weight: 4, remove: true }, { item: "nothing here" }, { item: "app#1", remove: "yes" }]) {
      assert.equal((await call(op, "set_weight", args)).isError, true, JSON.stringify(args));
    }
    assert.deepEqual(weights(w), [[1, 3]]);
  });

  test("cancel_queued withdraws the pre-approval and keeps the weight; a second cancel is refused", async () => {
    const w = fresh().pr(1);
    const op = envOf(w, "operator");
    await call(op, "queue_pr", { item: "app#1", weight: 7 });
    const r = await call(op, "cancel_queued", { item: "app#1" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /is cancelled\. app#1 is fast-tracked with weight 7.*remove: true/);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "cancelled");
    assert.deepEqual(weights(w), [[1, 7]]);
    const again = await call(op, "cancel_queued", { item: "app#1" });
    assert.equal(again.isError, true);
    assert.match(again.text, /no pre-approved merge in progress/);
  });

  test("list_merge_queue shows what an agent queued, with its weight, to any role; viewers get no logins", async () => {
    const w = fresh().pr(1).pr(2);
    await call(envOf(w, "operator"), "queue_pr", { item: "app#2", weight: 9 });
    for (const role of ["operator", "maintainer", "viewer"] as const) {
      const r = await call(envOf(w, role), "list_merge_queue", { repo: "app" });
      assert.equal(r.isError, false, r.text);
      const d = data(r.text);
      const row = d.prs.find((p: { item: string }) => p.item === "app#2");
      const pending = d.preapprovedBeforeReview.find((p: { item: string }) => p.item === "app#2");
      assert.ok(row || pending, r.text);
      if (row) {
        assert.equal(row.fastTrack.weight, 9);
        assert.equal(row.added.how, "queued");
        assert.equal(row.added.by, role === "viewer" ? null : OPERATOR);
      } else assert.equal(pending.by, role === "viewer" ? null : OPERATOR);
    }
    assert.equal((await call(envOf(w, "viewer"), "list_merge_queue", { cursor: "x" })).isError, true);
  });
});
