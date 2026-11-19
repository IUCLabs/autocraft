// The wire format between the server and the user-local helper (`worker/autocraft-task.mjs`) in the
// `user-local` inference mode: model calls run in a harness on a maintainer's own machine, under their
// own subscription; everything else (planner, gates, GitHub writes, builds) stays on the server.
// No Node imports: the helper keeps its own copy of these shapes and the dashboard build may import this file.

/** Bumped on any change to these shapes; the server refuses a claim from a helper of another version. */
export const PROTOCOL_VERSION = 1;

/** API routes on the dashboard origin. Agent-token routes take `Authorization: Bearer <agent token>`; lease routes take `Authorization: Bearer <lease secret>`. */
export const ROUTES = {
  /** Agent token. Body `Claim`, reply `ClaimReply`. */
  claim: "/api/remote/claim",
  /** Lease secret. Reply `TaskBundle`. */
  bundle: "/api/remote/bundle",
  /** Lease secret. Body `Heartbeat`, reply `{ ok: true }`, or 410 when the lease is gone (expired, cancelled, re-queued). */
  heartbeat: "/api/remote/heartbeat",
  /** Lease secret. Body `Submit`, reply `SubmitReply`. */
  submit: "/api/remote/submit",
  /** Lease secret. Body `Release`, reply `{ ok: true }`: the call goes back to the queue without using an attempt (the helper is too old, or its platform or harness login is missing). */
  release: "/api/remote/release",
  /** Lease secret. A private repo's checkout or a workspace entry as a tar stream: `?repo=<name>&sha=<sha>`. */
  tarball: "/api/remote/tarball",
  /** Lease secret. One tool call of a server the bundle lists, without MCP: `POST ${tool}/<server>/<tool>`, body the tool's arguments, reply `ToolReply`. A long call (the `check` tool) sends whitespace before the JSON while it runs. */
  tool: "/api/remote/tool",
  /** Lease secret. Streamable HTTP MCP servers with only this call's tools, one per server name: `/mcp/task/<name>` (items, build, reference). */
  mcp: "/mcp/task",
  /** The helper itself, a single file. */
  helper: "/worker/autocraft-task.mjs",
} as const;

export type Tier = "top" | "mid" | "small";
export type HarnessId = "claude" | "codex";

/** What a helper offers when it asks for work. */
export type Claim = {
  protocol: number;
  helperVersion: string;
  harness: HarnessId;
  harnessVersion: string;
  /** Tiers this helper takes, each with the model its harness runs for it: an alias (opus, sonnet, haiku) or a full model id. The server accepts a tier only when the model belongs to a family accepted for it, and matches models by family. */
  tiers: Partial<Record<Tier, string>>;
  /** Only calls on these repos; absent means any the user may take. */
  repos?: string[];
  /** A follow-up turn for a session this helper still holds: the server offers follow-ups for these call ids first. */
  sessions?: number[];
  /**
   * A directory the helper places the sandbox paths below, when its sandbox cannot place them at the filesystem root
   * (macOS: sandbox-exec confines paths but cannot remap them). The bundle's text and `claude` hints then name
   * `<root>/repo`, `<root>/repos/<name>`, `<root>/repo-docs`, `<root>/mcp.json` and `<root>/agents.json`, and the reply's
   * paths are read back without it. Absolute, letters, digits and `. _ + @ -`, no `.` or `..` component. Absent: the fixed paths.
   */
  root?: string;
};

export type ClaimReply =
  | { lease: null; /** Seconds to wait before the next claim when nothing is queued. */ retryAfter: number }
  | { lease: { id: number; secret: string; /** One line: prompt id and the item, e.g. "review.opus on designcraft#1502". */ title: string; requiredHelper: string } };

/** A directory the harness reads, at a fixed path inside the sandbox. */
export type Mount =
  /** A public repo at a commit: the helper fetches `sha` from GitHub (`ref`, e.g. refs/pull/12/head, when the SHA is not on a branch) into its bare-clone cache and checks it out without instruction files. */
  | { kind: "git"; path: string; owner: string; repo: string; sha: string; ref?: string }
  /** A private repo or anything else from the server: GET ROUTES.tarball. */
  | { kind: "tarball"; path: string; repo: string; sha: string }
  /** Small files sent inline (repo docs, screenshots as base64, logs). */
  | { kind: "files"; path: string; /** `name` is a relative path below `path`, possibly with subdirectories; never absolute, never with `..`. */ files: { name: string; base64: string }[] };

export type TaskBundle = {
  callId: number;
  promptId: string;
  promptVersion: string;
  tier: Tier;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Wall-clock limit for the whole harness run. */
  timeoutSeconds: number;
  maxTurns: number | null;
  /** The text sent on stdin. */
  stdin: string;
  /** The system prompt for a call without a sandbox; null when the harness's own system prompt is kept. */
  system: string | null;
  /** Read-only mounts. Paths are the fixed sandbox paths (/repo, /repos/<name>, /repo-docs, /reference, /agents.json), below the claim's `root` when it has one. Empty for a call without tools. */
  mounts: Mount[];
  /** MCP servers the call may use, each served at `${ROUTES.mcp}/<name>` with this lease's secret; the names give the tool names (`mcp__<name>__*`). */
  mcpServers: string[];
  /** Whether the helper keeps the harness session after the call: a follow-up turn (lint fix, check reminder, resume) may continue it. */
  keepSession: boolean;
  /** A follow-up turn: resume this helper's session of the parent call instead of starting one. The helper resumes with the session id it recorded; the hints never carry `--resume`. */
  resume?: { parentCallId: number };
  /** Exact arguments for adapters that can use them; an adapter without hints builds its own from the fields above. */
  hints: {
    /** `claude` arguments as the server would run them (src/prompts `claudeArgs`), for the fixed sandbox paths or below the claim's `root`. The model name is replaced by the claim's model for the tier. */
    claude?: { args: string[]; /** The `--agents` file content when the call has the explorer. */ agents?: string };
  };
};

export type Heartbeat = { /** The harness's last progress line, shown on the run. */ progress?: string };

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

export type Submit =
  | { ok: true; text: string; /** The full model id the harness reported (e.g. from the CLI's result); matched by family against the claim's model for the tier. */ model: string; usage: Usage; /** Per model id, subagents (the explorer) included; `usage` is the whole call when this is absent. */ modelUsage?: Record<string, Usage>; /** The harness's cost for the whole call at list price, when it reports one (the Claude CLI's `total_cost_usd`). */ costUsd?: number; turns?: number; /** The harness session id, kept by the helper for follow-ups. */ sessionId?: string; durationMs: number }
  | { ok: false; error: string; usage?: Usage; durationMs: number };

export type SubmitReply = { accepted: boolean; reason?: string };

/** A tool's result, as an MCP tools/call result carries it. */
export type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export type Release = { /** Why the helper gives the lease back, shown on the call. */ reason: string };
