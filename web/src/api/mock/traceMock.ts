// Item traces on fake data: a PR with two pushes, model calls, a check run, a review, a decision and a GitHub write.
import type { Api } from "../client";
import type { AgentRunDetail, AgentRunTool, ItemTrace, ItemTraceDetail, TraceEvent, TraceKind } from "../types";
import { NOW } from "./fixtures";

const wait = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const H1 = "3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49";
const H2 = "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c";

const EVENTS: TraceEvent[] = ([
  { id: "plan:41", kind: "plan", at: at(4), head: H2, actor: { type: "step", name: "Planner" }, summary: "Plan reviewing → verifying, waiting for CI at 9b8c7d6", ref: { head: H2 } },
  { id: "check:12", kind: "check", at: at(9), head: H2, actor: { type: "step", name: "Fix-up" }, summary: "Clippy on app-core: no findings", ref: { checkId: 12, runId: 902, head: H2 } },
  { id: "task:905", kind: "check", at: at(10), head: H2, actor: { type: "step", name: "Verify" }, summary: "Build task done: build and 412 tests passed", ref: { taskId: 905, head: H2 } },
  { id: "audit:77", kind: "write", at: at(12), head: H2, actor: { type: "step", name: "AutoCraft" }, summary: "Posted review", ref: { auditRowid: 77, head: H2 } },
  {
    id: "run:903", kind: "model-call", at: at(14), head: H2, actor: { type: "model", name: "opus" }, summary: "Review pull requests: take-fix with two fixes", ref: { runId: 903, jobId: 55 },
    call: { model: "opus", provider: "claude", account: "Team account B", state: "done", inputTokens: 48_200, outputTokens: 2_900, costUsd: 0.91, toolCalls: 7, endedAt: at(13) },
  },
  { id: "review:opus:5", kind: "review", at: at(13), head: H2, actor: { type: "model", name: "opus" }, summary: "Opus review: take with two fixes, not sure", ref: { reviewId: "opus:5", head: H2 } },
  { id: "gh:push", kind: "github", at: at(30), head: H2, actor: { type: "person", name: "contributor" }, summary: "Pushed 9b8c7d6", ref: { head: H2 } },
  { id: "comment:c2", kind: "github", at: at(70), head: H1, actor: { type: "person", name: "maintainer" }, summary: "Posted a comment, 214 characters", ref: { commentId: "c2" } },
  { id: "decision:d9:asked", kind: "decision", at: at(95), head: H1, actor: { type: "step", name: "Ask decisions" }, summary: "Asked: Merge this fix?", ref: { decisionId: "designcraft#1484:merge" } },
  {
    id: "run:901", kind: "model-call", at: at(120), head: H1, actor: { type: "model", name: "opus" }, summary: "Review pull requests: hold", ref: { runId: 901, jobId: 52 },
    call: { model: "opus", provider: "claude", account: "Team account C", state: "done", inputTokens: 51_000, outputTokens: 3_300, costUsd: 0.97, toolCalls: 11, endedAt: at(118) },
  },
  { id: "plan:38", kind: "plan", at: at(125), head: H1, actor: { type: "step", name: "Planner" }, summary: "Plan started as reviewing", ref: { head: H1 } },
  { id: "gh:opened", kind: "github", at: at(130), head: H1, actor: { type: "person", name: "contributor" }, summary: "Opened pull request", ref: {} },
] as TraceEvent[]).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));

const TRACE: Omit<ItemTrace, "events" | "nextCursor"> = {
  header: {
    now: { state: "verifying", head: H2, plannedAt: at(4), text: "Waiting for CI at 9b8c7d6", waitsOn: "CI at 9b8c7d6", reasons: [], note: null },
    next: [{ kind: "verify", head: H2 }, { kind: "premerge", head: H2 }],
    who: { assignees: ["autocraft"], autocraftAssigned: true, openDecisions: [{ id: "designcraft#1484:merge", kind: "merge", question: "Merge this fix?" }], holds: [] },
  },
  stamp: "mock",
};

const TOOLS: AgentRunTool[] = [
  { seq: 1, tool: "Read", args: '{"file_path":"crates/app-core/src/frame.rs"}', resultBytes: 18_400, isError: false, startedAt: at(14), endedAt: at(14), check: null },
  { seq: 2, tool: "Grep", args: '{"pattern":"overset","path":"crates"}', resultBytes: 2_100, isError: false, startedAt: at(14), endedAt: at(14), check: null },
  { seq: 3, tool: "mcp__build__check", args: "", resultBytes: 640, isError: false, startedAt: at(14), endedAt: at(13), check: { id: 12, command: "clippy", crate: "app-core", testName: null, outcome: "ok" } },
  { seq: 4, tool: "Read", args: '{"file_path":"crates/missing.rs"}', resultBytes: 90, isError: true, startedAt: null, endedAt: null, check: null },
];

/** Run detail for the runs of the trace mock, with tool calls. */
export function traceRunDetail(id: number): AgentRunDetail | null {
  const e = EVENTS.find((x) => x.ref.runId === id && x.call);
  if (!e?.call) return null;
  const c = e.call;
  const text = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the model text for ${e.summary}.`).join("\n");
  return {
    id, jobId: e.ref.jobId ?? null, step: "opus-review", stage: 5, promptId: "opus-review", promptVersion: "a1b2c3d", provider: "claude", model: c.model, accountId: "b", accountLabel: c.account,
    items: [], itemCount: 1, state: "done", startedAt: e.at, endedAt: c.endedAt, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: null, cacheWriteTokens: null, costUsd: c.costUsd, summary: null,
    prompt: text(40), output: text(18), error: null, tools: TOOLS,
  };
}

const FIELDS: Record<string, Record<string, unknown>> = {
  "review:opus:5": { verdict: "take-fix", sure: false, reason: "The change is **correct**, but two spots need care.\n\n- The overset check ignores locked frames.", fixes: [{ file: "crates/app-core/src/frame.rs", change: "skip locked frames in the overset pass" }, { file: "crates/app-core/src/lib.rs", change: "export the new helper" }], risks: ["Frames with negative leading may flicker."] },
  "plan:41": { from: "reviewing", to: "verifying", wait: "CI at 9b8c7d6", reasons: ["review took the fix", "no open conflicts"] },
  "task:905": {},
  "audit:77": { action: "review-post", by: "autocraft", state: "done", textLength: 1480 },
};

export function createTraceMock(): Pick<Api, "itemTrace" | "itemTraceDetail"> {
  return {
    itemTrace(_repo, _number, q = {}) {
      const kinds = q.kinds ? new Set<TraceKind>(q.kinds) : null;
      let list = EVENTS.filter((e) => (!kinds || kinds.has(e.kind)) && (!q.autocraftOnly || e.actor.type !== "person"));
      if (q.since === TRACE.stamp) return wait({ unchanged: true as const, stamp: TRACE.stamp });
      if (q.cursor) {
        const i = list.findIndex((e) => `${e.at}|${e.id}` === q.cursor);
        list = i < 0 ? list : list.slice(i + 1);
      }
      const limit = q.limit ?? 100;
      const events = list.slice(0, limit);
      const last = events[events.length - 1];
      return wait({ ...TRACE, events, nextCursor: list.length > limit && last ? `${last.at}|${last.id}` : null });
    },
    itemTraceDetail(_repo, _number, id): Promise<ItemTraceDetail> {
      const e = EVENTS.find((x) => x.id === id);
      if (!e) throw new Error(`no event ${id}`);
      return wait({ id: e.id, kind: e.kind, at: e.at, summary: e.summary, fields: FIELDS[e.id] ?? { head: e.head, note: "mock detail" } });
    },
  };
}
