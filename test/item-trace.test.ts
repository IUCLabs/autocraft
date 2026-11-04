import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { saveTools } from "../src/agents/tools.ts";
import { connect } from "../src/db.ts";
import { syncActivity } from "../src/activity.ts";
import { trace, traceDetail } from "../src/dash/api/trace.ts";
import type { Req } from "../src/dash/types.ts";
import type { ItemTrace } from "../web/src/api/types.ts";

const req = (n: number, query: Record<string, string> = {}, extra: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: { repo: "photocraft", n: String(n) }, query: new URLSearchParams({ ...query, ...extra }), form: new URLSearchParams(), user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true },
  csrf: "", nonce: "",
});
const full = async (db: ReturnType<typeof connect>, q: Record<string, string> = {}) => (await trace(db, req(7, q))) as ItemTrace;

test("the trace lists every source of an item newest first, with heads, a cursor and a since check", async () => {
  const db = connect(":memory:");
  const H1 = "a".repeat(40), H2 = "b".repeat(40);
  db.prepare("INSERT INTO items (repo, number, kind, state, author, created_at, head_oid, assignees) VALUES ('photocraft', 7, 'pr', 'OPEN', 'dev', '2026-01-01T00:00:00Z', ?, '[\"bot\"]')").run(H2);
  db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'bot')").run();
  db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, commit_oid) VALUES ('photocraft', 7, 'c1', 'comment', 'dev', '2026-01-01T01:00:00Z', 'please look', NULL)").run();
  db.prepare("INSERT INTO plan_history (repo, number, head, old_state, new_state, wait, reasons, at) VALUES ('photocraft', 7, ?, 'reviewing', 'verifying', 'CI', '[]', '2026-01-01T02:00:00Z')").run(H1);
  const run = insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", accountId: null, items: [{ repo: "photocraft", number: 7 }], prompt: "secret prompt" });
  db.prepare("UPDATE agent_runs SET started_at = '2026-01-01T03:00:00Z'").run();
  saveTools(db, run, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "x" } }] } }]);
  finishRun(db, run, { state: "done", output: "o", costUsd: 0.5 });
  db.prepare("INSERT INTO opus_review_history (repo, number, head_oid, at, model, mode, verdict, sure, reason) VALUES ('photocraft', 7, ?, '2026-01-01T04:00:00Z', 'opus', 'full', 'hold', 1, 'why')").run(H1);
  db.prepare("INSERT INTO opus_review_history (repo, number, head_oid, at, model, mode, verdict, sure, reason) VALUES ('photocraft', 7, ?, '2026-01-01T05:00:00Z', 'opus', 'delta', 'take', 1, 'fine')").run(H2);
  db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES ('2026-01-01T06:00:00Z', 'bot', 'review-post', 'photocraft#7', ?)").run(JSON.stringify({ head: H2, state: "done", text: "long posted text" }));

  const asked: unknown[] = [];
  const client = {
    spent: 0, remaining: 4000,
    async query(_q: string, v: object) {
      asked.push(v);
      return { repository: { issueOrPullRequest: {
        __typename: "PullRequest", headRefOid: H2,
        files: { nodes: [{ path: "src/a.rs", additions: 3, deletions: 1, changeType: "MODIFIED" }] },
        commits: { nodes: [{ commit: { oid: H1, committedDate: "2026-01-01T00:30:00Z", author: { user: { login: "dev" } } } }] },
        prTimeline: { nodes: [{ __typename: "LabeledEvent", id: "L1", createdAt: "2026-01-01T00:45:00Z", actor: { login: "maint" }, label: { name: "bug" } }] },
      } } };
    },
  };
  assert.equal(await syncActivity(db, client), 1);
  assert.equal(await syncActivity(db, client), 0, "an item whose head and update time are unchanged is not read again");
  assert.deepEqual(asked, [{ name: "photocraft", number: 7 }]);

  const t = await full(db);
  assert.deepEqual(t.events.map((e) => e.id.replace(/:\d+$/, "")), ["audit", "review:opus", "review:opus", "run", "plan", "comment:c1", "activity:L1", `commit:${H1}`, "gh:opened"]);
  assert.deepEqual(t.events.filter((e) => e.id.startsWith("activity") || e.id.startsWith("commit")).map((e) => e.summary), ["Added label bug", "Pushed commit aaaaaaa"]);
  assert.deepEqual(db.prepare("SELECT path FROM pr_files WHERE repo = 'photocraft' AND number = 7 AND head = ?").all(H2).map((r) => r.path), ["src/a.rs"]);
  assert.deepEqual(t.events.slice(0, 5).map((e) => e.head), [H2, H2, H1, H1, H1], "a model call takes the head current at its time");
  const call = t.events.find((e) => e.kind === "model-call")!;
  assert.equal(call.call?.toolCalls, 1);
  assert.equal(call.call?.costUsd, 0.5);
  assert.equal(call.ref.runId, run);
  assert.ok(!JSON.stringify(t).includes("long posted text") && !JSON.stringify(t).includes("secret prompt"), "no bodies in the list");
  assert.equal(t.header.now.state, null);
  assert.deepEqual(t.header.who.assignees, ["bot"]);
  assert.equal(t.header.who.autocraftAssigned, true);

  const p1 = await full(db, { limit: "3" });
  assert.equal(p1.events.length, 3);
  const p2 = await full(db, { limit: "3", cursor: p1.nextCursor! });
  assert.deepEqual([...p1.events, ...p2.events.slice(0, 3)].map((e) => e.id), t.events.slice(0, 6).map((e) => e.id));
  assert.equal((await full(db, { limit: "3", cursor: (await full(db, { limit: "6" })).nextCursor! })).nextCursor, null);

  assert.deepEqual((await full(db, { kinds: "write,decision" })).events.map((e) => e.kind), ["write"]);
  assert.ok((await full(db, { autocraftOnly: "1" })).events.every((e) => e.actor.type !== "person"));
  assert.deepEqual(await trace(db, req(7, { since: t.stamp })), { unchanged: true, stamp: t.stamp });
  db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 7, 'c2', 'comment', 'dev', '2026-01-02T00:00:00Z', 'x')").run();
  assert.notEqual((await trace(db, req(7, { since: t.stamp }))).stamp, t.stamp);

  const d = await traceDetail(db, req(7, { id: `review:opus:${(db.prepare("SELECT rowid FROM opus_review_history WHERE verdict = 'hold'").get() as { rowid: number }).rowid}` }));
  assert.equal(d.fields.reason, "why");
  const w = await traceDetail(db, req(7, { id: t.events[0]!.id }));
  assert.equal(w.fields.textLength, 16);
});
