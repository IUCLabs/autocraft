// The Now page on fake data: a failing sync, a red main, a paused account, running work of every kind and recent events.
import type { Api } from "../client";
import type { Now, NowEvent, NowRunning } from "../types";
import { NOW } from "./fixtures";

const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const item = (repo: string, number: number, title: string, kind: "pr" | "issue" = "pr") => ({ repo, number, kind, state: "open" as const, title });
const A = item("designcraft", 1484, "Fix overset detection for locked frames");
const B = item("photocraft", 3921, "Add a wave filter to the effects panel");
const C = item("filmcraft", 2210, "Audio drifts after trimming a clip");
const D = item("pdfcraft", 877, "Export fails on pages with spot colors");

const HEALTH: Now["health"] = {
  pipeline: { enabled: true, by: "operator", at: at(60 * 30) },
  problems: [
    { id: "sync", area: "sync", tone: "bad", text: "Sync is failing: GraphQL request failed with HTTP 502 for storytold/craft-libs", to: "/pipeline", since: at(620) },
    { id: "main-ci:designcraft", area: "main-ci", tone: "bad", text: "Main is red in designcraft: Tests, Clippy", to: "/main-ci", since: at(95) },
    { id: "account:c", area: "account", tone: "warn", text: "Account Team account C is paused: 5-hour use 92 % (pauses at 90 %)", to: "/accounts", since: null },
    { id: "jobs", area: "jobs", tone: "warn", text: "2 jobs failed in the last hour: Review pull requests", to: "/pipeline", since: null },
    { id: "repos", area: "repos", tone: "info", text: "Pipeline is off for wordcraft, gridcraft", to: "/repos", since: null },
  ],
};

const RUNNING: NowRunning[] = [
  {
    key: "run:912", kind: "model-call", step: "Review pull requests", what: "opus on Team account B", state: "running", startedAt: at(6), progress: "Reading crates/app-core/src/frame.rs", repo: "designcraft",
    items: [A], itemCount: 1, event: "run:912", detail: "/agents/912",
  },
  {
    key: "run:911", kind: "model-call", step: "Classify items", what: "Jev", state: "running", startedAt: at(1), progress: null, repo: "photocraft",
    items: [B, C, D], itemCount: 40, event: "run:911", detail: "/agents/911",
  },
  {
    key: "job:640", kind: "job", step: "Review pull requests", state: "running", what: null, startedAt: at(7), progress: "Reviewing 1 of 2: designcraft#1484", repo: "designcraft",
    items: [A], itemCount: 2, event: "job:2210", detail: "/pipeline/640",
  },
  {
    key: "task:931", kind: "task", step: "Build task, Verify pull requests", what: "Build box", state: "running", startedAt: at(12), progress: null, repo: "photocraft",
    items: [B], itemCount: 1, event: "task:931", detail: "/envs/931",
  },
  {
    key: "task:932", kind: "task", step: "Build task, Verify pull requests", what: null, state: "queued", startedAt: at(3), progress: null, repo: "filmcraft",
    items: [C], itemCount: 1, event: "task:932", detail: "/envs/932",
  },
  {
    key: "batch:14", kind: "batch", step: "Integration batch", what: "integration-pdfcraft-20261102-1", state: "open", startedAt: at(40), progress: null, repo: "pdfcraft",
    items: [D, item("pdfcraft", 871, "Update spot color table")], itemCount: 2, event: null, detail: "/queue/merge",
  },
];

const RECENT: NowEvent[] = [
  { key: "audit:90", kind: "write", at: at(2), summary: "Posted review", actor: "AutoCraft", item: B, event: "audit:90", detail: null },
  { key: "failed-job:639", kind: "failure", at: at(9), summary: "Review pull requests failed: claude exited with code 1", actor: "AutoCraft", item: C, event: "job:2205", detail: "/pipeline/639" },
  { key: "merge:51", kind: "merge", at: at(21), summary: "Merged (squash) by rule", actor: "AutoCraft", item: item("craft-libs", 412, "Bump the egui pin"), event: "merge:51", detail: null },
  { key: "decision:d4", kind: "decision", at: at(34), summary: "Answered \"Merge this fix?\": Merge", actor: "maintainer", item: D, event: "decision:d4:answered", detail: "/decisions/d4" },
  { key: "audit:88", kind: "write", at: at(41), summary: "Labelled: bug, needs-review", actor: "AutoCraft", item: A, event: "audit:88", detail: null },
  { key: "failed-task:930", kind: "failure", at: at(58), summary: "Build task (Verify pull requests) failed: 3 tests failed", actor: "AutoCraft", item: D, event: "task:930", detail: "/envs/930" },
];

export function createNowMock(): Pick<Api, "now"> {
  return { now: () => new Promise((r) => setTimeout(() => r(structuredClone({ health: HEALTH, running: RUNNING, recent: RECENT })), 60)) };
}
