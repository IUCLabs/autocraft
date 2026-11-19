// The wire format between the server and the user-local helper (`worker/autocraft-task.mjs`) in the
// `user-local` inference mode: model calls run in a harness on a maintainer's own machine, under their
// own subscription; everything else (planner, gates, GitHub writes, builds) stays on the server.
// No Node imports: the helper keeps its own copy of these shapes and the dashboard build may import this file.

/** Bumped on any change to these shapes; the server refuses a claim from a helper of another version. */
export const PROTOCOL_VERSION = 3;

/** API routes on the dashboard origin. Agent-token routes take `Authorization: Bearer <agent token>`; lease routes take `Authorization: Bearer <lease secret>`. */
export const ROUTES = {
  /** Agent token. Body `Claim`, reply `ClaimReply`. */
  claim: "/api/remote/claim",
  /** Lease secret. Reply `TaskBundle`. */
  bundle: "/api/remote/bundle",
  /** Agent token. Body `HelperStatus`, reply `StatusReply`: the helper's readiness, sent on every change and at least every STATUS_EVERY_S while it runs. */
  status: "/api/remote/status",
  /** Lease secret. Body `Heartbeat`, reply `{ ok: true }`, or 410 when the lease is gone (expired, cancelled, re-queued). Every lease route answers 410 for an ended lease, never 401. */
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
/** The effort ladder, lowest first; a harness without the top levels maps them to its own highest (Codex: max to xhigh). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type HarnessId = "claude" | "codex";

/** What a helper offers when it asks for work. */
export type Claim = {
  protocol: number;
  helperVersion: string;
  harness: HarnessId;
  harnessVersion: string;
  /** Tiers this helper takes, each with the model its harness runs for it: an alias (opus, sonnet, haiku) or a full model id. The server accepts a tier only when the model belongs to a family accepted for it, and matches models by family. */
  tiers: Partial<Record<Tier, string>>;
  /** The highest effort the helper passes to its harness per tier (for Claude the prompt's effort as given, for Codex the reasoning effort its adapter maps to). The server offers a tier only when this meets the tier's minimum effort; a tier without it meets no minimum. */
  efforts?: Partial<Record<Tier, Effort>>;
  /** Only calls on these repos, within the repos the user picked on the Connect page; absent means any the user may take. */
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
  /**
   * Unique per claim attempt (8 to 64 characters of letters, digits, `-` and `_`). A claim repeated with the same id within
   * CLAIM_ID_TTL_S gets the same reply, so a helper whose reply was lost (reset, proxy error, timeout) retries safely.
   */
  requestId: string;
  /** The claim comes from the helper's fast-lane slot: the server offers it only follow-ups of its sessions, gating calls and small-tier calls. */
  fastLane?: boolean;
};

/** How long the server remembers a claim's `requestId` and its reply. */
export const CLAIM_ID_TTL_S = 300;

/**
 * The plan usage a helper keeps in reserve, per window: it claims only while the remaining percent (100 - used) of every
 * window is above it. Set per user on the dashboard (0 to 90, default 20); a helper's local setting may only raise it.
 */
export type Reserve = { fiveHour: number; weekly: number };

export type ClaimReply =
  | { lease: null; /** Seconds to wait before the next claim when nothing is queued. */ retryAfter: number; reserve: Reserve; /** Present while the token gets no calls: why (repeated lost leases), and when it may claim again (ms since epoch). `retryAfter` then runs to `until`. */ reason?: string; until?: number }
  | { lease: { id: number; secret: string; /** One line: prompt id and the item, e.g. "review.opus on designcraft#1502". */ title: string; requiredHelper: string }; reserve: Reserve };

/**
 * Whether a helper takes calls now. `ready`: it claims. `quota-held`: a plan window is at or below the reserve, its usage
 * could not be read, or the provider refused a run for its limit. `paused`: its user paused it until a reset. `cooled-off`: the
 * server gives the login, across all its helpers and tokens, no calls for a while after repeated lost leases or failed
 * replies (ClaimReply `reason`, `until`; src/remote/cooloff.ts). `failing`: the helper's last 5 calls failed or were given
 * back in a row; it claims again at `until` if its checks pass (`reason` names the last error). The
 * rest need the user: the sandbox check failed, the server refused the helper's version, or the harness or its login is missing.
 */
export type Readiness = "ready" | "quota-held" | "paused" | "cooled-off" | "sandbox-failed" | "version-refused" | "harness-missing" | "failing";
export const READINESS: readonly Readiness[] = ["ready", "quota-held", "paused", "cooled-off", "sandbox-failed", "version-refused", "harness-missing", "failing"];
/** The longest time between two status reports of a running helper. */
export const STATUS_EVERY_S = 300;

/** One plan window as the helper last read it: percent used (0-100) and when it resets (ISO time, null when unknown). */
export type UsageWindow = { usedPercent: number; resetsAt: string | null };
/** The plan usage behind a status; `at` is when it was read. A window is null when the provider reported none. */
export type UsageReading = { fiveHour: UsageWindow | null; weekly: UsageWindow | null; at: string };

export type HelperStatus = {
  readiness: Readiness;
  /** When a hold or pause ends (ISO time); absent when it ends only when usage is read again or the user acts. */
  until?: string;
  /** One line on why the helper is not ready. */
  reason?: string;
  harness: HarnessId;
  /** The model the helper runs for each tier. */
  models: Partial<Record<Tier, string>>;
  /** The reserve the helper enforces: the user's, raised by its local setting. */
  reserve: Reserve;
  usage?: UsageReading;
  /** Calls the helper runs at once: its `--parallel` slots plus the fast lane. */
  slots: number;
  /** Slots running a call now. */
  busy: number;
  /** The helper's last error talking to the server or running a call, until it recovers: what failed, in one line, and when (ISO time). */
  lastError?: { text: string; at: string };
};
/** The user's reserve, so a helper knows it before its first claim. */
export type StatusReply = { ok: true; reserve: Reserve };

/** One of the user's helpers (agent tokens that may run tasks), for the Connect page and my_work: GET /api/remote/helpers replies `{ helpers: HelperInfo[] }`. */
export type HelperInfo = {
  tokenId: number;
  label: string | null;
  /** Null when the helper has never reported a status. */
  readiness: Readiness | null;
  until: string | null;
  reason: string | null;
  /** Whether the last status is recent enough to count (STATUS_EVERY_S and some slack); a stale `ready` helper gets no calls. */
  fresh: boolean;
  /** The last status report or claim (ISO time), null when the token was never used by a helper. */
  lastSeen: string | null;
  harness: HarnessId | null;
  models: Partial<Record<Tier, string>>;
  reserve: Reserve | null;
  usage: UsageReading | null;
  slots: number | null;
  busy: number | null;
  lastError: { text: string; at: string } | null;
};

/**
 * GET and PUT /api/me/settings (session routes): the signed-in user's own settings. `repos`: the repos their helpers take calls
 * from, empty for every repo. A PUT sends either field or both.
 */
export type UserSettings = { reserve: Reserve; repos: string[]; /** The most calls the user's helpers run at once, all helpers together; null for no limit. */ maxCalls: number | null };
/** The settings with `repoChoices`: the tracked repos with the pipeline on where the user has write permission, sorted. */
export type UserSettingsReply = UserSettings & { repoChoices: string[] };

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

/**
 * Sent every HEARTBEAT_S from the claim until the submit or release. `preparing`: fetching the bundle and the code; the
 * call's time limit has not started, but preparing may take at most PREPARE_MAX_S. `running`: the harness runs; the first
 * `running` heartbeat starts the time limit.
 */
export type Heartbeat = { phase: "preparing" | "running"; /** The harness's last progress line, shown on the run. */ progress?: string };
export const HEARTBEAT_S = 30;
export const PREPARE_MAX_S = 15 * 60;

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** One tool use of the call, as the harness recorded it: the same fields a local run stores (src/agents/tools.ts). */
export type SubmitTool = { name: string; /** The input as JSON, at most 4000 characters. */ args: string; /** Size of the result; null when no result came back. */ resultBytes: number | null; isError: boolean; startedAt?: string; endedAt?: string };

export type Submit =
  | { ok: true; text: string; /** The full model id the harness reported (e.g. from the CLI's result); matched by family against the claim's model for the tier. */ model: string; usage: Usage; /** Per model id, subagents (the explorer) included; `usage` is the whole call when this is absent. */ modelUsage?: Record<string, Usage>; /** The harness's cost for the whole call at list price, when it reports one (the Claude CLI's `total_cost_usd`). */ costUsd?: number; turns?: number; /** The harness session id, kept by the helper for follow-ups. */ sessionId?: string; /** Tool uses in order, subagents included. */ tools?: SubmitTool[]; durationMs: number }
  | { ok: false; error: string; usage?: Usage; durationMs: number };

export type SubmitReply = { accepted: boolean; reason?: string };

/** A tool's result, as an MCP tools/call result carries it. */
export type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export type Release = { /** Why the helper gives the lease back, shown on the call. */ reason: string };
