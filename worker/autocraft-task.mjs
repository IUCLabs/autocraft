#!/usr/bin/env node
// @ts-check
// autocraft-task: runs AutoCraft model calls on a maintainer's own machine, under their own harness subscription.
// It claims a call, fetches its bundle (prompt, checkouts, MCP servers), runs the harness in a read-only
// sandbox confined to the task directory, sends heartbeats and submits the reply. Planner, gates, GitHub
// writes and builds stay on the server.
//
// One file, only `node:` imports, Node 22 or later. The dashboard serves it at /worker/autocraft-task.mjs.
// The harness runs inside bubblewrap on Linux and WSL, inside sandbox-exec on macOS.
//
//   autocraft-task login <server-url>      agent token on stdin
//   autocraft-task harness claude [--keychain]  a `claude setup-token` token on stdin, or (macOS) Claude Code's own login from the Keychain
//   autocraft-task harness claude --config-dir [<dir>]  the login of a Claude config directory, read at each call (Linux)
//   autocraft-task harness codex [--device-auth]  logs Codex in to the helper's own CODEX_HOME
//   autocraft-task claim                   claims one call; prints its lease id
//   autocraft-task run [--detach] [<lease>]  runs a claimed lease (claims one when none is given)
//   autocraft-task wait <lease>            waits for a detached run (at most 9 minutes)
//   autocraft-task work [--parallel N]     claims, runs and submits in a loop
//   autocraft-task doctor                  checks platform, sandbox, harness, login and server
//   autocraft-task try <bundle.json>       runs a bundle from a file without a server (testing)
//   autocraft-task mcp <server> <lease>    stdio-to-HTTP proxy for one of the lease's MCP servers
//   autocraft-task tool <server> <tool> [<json>] [<lease>]  one tool call without MCP; prints the result
//   autocraft-task status                  whether the helper takes calls now, with the plan usage behind it
//   autocraft-task pause-until-reset       takes no call until the plan window resets (or `resume`)
//   autocraft-task resume                  ends a pause, and a hold after the provider refused a run
//   autocraft-task config reserve <5h> <weekly>  raises the usage reserve the server sets (percent kept free)

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync, closeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const HELPER_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Wire format: a copy of src/remote/protocol.ts (the helper is served alone, so it keeps its own).

/** Must equal the server's; the server refuses a claim from a helper of another version. */
export const PROTOCOL_VERSION = 3;

export const ROUTES = {
  claim: "/api/remote/claim",
  status: "/api/remote/status",
  bundle: "/api/remote/bundle",
  heartbeat: "/api/remote/heartbeat",
  submit: "/api/remote/submit",
  release: "/api/remote/release",
  tarball: "/api/remote/tarball",
  tool: "/api/remote/tool",
  mcp: "/mcp/task",
  helper: "/worker/autocraft-task.mjs",
};

/** @typedef {"top" | "mid" | "small"} Tier */
/** @typedef {"claude" | "codex"} HarnessId */
/**
 * @typedef {object} Claim
 * @property {number} protocol
 * @property {string} helperVersion
 * @property {HarnessId} harness
 * @property {string} harnessVersion
 * @property {Partial<Record<Tier, string>>} tiers
 * @property {Partial<Record<Tier, "low" | "medium" | "high" | "xhigh" | "max">>} [efforts]
 * @property {string[]} [repos]
 * @property {number[]} [sessions]
 * @property {string} [root]
 * @property {string} requestId
 * @property {boolean} [fastLane]
 */
/** @typedef {{ fiveHour: number, weekly: number }} Reserve  percent of each plan window kept free */
/** @typedef {{ lease: null, retryAfter: number, reserve: Reserve, reason?: string, until?: number } | { lease: { id: number, secret: string, title: string, requiredHelper: string }, reserve: Reserve }} ClaimReply */
/** @typedef {"ready" | "quota-held" | "paused" | "cooled-off" | "sandbox-failed" | "version-refused" | "harness-missing"} Readiness */
/** @typedef {{ usedPercent: number, resetsAt: string | null }} UsageWindow */
/** @typedef {{ fiveHour: UsageWindow | null, weekly: UsageWindow | null, at: string }} UsageReading */
/**
 * @typedef {object} HelperStatus
 * @property {Readiness} readiness
 * @property {string} [until]
 * @property {string} [reason]
 * @property {HarnessId} harness
 * @property {Partial<Record<Tier, string>>} models
 * @property {Reserve} reserve
 * @property {UsageReading} [usage]
 * @property {number} slots
 * @property {number} busy
 * @property {{ text: string, at: string }} [lastError]
 */
/** @typedef {{ ok: true, reserve: Reserve }} StatusReply */
/** The calls this process runs at once and how many run now, for status reports (set by `work`). */
const capacity = { slots: 1, busy: 0 };
/**
 * @typedef {{ kind: "git", path: string, owner: string, repo: string, sha: string, ref?: string }
 *   | { kind: "tarball", path: string, repo: string, sha: string }
 *   | { kind: "files", path: string, files: { name: string, base64: string }[] }} Mount  a `files` name is a relative path, possibly with subdirectories
 */
/**
 * @typedef {object} TaskBundle
 * @property {number} callId
 * @property {string} promptId
 * @property {string} promptVersion
 * @property {Tier} tier
 * @property {"low" | "medium" | "high" | "xhigh" | "max"} effort
 * @property {number} timeoutSeconds
 * @property {number | null} maxTurns
 * @property {string} stdin
 * @property {string | null} system
 * @property {Mount[]} mounts
 * @property {string[]} mcpServers
 * @property {boolean} keepSession  keep the harness session after the call, for follow-up turns
 * @property {{ parentCallId: number }} [resume]
 * @property {{ claude?: { args: string[], agents?: string } }} hints
 */
/** @typedef {{ phase: "preparing" | "running", progress?: string }} Heartbeat  `preparing` from the claim until the harness spawns */
export const HEARTBEAT_S = 30;
/** The longest a lease may stay in `preparing`. */
export const PREPARE_MAX_S = 15 * 60;
/** How long the server remembers a claim's `requestId` and its reply. */
export const CLAIM_ID_TTL_S = 300;
/** @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} Usage */
/** @typedef {{ name: string, args: string, resultBytes: number | null, isError: boolean, startedAt?: string, endedAt?: string }} SubmitTool */
/**
 * @typedef {{ ok: true, text: string, model: string, usage: Usage, modelUsage?: Record<string, Usage>, costUsd?: number, turns?: number, sessionId?: string, tools?: SubmitTool[], durationMs: number }
 *   | { ok: false, error: string, usage?: Usage, durationMs: number }} Submit
 */
/** @typedef {{ accepted: boolean, reason?: string }} SubmitReply */
/** @typedef {{ reason: string }} Release */

// ---------------------------------------------------------------------------
// Harness adapters: `claudeAdapter` and `codexAdapter`, listed in ADAPTERS.

/**
 * What an adapter gets for one run.
 * @typedef {object} AdapterTask
 * @property {TaskBundle} bundle
 * @property {string} model      the model this helper runs for the bundle's tier
 * @property {string} bin        resolved harness binary on the host
 * @property {string} token      the harness credential (environment only, never argv): a token, or for codex the helper's own CODEX_HOME
 * @property {{ host: string, path: string }[]} mounts   prepared read-only mounts, `path` inside the sandbox
 * @property {string} taskDir    host directory for generated files (MCP config, agents file)
 * @property {string} mcpFile    host file with the MCP config, or "" when the call has no MCP servers
 * @property {{ server: string, secret: string }} lease  for adapters that configure the MCP servers themselves
 * @property {{ url: string, token: string }} [files]  the helper's file tools for this run, for an adapter with `fileTools`
 * @property {string} [sessionDir]  writable host directory for the harness's session store
 * @property {string} [resumeId]    harness session id to continue
 * @property {{ root: string, profile: string, install: { argv: string[] } }} [mac]  macOS: the slot (mounts, MCP config and agents file are in it) and the sandbox-exec profile
 */
/**
 * @typedef {object} Reply
 * @property {boolean} ok
 * @property {string} text
 * @property {string} model
 * @property {Usage | undefined} usage  the requested model's
 * @property {Record<string, Usage>} [modelUsage]  per model id, subagents included
 * @property {number} [costUsd]  the whole call's cost as the harness reports it
 * @property {number} [turns]
 * @property {string} [sessionId]
 * @property {string} [error]
 */
/**
 * @typedef {object} Adapter
 * @property {HarnessId} id
 * @property {(cfg: Config) => { bin: string | null, version: string | null, loggedIn: boolean }} detect
 * @property {(task: AdapterTask) => { cmd: string, args: string[], env: Record<string, string> }} command  the sandboxed process
 * @property {(stdout: string, model: string) => Reply} parse
 * @property {(args: string[], sessionId: string) => string[]} resume  harness arguments for a follow-up turn
 * @property {(line: string) => string | null} progress  a progress line from one output line, or null
 * @property {(cfg: Config) => string | undefined} token  the stored harness credential
 * @property {(cfg: Config, timeoutSeconds: number) => { token: string } | { problem: string }} [tokenFor]  the credential for a call of this timeout, or why the call can't run now (released, not failed)
 * @property {Partial<Record<Tier, string>>} defaultTiers  empty when the user must name every tier's model
 * @property {"high" | "xhigh" | "max"} maxEffort  the highest level of the effort ladder the harness is given; a bundle's higher effort is passed as this
 * @property {(bin: string) => { cmd: string, args: string[], env: Record<string, string> }} versionInSandbox  the harness's version command inside the sandbox (doctor, Linux)
 * @property {(bin: string) => { argv: string[], files: string[], dirs: string[] }} install  macOS: what runs the harness and what of its install the profile lets it read
 * @property {(bin: string, token: string) => string | null} [preflight]  prepares the harness's files before every call; why it must not run, or null
 * @property {boolean} [exclusive]  one call at a time per helper (the harness refreshes a shared login)
 * @property {boolean} [fileTools]  the run gets the helper's read-only file tools (its own read tool can't be confined)
 * @property {(version: string) => string | null} [unaudited]  why this harness version must not run calls, or null
 * @property {(line: string, servers: string[]) => string | null} [guard]  an output line showing a tool the call may not use: the run is stopped at once
 * @property {(o: { token: string, sessionId: string | undefined, servers: string[], keep: boolean }) => { problem: string | null, tools?: SubmitTool[] }} [verify]  after the run, from the harness's own record: a tool the call may not use (or null), and the tool uses
 * @property {(stdout: string, stamps: string[]) => SubmitTool[]} [tools]  the tool uses from the output; `stamps` holds the arrival time of each complete output line
 */

// ---------------------------------------------------------------------------
// Pure functions (exported for tests).

const INSTRUCTION_FILES = new Set(["claude.md", "claude.local.md", "agents.md"]);

/** True for a path claude could load as instructions or settings: CLAUDE.md, CLAUDE.local.md, AGENTS.md at any depth, or anything under a `.claude` directory (case-insensitive). Same rule as src/sandbox/instruction-paths.ts. */
export function isInstructionPath(/** @type {string} */ p) {
  return p.split("/").some((c) => INSTRUCTION_FILES.has(c.toLowerCase()) || c.toLowerCase() === ".claude");
}

/** Removes every instruction file and `.claude` directory under `root`; returns the removed paths relative to it. Symlinks are removed, never followed. */
export function removeInstructionFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const removed = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isInstructionPath(e.name)) { rmSync(join(root, r), { recursive: true, force: true }); removed.push(r); }
      else if (e.isDirectory()) walk(r);
    }
  };
  walk("");
  return removed.sort();
}

export const CLAUDE_LOGIN_EXPIRES = "Claude login expires soon; run claude once to refresh it";

/**
 * The access token of a Claude login (the `claudeAiOauth` entry of its `.credentials.json`), only when it is still
 * valid 10 minutes after the call's timeout: the sandboxed claude gets it as CLAUDE_CODE_OAUTH_TOKEN and can't refresh it.
 * @param {any} creds @param {number} timeoutSeconds @param {number} [now]
 * @returns {{ token: string } | { problem: string }}
 */
export function claudeLoginToken(creds, timeoutSeconds, now = Date.now()) {
  const o = creds?.claudeAiOauth;
  if (typeof o?.accessToken !== "string" || !o.accessToken || typeof o.expiresAt !== "number") return { problem: "no Claude login in the configured directory; run claude and log in" };
  if (o.expiresAt <= now + (timeoutSeconds + 600) * 1000) return { problem: CLAUDE_LOGIN_EXPIRES };
  return { token: o.accessToken };
}

/** Why `--config-dir` does not apply on macOS. */
const CLAUDE_CONFIG_DIR_MACOS = "on macOS Claude Code keeps its login in the Keychain, not in a config directory: use `autocraft-task harness claude --keychain`, or store a setup-token";

/**
 * The Claude login the config names, in the `.credentials.json` shape: the Keychain item on macOS with `claudeAuth`
 * "keychain", the config directory's file elsewhere; null for a setup-token or no login.
 * @param {Config} cfg @returns {any}
 */
function claudeCredential(cfg) {
  if (cfg.claudeAuth === "keychain") {
    const k = keychainCredential(keychainItemOf(cfg));
    return k ? { claudeAiOauth: { accessToken: k.token, expiresAt: k.expiresAt ?? Number.MAX_SAFE_INTEGER } } : null;
  }
  return cfg.claudeConfigDir && process.platform !== "darwin" ? readClaudeCredentials(cfg.claudeConfigDir) : null;
}

/** The arguments with the model replaced (`--model x` or `--model=x`), or added after `-p` when absent. */
export function withModel(/** @type {string[]} */ args, /** @type {string} */ model) {
  const out = [...args];
  const i = out.indexOf("--model");
  if (i >= 0 && i + 1 < out.length) { out[i + 1] = model; return out; }
  const j = out.findIndex((a) => a.startsWith("--model="));
  if (j >= 0) { out[j] = `--model=${model}`; return out; }
  const p = out.indexOf("-p");
  out.splice(p + 1, 0, "--model", model);
  return out;
}

/** The arguments without any `--resume <id>`. */
export function withoutResume(/** @type {string[]} */ args) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") { i++; continue; }
    if (args[i].startsWith("--resume=")) continue;
    out.push(args[i]);
  }
  return out;
}

/** @param {string} m */
const family = (m) => /haiku/i.test(m) ? "haiku" : /sonnet/i.test(m) ? "sonnet" : /opus/i.test(m) ? "opus" : m;

/** @param {string} stdout @returns {any[]} */
function events(stdout) {
  try {
    const j = JSON.parse(stdout);
    return Array.isArray(j) ? j : [j];
  } catch {
    return stdout.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
}

/**
 * Reads `claude -p` output (stream-json, or the json event list): the result text, the called model's usage
 * (cache tokens included; with `modelUsage` only the requested model's family, so explorer subagent tokens
 * are left out), the model id it reported, the session id and the turns. Same reading as src/classify/run.ts.
 * @param {string} stdout @param {string} model the requested model or alias
 * @returns {Reply}
 */
export function parseClaudeOutput(stdout, model) {
  const evs = events(stdout);
  const result = evs.findLast((e) => e && e.type === "result");
  const init = evs.find((e) => e && e.type === "system" && typeof e.model === "string");
  const sessionId = [result, ...evs].find((e) => e && typeof e.session_id === "string")?.session_id;
  /** @type {[string, any][]} */
  const per = Object.entries(result?.modelUsage ?? {});
  const mine = per.filter(([m]) => family(m) === family(model));
  const reported = (mine.length ? mine : per).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]?.[0] ?? init?.model ?? model;
  /** @type {Usage | undefined} */
  let usage;
  if (mine.length) {
    usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const [, x] of mine) {
      usage.inputTokens += x.inputTokens ?? 0; usage.outputTokens += x.outputTokens ?? 0;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (x.cacheReadInputTokens ?? 0); usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (x.cacheCreationInputTokens ?? 0);
    }
  } else if (result?.usage) {
    const u = result.usage;
    usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
  } else {
    // No result (killed or timed out): the tokens of the assistant messages seen so far, each message once.
    const seen = new Map();
    for (const e of evs) if (e?.type === "assistant" && e.message?.usage) seen.set(e.message.id ?? `#${seen.size}`, e.message.usage);
    if (seen.size) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const u of seen.values()) {
        usage.inputTokens += u.input_tokens ?? 0; usage.outputTokens += u.output_tokens ?? 0;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0); usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
  }
  /** @type {Record<string, Usage>} */
  const modelUsage = Object.fromEntries(per.map(([m, x]) => [m, { inputTokens: x.inputTokens ?? 0, outputTokens: x.outputTokens ?? 0, cacheReadTokens: x.cacheReadInputTokens ?? 0, cacheWriteTokens: x.cacheCreationInputTokens ?? 0 }]));
  const base = { model: reported, usage, ...(per.length > 0 && { modelUsage }), ...(typeof result?.total_cost_usd === "number" && { costUsd: result.total_cost_usd }),
    ...(typeof result?.num_turns === "number" && { turns: result.num_turns }), ...(sessionId && { sessionId }) };
  if (!result) return { ok: false, text: "", ...base, error: evs.length ? "no result" : "unreadable output" };
  if (result.subtype === "error_max_turns") return { ok: false, text: "", ...base, error: "turn limit: the model used every turn the prompt allows without an answer" };
  if (result.is_error || typeof result.result !== "string") return { ok: false, text: "", ...base, error: `model error ${typeof result.result === "string" ? result.result : ""}`.trim().slice(0, 400) };
  return { ok: true, text: result.result, ...base };
}

const TOOL_ARGS_MAX = 4000;
const MAX_TOOLS = 1000;

/** Bytes of a tool result: text blocks by their text, anything else as JSON (as src/agents/tools.ts counts them). @param {unknown} c */
const resultSize = (c) => {
  if (typeof c === "string") return Buffer.byteLength(c);
  if (Array.isArray(c)) return c.reduce((n, b) => n + (typeof b?.text === "string" ? Buffer.byteLength(b.text) : Buffer.byteLength(JSON.stringify(b ?? null))), 0);
  return c === undefined || c === null ? 0 : Buffer.byteLength(JSON.stringify(c));
};

/** A tool's input as stored: JSON, secrets redacted, capped. @param {unknown} input */
const toolArgs = (input) => redact(JSON.stringify(input ?? null) ?? "null").slice(0, TOOL_ARGS_MAX);

/**
 * The tool uses of `claude -p` stream-json output, in order and paired with their results by id, subagents included:
 * the same reading as src/agents/tools.ts `toolUses`. `stamps[i]` is the arrival time of output line i.
 * @param {string} stdout @param {string[]} [stamps]
 * @returns {SubmitTool[]}
 */
export function claudeTools(stdout, stamps = []) {
  /** @type {Map<string, SubmitTool>} */
  const byId = new Map();
  stdout.split("\n").forEach((line, i) => {
    if (!line.startsWith("{") || !line.includes("tool_")) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!Array.isArray(e?.message?.content)) return;
    const at = stamps[i];
    for (const b of e.message.content) {
      if (e.type === "assistant" && b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" && byId.size < MAX_TOOLS) {
        byId.set(b.id, { name: b.name.slice(0, 100), args: toolArgs(b.input), resultBytes: null, isError: false, ...(at && { startedAt: at }) });
      } else if (e.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const u = byId.get(b.tool_use_id);
        if (u) { u.resultBytes = resultSize(b.content); u.isError = b.is_error === true; if (at) u.endedAt = at; }
      }
    }
  });
  return [...byId.values()];
}

/** @param {unknown} v @param {number} [n] */
const clean = (v, n = 80) => {
  const t = (typeof v === "string" ? v : "").replace(/[^\P{C}]|\s+/gu, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** @param {unknown} p */
const rel = (p) => { const s = clean(p, 200); for (const r of ["/repo/", "/repos/"]) if (s.startsWith(r)) return s.slice(r.length); return s; };
/** @param {Record<string, unknown>} i */
const itemRef = (i) => `${clean(i.repo, 40)}#${typeof i.number === "number" ? i.number : clean(i.number, 10)}`;

/** The progress line for one tool call, or null; same wording as src/classify/progress.ts. @param {string} name @param {unknown} input */
export function toolLine(name, input) {
  const i = /** @type {Record<string, unknown>} */ (input && typeof input === "object" ? input : {});
  if (["Read", "Grep", "Glob"].includes(name) && [i.file_path, i.path, i.pattern].some((v) => typeof v === "string" && v.includes("/reference"))) return "Checking reference documentation";
  switch (name) {
    case "Read": return `Reading ${rel(i.file_path)}`;
    case "Grep": return `Searching for "${clean(i.pattern, 50)}"${i.path ? ` in ${rel(i.path)}` : ""}`;
    case "Glob": return `Listing ${clean(i.pattern, 60)}${i.path ? ` in ${rel(i.path)}` : ""}`;
    case "Agent": return `Asking the explorer: ${clean(i.description, 80)}`;
    case "mcp__items__item": return `Looking up ${itemRef(i)}`;
    case "mcp__items__similar_items": return `Looking for items similar to ${itemRef(i)}`;
    case "mcp__items__search_items": return `Searching items for "${clean(i.query, 50)}"`;
    case "mcp__items__pr_diff": return `Reading the diff of ${itemRef(i)}`;
    default: return null;
  }
}

/** The last progress line of one stream-json output line, or null. @param {string} raw */
export function claudeProgress(raw) {
  if (!raw.startsWith("{")) return null;
  try {
    const e = JSON.parse(raw);
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return null;
    const prefix = typeof e.parent_tool_use_id === "string" ? "Explorer: " : "";
    let last = null;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const l = toolLine(b.name, b.input);
      if (l) last = (prefix + l).slice(0, 120);
    }
    return last;
  } catch { return null; }
}

const MOUNT_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;
/** Paths the sandbox itself uses; a bundle mount may not sit on or under them. */
const FIXED_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/etc", "/proc", "/dev", "/tmp", "/home", "/work", "/opt", "/mcp.json", "/agents.json", "/codex-home"];

/** Throws unless `p` is a safe absolute mount point inside the sandbox. @param {string} p */
export function checkMountPath(p) {
  if (!MOUNT_PATH.test(p) || p.split("/").some((c) => c === "..") || p === "/" || FIXED_PATHS.some((f) => p === f || p.startsWith(`${f}/`))) throw new Error(`unsafe mount path: ${p}`);
  return p;
}

const SANDBOX_HOME = "/home/sandbox";
const SANDBOX_CONFIG = `${SANDBOX_HOME}/.claude`;
const SANDBOX_CLAUDE = "/opt/claude/claude";
const WORK_PATH = "/work";
export const BWRAP = "/usr/bin/bwrap";

/**
 * The bwrap command for `claude`, the same sandbox as src/sandbox/command.ts `sandboxCommand`: fixed
 * paths, empty home, the binary read-only, every mount read-only, network shared, everything else a new
 * namespace. `env` is the process's whole environment; the token is only there, never in `args`.
 * Every `--add-dir` the arguments name exists, empty when nothing is mounted there.
 * @param {{ claudeBin: string, oauthToken?: string, claudeArgs: string[], mounts: { host: string, path: string }[], agentsFile?: string, mcpFile?: string, sessionDir?: string }} s
 */
export function claudeSandbox(s) {
  const mounts = s.mounts.map((m) => ({ host: m.host, path: checkMountPath(m.path) }));
  const addDirs = s.claudeArgs.flatMap((a, i) => (a === "--add-dir" && s.claudeArgs[i + 1] ? [s.claudeArgs[i + 1]] : []));
  const empty = addDirs.filter((d) => !mounts.some((m) => m.path === d)).map(checkMountPath);
  // Parents of nested mounts (`/repos` for `/repos/<name>`) exist even when the arguments do not name them.
  const parents = [...new Set(mounts.map((m) => dirname(m.path)).filter((d) => d !== "/" && !mounts.some((m) => m.path === d)))];
  const env = { HOME: SANDBOX_HOME, CLAUDE_CONFIG_DIR: SANDBOX_CONFIG, PATH: "/usr/bin", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1" };
  const repo = mounts.filter((m) => m.path === "/repo"), rest = mounts.filter((m) => m.path !== "/repo");
  const args = [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
    "--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--tmpfs", SANDBOX_HOME, "--tmpfs", SANDBOX_CONFIG,
    ...(s.sessionDir ? ["--bind", s.sessionDir, `${SANDBOX_CONFIG}/projects`] : []),
    "--ro-bind", s.claudeBin, SANDBOX_CLAUDE,
    "--tmpfs", WORK_PATH,
    ...repo.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...[...new Set([...empty, ...parents])].flatMap((d) => ["--dir", d]),
    ...rest.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...(s.agentsFile ? ["--ro-bind", s.agentsFile, "/agents.json"] : []),
    ...(s.mcpFile ? ["--ro-bind", s.mcpFile, "/mcp.json"] : []),
    "--chdir", WORK_PATH,
    SANDBOX_CLAUDE, ...s.claudeArgs,
  ];
  return { cmd: BWRAP, args, env: { ...env, ...(s.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: s.oauthToken } : {}) } };
}

/** The MCP config for the lease's servers: each a streamable HTTP server on our dashboard, authorized by the lease secret. */
export function mcpConfig(/** @type {string} */ server, /** @type {string[]} */ names, /** @type {string} */ secret) {
  return { mcpServers: Object.fromEntries(names.map((n) => [n, { type: "http", url: `${server}${ROUTES.mcp}/${n}`, headers: { Authorization: `Bearer ${secret}` } }])) };
}

/** Negative when version `a` is older than `b` (dotted numbers). */
export function compareVersions(/** @type {string} */ a, /** @type {string} */ b) {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0), pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** @param {Usage | undefined} u */
const tokensOf = (u) => (u ? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0);
/** @param {number} n */
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// ---------------------------------------------------------------------------
// The Claude Code adapter.

/** @param {Config} cfg */
function resolveClaudeBin(cfg) {
  const given = process.env.AUTOCRAFT_TASK_CLAUDE_BIN || cfg.claudeBin;
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude"));
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return realpathSync(c); } catch { /* next */ }
  }
  return null;
}

/** @param {string[]} args @param {string} sessionId */
const claudeResume = (args, sessionId) => [...withoutResume(args), "--resume", sessionId];

/** @type {Adapter} */
const claudeAdapter = {
  id: "claude",
  token: (cfg) => claudeCredential(cfg)?.claudeAiOauth?.accessToken ?? (cfg.claudeConfigDir || cfg.claudeAuth === "keychain" ? undefined : cfg.claudeToken),
  tokenFor(cfg, timeoutSeconds) {
    if (process.platform === "darwin" && cfg.claudeConfigDir) return { problem: CLAUDE_CONFIG_DIR_MACOS };
    if (cfg.claudeAuth === "keychain") {
      const creds = claudeCredential(cfg);
      return creds ? claudeLoginToken(creds, timeoutSeconds) : { problem: "no Claude Code login in the Keychain: sign in to Claude Code, or store a setup-token" };
    }
    if (!cfg.claudeConfigDir) return cfg.claudeToken ? { token: cfg.claudeToken } : { problem: "no Claude token stored" };
    return claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), timeoutSeconds);
  },
  defaultTiers: { top: "opus", mid: "sonnet", small: "haiku" },
  maxEffort: "max",
  detect(cfg) {
    const bin = resolveClaudeBin(cfg);
    let version = null;
    if (bin) {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), DISABLE_AUTOUPDATER: "1" } });
      version = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] || null) : null;
    }
    return { bin, version, loggedIn: !!this.token(cfg) };
  },
  command(t) {
    const hint = t.bundle.hints.claude;
    if (!hint) throw new Error("the bundle has no claude arguments");
    let args = withoutResume(withModel(hint.args, t.model));
    if (t.resumeId) args = claudeResume(args, t.resumeId);
    // macOS: the session store is the whole config directory (a resume finds its session there); otherwise one under tmp/.
    if (t.mac) return macCommand({ profile: t.mac.profile, root: t.mac.root, argv: [...t.mac.install.argv, ...args], env: { CLAUDE_CONFIG_DIR: t.sessionDir ?? `${t.mac.root}/tmp/home/.claude`, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_OAUTH_TOKEN: t.token } });
    const agentsFile = hint.agents !== undefined ? join(t.taskDir, "agents.json") : undefined;
    if (agentsFile) writeFileSync(agentsFile, hint.agents ?? "", { mode: 0o600 });
    return claudeSandbox({ claudeBin: t.bin, oauthToken: t.token, claudeArgs: args, mounts: t.mounts, agentsFile, mcpFile: t.mcpFile || undefined, sessionDir: t.sessionDir });
  },
  parse: parseClaudeOutput,
  tools: claudeTools,
  resume: (args, sessionId) => claudeResume(args, sessionId),
  progress: claudeProgress,
  versionInSandbox: (bin) => claudeSandbox({ claudeBin: bin, claudeArgs: ["--version"], mounts: [] }),
  install: (bin) => macInstall(bin, nodeOnPath()),
};

// ---------------------------------------------------------------------------
// Read-only file tools, for a harness whose own read tool can't be confined to the task (Codex: its shell would see
// everything in the sandbox, its login included). The helper process serves them to that one run as a streamable
// HTTP MCP server on 127.0.0.1 with a per-run bearer token. Paths are sandbox paths (/repo/..., /repos/<name>/...);
// each resolves inside one prepared mount and never past it: symlinks are resolved and checked, and grep walks
// without following them.

const FILE_TOOLS_SERVER = "files";
const READ_LINES = 2000;
const READ_MAX_BYTES = 256 * 1024;
const GREP_MAX_LINES = 200;
const GLOB_MAX = 500;
const LINE_MAX = 300;

const FILE_TOOLS = [
  { name: "read_file", description: "Reads a text file: numbered lines, at most 2000 from `offset` (1-based).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path of a file in a directory the prompt names" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: READ_LINES } }, required: ["path"] } },
  { name: "grep", description: "Searches files under a directory for an extended regular expression; prints path:line:text, at most 200 lines.", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory or file; default the repository" }, glob: { type: "string", description: "Only file names matching this, e.g. *.rs" }, ignore_case: { type: "boolean" } }, required: ["pattern"] } },
  { name: "glob", description: "Lists files whose path below `path` matches a glob (** any depth, * and ? within a name), at most 500.", inputSchema: { type: "object", properties: { pattern: { type: "string", description: "e.g. **/*.rs" }, path: { type: "string", description: "Directory; default the repository" } }, required: ["pattern"] } },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

/**
 * The host path of a sandbox path inside one of the mounts, symlinks resolved; throws when the path is outside every
 * mount or resolves outside its mount.
 * @param {{ host: string, path: string }[]} mounts @param {unknown} p
 */
export function hostPath(mounts, p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new Error("path must be an absolute path such as /repo/src/main.rs");
  const parts = p.split("/").filter((c) => c && c !== ".");
  if (parts.includes("..")) throw new Error("path may not contain ..");
  const norm = `/${parts.join("/")}`;
  const m = [...mounts].sort((a, b) => b.path.length - a.path.length).find((x) => norm === x.path || norm.startsWith(`${x.path}/`));
  if (!m) throw new Error(`no such path: ${norm} (readable: ${mounts.map((x) => x.path).join(", ")})`);
  const root = realpathSync(m.host);
  let real;
  try { real = realpathSync(join(m.host, norm.slice(m.path.length))); } catch { throw new Error(`no such file: ${norm}`); }
  if (real !== root && !real.startsWith(`${root}/`)) throw new Error(`${norm} points outside ${m.path}`);
  return { real, root, mount: m };
}

/** A glob over `/`-separated relative paths as a RegExp: `**` any depth, `*` and `?` within one name. @param {string} g */
export function globRegex(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Files below `dir` (relative paths), not following symlinks, at most `max`. @param {string} dir @param {number} max */
function walkFiles(dir, max) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    if (out.length >= max) return;
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== ".git") walk(r); }
      else if (e.isFile()) out.push(r);
      if (out.length >= max) return;
    }
  };
  walk("");
  return out;
}

/** The item's checkout, where a search without a path looks: /repo, or <root>/repo on macOS. @param {{ path: string }[]} mounts */
const defaultPath = (mounts) => mounts.map((m) => m.path).filter((p) => p === "/repo" || p.endsWith("/repo")).sort((a, b) => a.length - b.length)[0] ?? "/repo";

/** The sandbox path of a host path below a mount. @param {{ path: string }} mount @param {string} root @param {string} host */
const sandboxPathOf = (mount, root, host) => (host === root ? mount.path : `${mount.path}${host.slice(root.length)}`);

/**
 * Runs one file tool; the text it returns, or throws with a message for the model.
 * @param {{ host: string, path: string }[]} mounts @param {string} name @param {Record<string, unknown>} a
 */
export function runFileTool(mounts, name, a) {
  const cut = (/** @type {string} */ l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l);
  if (name === "read_file") {
    const { real } = hostPath(mounts, a.path);
    if (!statSync(real).isFile()) throw new Error(`${a.path} is not a file`);
    const buf = readFileSync(real);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${a.path} is a binary file`);
    const lines = buf.subarray(0, READ_MAX_BYTES * 8).toString("utf8").split("\n");
    const from = Math.max(1, Number.isInteger(a.offset) ? Number(a.offset) : 1), n = Math.min(READ_LINES, Number.isInteger(a.limit) ? Number(a.limit) : READ_LINES);
    let out = "", i = from;
    for (; i < from + n && i <= lines.length; i++) {
      const l = `${String(i).padStart(6)}\t${cut(lines[i - 1] ?? "")}\n`;
      if (out.length + l.length > READ_MAX_BYTES) break;
      out += l;
    }
    return out + (i <= lines.length ? `(${lines.length} lines; continue with offset ${i})\n` : "");
  }
  if (name === "glob") {
    if (typeof a.pattern !== "string" || !a.pattern) throw new Error("pattern is required");
    const { real, root, mount } = hostPath(mounts, a.path ?? defaultPath(mounts));
    const re = globRegex(a.pattern);
    const base = sandboxPathOf(mount, root, real);
    const hits = walkFiles(real, 50_000).filter((r) => re.test(r));
    return hits.length ? hits.slice(0, GLOB_MAX).map((r) => `${base}/${r}`).join("\n") + (hits.length > GLOB_MAX ? `\n(${hits.length} files; narrow the pattern)` : "") : "no files match";
  }
  if (name === "grep") {
    if (typeof a.pattern !== "string" || !a.pattern) throw new Error("pattern is required");
    const { real, root, mount } = hostPath(mounts, a.path ?? defaultPath(mounts));
    const args = ["-rnIE", "--exclude-dir=.git", ...(a.ignore_case === true ? ["-i"] : []), ...(typeof a.glob === "string" && a.glob ? [`--include=${a.glob}`] : []), "-e", a.pattern, "--", real];
    const r = spawnSync("grep", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" } });
    if (r.error) throw new Error(`grep failed: ${r.error.message.includes("ETIMEDOUT") ? "timed out" : r.error.message}`);
    if (r.status === 2) throw new Error(`grep: ${(r.stderr ?? "").replaceAll(root, mount.path).trim().slice(0, 300)}`);
    const lines = (r.stdout ?? "").split("\n").filter(Boolean);
    if (!lines.length) return "no matches";
    const shown = lines.slice(0, GREP_MAX_LINES).map((l) => cut(l.startsWith(root) ? sandboxPathOf(mount, root, l.slice(0, root.length)) + l.slice(root.length) : l));
    return shown.join("\n") + (lines.length > GREP_MAX_LINES ? `\n(${lines.length} matching lines; narrow the pattern or path)` : "");
  }
  throw new Error(`unknown tool ${name}`);
}

/**
 * One JSON-RPC message to the file tools' MCP server: the reply, or null for a notification.
 * @param {{ host: string, path: string }[]} mounts @param {any} m
 */
export function fileToolsMessage(mounts, m) {
  if (!m || typeof m !== "object" || typeof m.method !== "string") return m?.id !== undefined ? { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "invalid request" } } : null;
  if (m.id === undefined) return null;
  const ok = (/** @type {unknown} */ result) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: FILE_TOOLS_SERVER, version: HELPER_VERSION } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: FILE_TOOLS });
    case "tools/call": {
      const name = m.params?.name, args = m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {};
      try { return ok({ content: [{ type: "text", text: runFileTool(mounts, String(name), args) }] }); }
      catch (e) { return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true }); }
    }
    default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method ${m.method} not found` } };
  }
}

/**
 * Serves the file tools for one run on 127.0.0.1; `close` stops it.
 * @param {{ host: string, path: string }[]} mounts @returns {Promise<{ url: string, token: string, close: () => void }>}
 */
function serveFileTools(mounts) {
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== want.length || !timingSafeEqual(auth, want)) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const replies = (Array.isArray(m) ? m : [m]).map((x) => fileToolsMessage(mounts, x)).filter((x) => x !== null);
      if (!replies.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(m) ? replies : replies[0]));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = a && typeof a === "object" ? a.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// The Codex adapter. What it relies on, from the Codex CLI source at tag rust-v0.170.0
// (github.com/openai/codex, paths under codex-rs/) and its docs (non-interactive mode, auth):
// - `codex exec` flags --json, --color, --skip-git-repo-check, --ignore-user-config, --ignore-rules, --ephemeral, -C, the
//   prompt from stdin with `-`, and `exec resume <id>` taking the same flags: exec/src/cli.rs. Exec always runs with the
//   approval policy "never": exec/src/lib.rs. A resume id that matches no thread starts a new one, so only the thread
//   UUID the first run reported is passed.
// - JSONL events thread.started {thread_id}, item.started/item.completed {item: agent_message | mcp_tool_call | error |
//   ...}, turn.completed {usage}, turn.failed {error}, error: exec/src/exec_events.rs. Usage is the thread total;
//   input_tokens includes cached_input_tokens and output_tokens includes reasoning: exec/src/event_processor_with_jsonl_output.rs,
//   protocol/src/protocol.rs (TokenUsage). No event names the model except an error item "model rerouted: A -> B (...)",
//   so the reply reports the configured model, or the model it was rerouted to.
// - `-c key=value` values are TOML (utils/cli/src/config_override.rs) and keys split at every "." (config/src/overrides.rs):
//   tables go in as inline tables. Keys used: model, model_reasoning_effort (protocol/src/openai_models.rs),
//   developer_instructions, project_doc_max_bytes, web_search, agents, features, cli_auth_credentials_store,
//   shell_environment_policy, default_permissions, permissions, mcp_servers: config/src/config_toml.rs, features/src/lib.rs.
// - MCP: streamable HTTP servers with url and bearer_token_env_var (an inline bearer_token is refused);
//   default_tools_approval_mode = "approve" lets exec call their tools under approval "never": config/src/mcp_types.rs,
//   core/src/mcp_tool_call.rs. The model sees them as mcp__<server>__<tool>: codex-mcp/src/tools.rs.
// - The credential. Codex's own sandbox does not keep the model's shell commands away from CODEX_HOME on Linux:
//   read-only mode grants read on the whole root (protocol/src/permissions.rs:597-604, read_only_file_system_entries),
//   Codex adds CODEX_HOME to the sandbox policy only on Windows (sandboxing/src/manager.rs:726-760), and nothing in
//   linux-sandbox/src names CODEX_HOME or auth.json. A permission profile with a "deny" entry would mask it, but when
//   Codex cannot mount a fresh /proc it silently keeps the outer one (linux-sandbox/src/linux_run_main.rs:395-415,
//   run_bwrap_with_proc_fallback), and /proc/<codex pid>/root then reaches CODEX_HOME past the entry. So the shell is
//   turned off (features shell_tool and unified_exec: core/src/tools/spec_plan.rs:1289-1296, add_shell_tools), with the
//   other built-in tools that act outside the task (browser, computer use, apps, plugins, hooks, image generation,
//   subagents, web search), and the model reads through the helper's file tools above, which the codex process reaches
//   over HTTP. What is left reads through Codex's sandbox (view_image: core/src/tools/handlers/view_image.rs), which a
//   permission profile extending ":read-only" (no writes, no network: protocol/src/models.rs:494-500) with CODEX_HOME
//   denied confines: config/src/permissions_toml.rs:113-119, exec/tests/suite/seatbelt.rs:305-311. `--sandbox` is never
//   passed, as it would replace the profile (config/src/permission_config.rs:46-48). shell_environment_policy sets the
//   whole environment of any command (protocol/src/shell_environment.rs, populate_env), so no secret from the codex
//   process's environment reaches one.
// - The login. A separate CODEX_HOME is a separate login with its own refresh token. Refresh tokens rotate with reuse
//   detection, Codex writes the new tokens back to auth.json, and two processes refreshing one auth.json race
//   (login/src/auth/manager.rs, login/src/auth/storage.rs). So the helper keeps its own CODEX_HOME (`harness codex` runs
//   `codex login` in it), binds it writable, never copies the user's ~/.codex, and runs one Codex call at a time.
// - Instructions and config. $CODEX_HOME/AGENTS.md (or AGENTS.override.md) and $CODEX_HOME/.env are read even with
//   --ignore-user-config (codex-home/src/instructions/mod.rs, arg0/src/lib.rs), so the helper removes them, and any config.toml, from its home;
//   project_doc_max_bytes = 0 turns off AGENTS.md from the working directory (core/src/agents_md.rs); /etc/codex is not
//   in the sandbox.
// - Audited versions only. The confinement above rests on the built-in tools of the versions in CODEX_AUDITED; earlier
//   versions had model-gated file tools (read_file, list_dir, grep_files) that read in the codex process. In 0.170
//   no such handler exists (core/src/tools/handlers/), and experimental_supported_tools, which comes with the model
//   catalogue and can't be set by -c, gates only web search's literature search (ext/web-search/src/extension.rs:157-161).
//   Any other version is refused, and every run is checked twice: the --json stream stops the run at the first tool
//   item other than an MCP call to the call's own servers; it does not show every tool (view_image, dynamic and
//   extension tools map to nothing: exec/src/event_processor_with_jsonl_output.rs:144-324), so after the run the
//   thread's rollout ($CODEX_HOME/sessions/.../rollout-*-<thread>.jsonl, every model tool call as a response_item:
//   history/src/rollout_payload.rs, protocol/src/models.rs ResponseItem) must hold no call but those MCP tools and
//   view_image. A missing rollout fails the call too. Either way the reply is not submitted.
// - view_image stays: with a profile that lacks full read access its reads go through Codex's sandboxed filesystem
//   helper (exec-server/src/local_file_system.rs:91, file-system/src/lib.rs:395), and bytes that are not an image are
//   refused before they reach the model (core/src/tools/handlers/view_image.rs:178), so even the /proc fallback above
//   cannot turn it into a text reader.
// Codex has no turn limit: the bundle's wall-clock limit bounds the call.

const SANDBOX_CODEX = "/opt/codex/codex";
const CODEX_HOME_PATH = "/codex-home";
const CODEX_PROFILE = "autocraft";
const LEASE_ENV = "AUTOCRAFT_TASK_LEASE_SECRET";
const FILES_ENV = "AUTOCRAFT_TASK_FILES_TOKEN";
/** Files Codex reads from CODEX_HOME whatever the flags say. */
const CODEX_HOME_INSTRUCTIONS = ["AGENTS.md", "AGENTS.override.md", ".env", "config.toml"];
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Codex versions (major.minor) whose built-in tools were audited for the confinement above. */
export const CODEX_AUDITED = ["0.170"];
/** Rollout item types that are model tool calls (protocol/src/models.rs ResponseItem). */
const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "tool_search_call", "web_search_call", "image_generation_call"]);

/** Why a Codex version may not run calls, or null. @param {string} version */
export function codexUnaudited(version) {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  if (m && CODEX_AUDITED.includes(`${Number(m[1])}.${Number(m[2])}`)) return null;
  return `codex ${version} is not a version this helper has audited (${CODEX_AUDITED.map((v) => `${v}.x`).join(", ")}): its built-in tools may read past the task's files. Install an audited version or update the helper.`;
}

/** The MCP servers a Codex call may call: the helper's file tools and the bundle's. @param {string[]} servers */
const allowedServers = (servers) => new Set([FILE_TOOLS_SERVER, ...servers]);

/** A `codex exec --json` line that shows a tool the call may not use: the reason, or null. @param {string} raw @param {string[]} servers */
export function codexStreamProblem(raw, servers) {
  if (!raw.startsWith("{")) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!["item.started", "item.updated", "item.completed"].includes(e?.type)) return null;
  const i = e.item ?? {};
  if (["agent_message", "reasoning", "error"].includes(i.type)) return null;
  if (i.type === "mcp_tool_call" && allowedServers(servers).has(i.server)) return null;
  return `unexpected tool: ${clean(i.type === "mcp_tool_call" ? `MCP server ${i.server}` : i.type, 60)}`;
}

/** The tool name of a rollout call: namespace and name joined as the model saw it (core/src/tools/mod.rs flat_tool_name). @param {any} p */
const flatName = (p) => {
  const name = typeof p.name === "string" ? p.name : "", ns = typeof p.namespace === "string" ? p.namespace : "";
  return !ns ? name : ns.endsWith("__") ? `${ns}${name}` : `${ns}__${name}`;
};

/** A rollout's first tool call the call may not use: the reason, or null. @param {string} text @param {string[]} servers */
export function codexRolloutProblem(text, servers) {
  const ok = allowedServers(servers);
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.type === "response_item" ? e.payload : null;
    if (!p || !CODEX_CALLS.has(p.type)) continue;
    const name = p.type === "function_call" ? flatName(p) : "";
    const mcp = /^mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]+$/.exec(name);
    if (name === "view_image" || (mcp && ok.has(mcp[1]))) continue;
    return `unexpected tool: ${clean(name || p.type, 80)}`;
  }
  return null;
}

/** The helper's file tools as the item page names them for Claude: Read, Grep, Glob with Claude's argument names. @param {string} name @param {any} a */
function codexToolName(name, a) {
  if (name === `mcp__${FILE_TOOLS_SERVER}__read_file`) return { name: "Read", input: { file_path: a?.path } };
  if (name === `mcp__${FILE_TOOLS_SERVER}__grep`) return { name: "Grep", input: { pattern: a?.pattern, path: a?.path } };
  if (name === `mcp__${FILE_TOOLS_SERVER}__glob`) return { name: "Glob", input: { pattern: a?.pattern, path: a?.path } };
  return { name, input: a };
}

/**
 * The tool uses a Codex rollout records, in order and paired with their outputs by call id, timed by the rollout's
 * line timestamps. An MCP result's isError comes from its content.
 * @param {string} text
 * @returns {SubmitTool[]}
 */
export function codexRolloutTools(text) {
  /** @type {Map<string, SubmitTool>} */
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.type === "response_item" ? e.payload : null;
    if (!p || typeof p.call_id !== "string") continue;
    const at = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (CODEX_CALLS.has(p.type) && byId.size < MAX_TOOLS) {
      let a = p.arguments ?? p.input ?? p.action ?? null;
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { /* raw text input */ } }
      const t = codexToolName(p.type === "function_call" ? flatName(p) : p.type, a);
      byId.set(p.call_id, { name: t.name.slice(0, 100), args: toolArgs(t.input), resultBytes: null, isError: false, ...(at && { startedAt: at }) });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const u = byId.get(p.call_id);
      if (!u) continue;
      const out = p.output;
      let parsed = out;
      if (typeof out === "string") { try { parsed = JSON.parse(out); } catch { parsed = out; } }
      u.resultBytes = resultSize(typeof out === "string" ? out : out?.content ?? out);
      u.isError = parsed?.isError === true || parsed?.success === false || out?.success === false;
      if (at) u.endedAt = at;
    }
  }
  return [...byId.values()];
}

/** Files below `dir`, recursively (no symlinks followed). @param {string} dir @returns {string[]} */
function filesBelow(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesBelow(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}
/** Built-in Codex features turned off: the shell, and every tool that reaches past the task directory or the call's MCP servers. */
const CODEX_FEATURES_OFF = ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "apps", "plugins", "remote_plugin", "tool_suggest", "skill_search", "skill_mcp_dependency_install", "hooks", "image_generation", "multi_agent", "goals", "workspace_dependencies"];

/** A TOML basic string: JSON's escapes are TOML's, except that TOML also forbids a raw DEL. @param {string} v */
const toml = (v) => JSON.stringify(v).replace(/\u007f/g, "\\u007F");

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
/** The effort passed to a harness: `effort`, or the harness's highest level when that is lower. @param {string} effort @param {string} max */
export const harnessEffort = (effort, max) => (EFFORT_LADDER.indexOf(effort) > EFFORT_LADDER.indexOf(max) ? max : effort);

/**
 * `codex` arguments for one call: exec (or exec resume) reading the prompt on stdin, the model and effort, no shell,
 * the call's MCP servers on our dashboard and the helper's file tools (tokens from the environment), and none of the
 * user's config or instructions.
 * `paths`: where the run's working directory, home and Codex home are (macOS: in the slot and the helper's Codex home);
 * the bwrap paths by default.
 * @param {{ model: string, effort: string, system: string | null, server: string, servers: string[], files: string, keepSession: boolean, resumeId?: string, toolTimeoutSec: number, paths?: { work: string, home: string, codexHome: string } }} o
 */
export function codexArgs(o) {
  const paths = o.paths ?? { work: WORK_PATH, home: SANDBOX_HOME, codexHome: CODEX_HOME_PATH };
  if (o.resumeId !== undefined && !THREAD_ID.test(o.resumeId)) throw new Error(`not a Codex thread id: ${o.resumeId}`);
  const http = (/** @type {string} */ name, /** @type {string} */ url, /** @type {string} */ env, /** @type {number} */ timeout) =>
    `${name}={url=${toml(url)}, bearer_token_env_var="${env}", default_tools_approval_mode="approve", startup_timeout_sec=30, tool_timeout_sec=${timeout}}`;
  const mcp = o.servers.map((n) => {
    if (!NAME.test(n) || n.includes(".") || n === FILE_TOOLS_SERVER) throw new Error(`bad MCP server name ${n}`);
    return http(n, `${o.server}${ROUTES.mcp}/${n}`, LEASE_ENV, Math.max(60, Math.round(o.toolTimeoutSec)));
  });
  return ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", paths.work,
    "-c", `model=${toml(o.model)}`, "-c", `model_reasoning_effort=${toml(o.effort)}`,
    "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", "agents={enabled=false}", "-c", 'cli_auth_credentials_store="file"',
    "-c", `features={${CODEX_FEATURES_OFF.map((f) => `${f}=false`).join(", ")}}`,
    "-c", `shell_environment_policy={inherit="none", set={PATH="/usr/bin", HOME=${toml(paths.home)}, LANG="C.UTF-8"}}`,
    "-c", `default_permissions="${CODEX_PROFILE}"`,
    "-c", `permissions={${CODEX_PROFILE}={extends=":read-only", filesystem={${toml(paths.codexHome)}="deny"}}}`,
    "-c", `mcp_servers={${[http(FILE_TOOLS_SERVER, o.files, FILES_ENV, 60), ...mcp].join(", ")}}`,
    ...(o.system ? ["-c", `developer_instructions=${toml(o.system)}`] : []),
    ...(o.resumeId ? ["resume", o.resumeId] : []),
    "-"];
}

/**
 * The bwrap command for `codex`: the same outer sandbox as `claudeSandbox` (fixed paths, empty home, the binary
 * read-only, every mount read-only, network shared), with the helper's CODEX_HOME bound writable at /codex-home so
 * Codex can refresh its login and keep sessions. Tokens are only in `env`, never in `args`.
 * @param {{ codexBin: string, codexHome: string, codexArgs: string[], mounts: { host: string, path: string }[], env?: Record<string, string> }} s
 */
export function codexSandbox(s) {
  const mounts = s.mounts.map((m) => ({ host: m.host, path: checkMountPath(m.path) }));
  const parents = [...new Set(mounts.map((m) => dirname(m.path)).filter((d) => d !== "/" && !mounts.some((m) => m.path === d)))];
  const repo = mounts.filter((m) => m.path === "/repo"), rest = mounts.filter((m) => m.path !== "/repo");
  const args = [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
    "--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--tmpfs", SANDBOX_HOME,
    "--bind", s.codexHome, CODEX_HOME_PATH,
    "--ro-bind", s.codexBin, SANDBOX_CODEX,
    "--tmpfs", WORK_PATH,
    ...repo.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...parents.flatMap((d) => ["--dir", d]),
    ...rest.flatMap((m) => ["--ro-bind", m.host, m.path]),
    "--chdir", WORK_PATH,
    SANDBOX_CODEX, ...s.codexArgs,
  ];
  return { cmd: BWRAP, args, env: { HOME: SANDBOX_HOME, CODEX_HOME: CODEX_HOME_PATH, PATH: "/usr/bin", LANG: "C.UTF-8", ...s.env } };
}

/** @param {unknown} u @returns {Usage | undefined} */
function codexUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  const x = /** @type {Record<string, unknown>} */ (u);
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const cached = n(x.cached_input_tokens);
  return { inputTokens: Math.max(0, n(x.input_tokens) - cached), outputTokens: n(x.output_tokens), cacheReadTokens: cached, cacheWriteTokens: n(x.cache_write_input_tokens) };
}

/**
 * Reads `codex exec --json` output: the last agent message of the completed turn, the usage it reported, the thread
 * id for a resume, the tool calls as turns, and the model (the configured one, or the one a reroute named).
 * @param {string} stdout @param {string} model the configured model
 * @returns {Reply}
 */
export function parseCodexOutput(stdout, model) {
  /** @type {any[]} */
  const evs = stdout.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const sessionId = evs.find((e) => e?.type === "thread.started" && typeof e.thread_id === "string")?.thread_id;
  const items = evs.filter((e) => e?.type === "item.completed" && e.item && typeof e.item === "object").map((e) => e.item);
  const rerouted = items.map((i) => (i.type === "error" && typeof i.message === "string" ? /^model rerouted: \S+ -> (\S+)/.exec(i.message)?.[1] : undefined)).filter(Boolean).at(-1);
  const done = evs.findLast((e) => e?.type === "turn.completed");
  const failed = evs.findLast((e) => e?.type === "turn.failed" || e?.type === "error");
  const base = { model: rerouted ?? model, usage: codexUsage(done?.usage), ...(sessionId && { sessionId }) };
  if (!done) {
    const why = typeof failed?.error?.message === "string" ? failed.error.message : typeof failed?.message === "string" ? failed.message : "";
    return { ok: false, text: "", ...base, error: failed ? `model error ${why}`.trim().slice(0, 400) : evs.length ? "no result" : "unreadable output" };
  }
  const text = items.findLast((i) => i.type === "agent_message" && typeof i.text === "string")?.text;
  if (text === undefined) return { ok: false, text: "", ...base, error: "no reply message" };
  return { ok: true, text, ...base, turns: items.filter((i) => i.type === "mcp_tool_call").length + 1 };
}

/** The progress line of one `codex exec --json` line, or null. @param {string} raw */
export function codexProgress(raw) {
  if (!raw.startsWith("{")) return null;
  try {
    const e = JSON.parse(raw);
    const i = e.type === "item.started" ? e.item : null;
    if (i?.type !== "mcp_tool_call" || typeof i.server !== "string" || typeof i.tool !== "string") return null;
    const a = i.arguments && typeof i.arguments === "object" ? i.arguments : {};
    if (i.server === FILE_TOOLS_SERVER) {
      if (i.tool === "read_file") return toolLine("Read", { file_path: a.path });
      if (i.tool === "grep") return toolLine("Grep", { pattern: a.pattern, path: a.path });
      if (i.tool === "glob") return toolLine("Glob", { pattern: a.pattern, path: a.path });
    }
    return toolLine(`mcp__${i.server}__${i.tool}`, a);
  } catch { return null; }
}

/** The native codex binary: given, or `codex` on PATH; the npm package's launcher script is followed to its vendored binary. @param {Config} cfg */
function resolveCodexBin(cfg) {
  const given = process.env.AUTOCRAFT_TASK_CODEX_BIN || cfg.codexBin;
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "codex"));
  const mac = process.platform === "darwin";
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${mac ? "apple-darwin" : "unknown-linux-musl"}`;
  const pkgArch = `${mac ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  for (const c of candidates) {
    let p;
    try { accessSync(c, constants.X_OK); p = realpathSync(c); } catch { continue; }
    if (!isScript(p)) return p;
    // npm: <pkg>/bin/codex.js runs <platform pkg>/vendor/<triple>/bin/codex, or <pkg>/vendor/<triple>/bin/codex.
    const pkg = dirname(dirname(p));
    for (const v of [join(pkg, "node_modules", "@openai", `codex-${pkgArch}`, "vendor"), join(dirname(pkg), `codex-${pkgArch}`, "vendor"), join(pkg, "vendor")]) {
      const bin = join(v, triple, "bin", "codex");
      try { accessSync(bin, constants.X_OK); return realpathSync(bin); } catch { /* next */ }
    }
  }
  return null;
}

/** The helper's own Codex login and sessions: never the user's ~/.codex. */
const codexHome = () => join(configDir(), "codex-home");

/** @type {Adapter} */
const codexAdapter = {
  id: "codex",
  token: () => (existsSync(join(codexHome(), "auth.json")) ? codexHome() : undefined),
  // Codex model ids change often and the operators accept them by name: every tier's model comes from the config.
  defaultTiers: {},
  maxEffort: "xhigh",
  exclusive: true,
  fileTools: true,
  unaudited: codexUnaudited,
  guard: codexStreamProblem,
  verify({ token, sessionId, servers, keep }) {
    if (!sessionId || !THREAD_ID.test(sessionId)) return { problem: "unexpected tool: no thread id, so no record of the tools used" };
    const file = filesBelow(join(token, "sessions")).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    if (!file) return { problem: "unexpected tool: no rollout, so no record of the tools used" };
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { return { problem: "unexpected tool: the rollout is unreadable" }; }
    // The rollout is the session: kept for a follow-up, else removed now.
    if (!keep) rmSync(file, { force: true });
    return { problem: codexRolloutProblem(text, servers), tools: codexRolloutTools(text) };
  },
  detect(cfg) {
    const bin = resolveCodexBin(cfg);
    let version = null;
    if (bin) {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: codexHome() } });
      version = r.status === 0 ? (r.stdout.trim().split(/\s+/).at(-1) || null) : null;
    }
    return { bin, version, loggedIn: !!this.token(cfg) };
  },
  preflight(_bin, home) {
    for (const f of CODEX_HOME_INSTRUCTIONS) rmSync(join(home, f), { force: true });
    // Rollouts of sessions no follow-up can reach any more.
    for (const f of filesBelow(join(home, "sessions"))) {
      try { if (Date.now() - statSync(f).mtimeMs > SESSION_TTL_MS) rmSync(f, { force: true }); } catch { /* gone */ }
    }
    return null;
  },
  command(t) {
    if (!t.files) throw new Error("the file tools are not running");
    // macOS: Codex runs under the helper's profile only. Its shell is off, so it starts no command and never nests its own
    // seatbelt inside ours; its permission profile still denies its home to the tools that read through it (view_image).
    const paths = t.mac ? { work: `${t.mac.root}/work`, home: `${t.mac.root}/tmp/home`, codexHome: t.token } : undefined;
    const args = codexArgs({ model: t.model, effort: harnessEffort(t.bundle.effort, codexAdapter.maxEffort), system: t.bundle.system, server: t.lease.server, servers: t.bundle.mcpServers, files: t.files.url, keepSession: t.bundle.keepSession, ...(t.resumeId && { resumeId: t.resumeId }), toolTimeoutSec: t.bundle.timeoutSeconds, ...(paths && { paths }) });
    if (t.mac) return macCommand({ profile: t.mac.profile, root: t.mac.root, argv: [...t.mac.install.argv, ...args], env: { CODEX_HOME: t.token, [FILES_ENV]: t.files.token, ...(t.bundle.mcpServers.length && { [LEASE_ENV]: t.lease.secret }) } });
    return codexSandbox({ codexBin: t.bin, codexHome: t.token, codexArgs: args, mounts: t.mounts, env: { [FILES_ENV]: t.files.token, ...(t.bundle.mcpServers.length && { [LEASE_ENV]: t.lease.secret }) } });
  },
  parse: parseCodexOutput,
  resume: (args, sessionId) => {
    if (!THREAD_ID.test(sessionId)) throw new Error(`not a Codex thread id: ${sessionId}`);
    const out = args.slice(0, -1).filter((a, i, all) => a !== "resume" && all[i - 1] !== "resume");
    return [...out, "resume", sessionId, "-"];
  },
  progress: codexProgress,
  versionInSandbox: (bin) => codexSandbox({ codexBin: bin, codexHome: codexHome(), codexArgs: ["--version"], mounts: [] }),
  install: (bin) => ({ argv: [bin], files: [bin], dirs: [dirname(bin)] }),
};

// ---------------------------------------------------------------------------
// macOS: sandbox-exec. Seatbelt confines paths but cannot remap them, so the sandbox paths live below one directory per
// parallel slot, the path root the claim names (protocol.ts Claim.root): the server words the bundle's text and claude
// arguments for it and reads the reply's paths back without it. The root is in the per-user cache directory
// (`getconf DARWIN_USER_CACHE_DIR`, /private/var/folders/...), which holds no account name, so the prompts the server
// stores and shows name none; and it is the same for every call of the slot, so prompt prefixes cache. A slot holds
//   repo/ repos/<name>/ repo-docs/   clonefile copies (`cp -c`) of the cached trees, kept while the next call needs the same tree
//   mcp.json agents.json             the call's MCP config and explorer definition
//   work/                            the harness's empty working directory
//   tmp/                             the only writable place besides the session store: HOME, the temp config, TMPDIR
// Copies, not symlinks into the tree cache: with copies the profile lets the harness read the slot and never the cache,
// which holds other calls' trees, private ones included; Claude Code checks its Read rules against a symlink's resolved
// path, which lies outside every --add-dir; and ripgrep (its Grep) does not follow the symlinks it meets under /repos. A
// symlink inside a tree is copied as a symlink, and Seatbelt checks the resolved path, so it reads nothing the profile denies.
// A follow-up turn runs in the slot that holds its session (the claim offers only that slot's sessions): the session's
// earlier turns name that slot's paths.
//
// The profile denies by default and allows the slot, the harness install, system libraries and frameworks, and the platform
// services a process needs to start and reach the network. Its rules follow Codex's seatbelt policies (github.com/openai/codex,
// codex-rs/sandboxing/src/seatbelt_base_policy.sbpl, seatbelt_network_policy.sbpl, seatbelt_read_only_platform_defaults.sbpl),
// which descend from Chrome's. Seatbelt applies the last rule that matches, so the named secrets (~/.ssh, ~/.aws, the
// Keychains, ~/.claude*, ~/.codex, the helper's own config and cache) are denied before the narrow allows; only those may
// re-open a path below them (a harness installed in ~/.claude/local, the helper's Codex home and session stores).

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAC_MAX_SLOTS = 16;

/** Platform files every process reads: libraries, frameworks, zoneinfo, certificates and configuration in /etc. */
const MAC_SYSTEM = ["/usr/lib", "/usr/share", "/usr/libexec", "/usr/bin", "/usr/sbin", "/bin", "/sbin", "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/System/iOSSupport", "/Library/Apple", "/Library/Preferences", "/Library/Filesystems/NetFSPlugins", "/private/etc", "/private/var/db"];
/** Software installed for all users (Homebrew, MacPorts, Nix): a Node-based harness and the libraries it links. Not Homebrew's etc or var, which may hold user data. */
const MAC_SOFTWARE = [...["/opt/homebrew", "/usr/local"].flatMap((p) => ["Cellar", "Caskroom", "opt", "lib", "libexec", "bin"].map((d) => `${p}/${d}`)), "/opt/local/lib", "/opt/local/libexec", "/opt/local/bin", "/nix/store"];
/** Code the loader maps. */
const MAC_EXEC = ["/usr/lib", "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/System/iOSSupport", "/Library/Apple"];
/** Mach services: directory and user lookups, logging, power, TLS trust, network configuration and DNS. */
const MAC_SERVICES = ["com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.system.DirectoryService.libinfo_v1", "com.apple.bsd.dirhelper", "com.apple.secinitd",
  "com.apple.logd", "com.apple.logd.events", "com.apple.system.logger", "com.apple.diagnosticd", "com.apple.analyticsd", "com.apple.system.notification_center", "com.apple.PowerManagement.control",
  // TLS certificate checks of harnesses that use the system's trust store; the Keychain files themselves are denied.
  "com.apple.SecurityServer", "com.apple.trustd", "com.apple.trustd.agent", "com.apple.ocspd", "com.apple.networkd",
  "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.SystemConfiguration.configd"];

/** An SBPL string literal. @param {string} s */
function sbStr(s) {
  if (!s.startsWith("/") || /[\u0000-\u001f\u007f]/.test(s)) throw new Error(`unsafe path for the sandbox profile: ${JSON.stringify(s)}`);
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}
/** A path filter: `subpath` for a directory, a regex for a name prefix (`~/.claude*`: the directory and ~/.claude.json). @param {string} p */
function sbPath(p) {
  if (!p.endsWith("*")) return `(subpath ${sbStr(p)})`;
  const base = p.slice(0, -1);
  sbStr(base);
  if (/["\\]/.test(base)) throw new Error(`unsafe path for the sandbox profile: ${JSON.stringify(p)}`);
  return `(regex #"^${base.replace(/[.^$|?*+()[\]{}]/g, "\\$&")}")`;
}

/** The secrets the profile names as denied (everything else in the home is denied by default). @param {string} home */
export const macDenied = (home) => [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.netrc`, `${home}/Library/Keychains`, `${home}/.claude*`, `${home}/.codex`, `${home}/.config`, configDir(), cacheDir()];

/**
 * The sandbox-exec profile of one run. The slot (`ROOT`, read-only) and its temp directory (`TMP`, writable) come as
 * parameters (`-D ROOT=... -D TMP=...`); the other paths are written in.
 * @param {{ deny: string[], files?: string[], dirs?: string[], writes?: string[] }} p
 *   deny: paths (a trailing `*` for a name prefix) never readable or writable; files: single files to read and run (a native
 *   harness binary); dirs: directories to read and map code from (a harness package and the Node it runs on); writes:
 *   directories to read and write (the session store, the helper's Codex home)
 */
export function macProfile(p) {
  const list = (/** @type {string} */ rule, /** @type {string[]} */ filters) => (filters.length ? [`(${rule}\n  ${filters.join("\n  ")})`] : []);
  const files = p.files ?? [], dirs = p.dirs ?? [], writes = p.writes ?? [];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    "(allow ipc-posix-sem)",
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    ...list("allow mach-lookup", MAC_SERVICES.map((s) => `(global-name ${JSON.stringify(s)})`)),
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    "; devices",
    '(allow file-read* file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/autofs_nowait"))',
    '(allow file-read-data file-write-data file-test-existence (subpath "/dev/fd"))',
    '(allow file-read-metadata (literal "/dev"))',
    "; resolving the root, the standard symlinks and the parents of firmlinks",
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read-metadata file-test-existence (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private") (literal "/System") (literal "/System/Volumes") (literal "/System/Volumes/Data") (literal "/Users") (subpath "/private/var"))',
    "; system files and software installed for all users",
    ...list("allow file-read* file-test-existence", [...MAC_SYSTEM, ...MAC_SOFTWARE].map((d) => `(subpath ${sbStr(d)})`)),
    ...list("allow file-map-executable", [...MAC_EXEC, ...MAC_SOFTWARE].map((d) => `(subpath ${sbStr(d)})`)),
    "; network: outbound only, DNS through mDNSResponder",
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog"))',
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "; secrets: denied before the allows below, the only rules that may re-open a path under them",
    ...list("deny file-read* file-write*", p.deny.map(sbPath)),
    "; the call: its slot read-only, the slot's temp directory writable",
    '(allow file-read* file-test-existence (subpath (param "ROOT")))',
    '(allow file-read* file-write* file-test-existence (subpath (param "TMP")))',
    // A harness may unpack native addons into its temp directory and load them.
    '(allow file-map-executable (subpath (param "TMP")))',
    "; the harness install, the session store and the helper's Codex home",
    ...list("allow file-read* file-test-existence file-map-executable", [...files.map((f) => `(literal ${sbStr(f)})`), ...dirs.map((d) => `(subpath ${sbStr(d)})`)]),
    ...list("allow file-read* file-write* file-test-existence", writes.map((d) => `(subpath ${sbStr(d)})`)),
    ...list("allow file-read-metadata file-test-existence", [...files, ...dirs, ...writes].map((x) => `(path-ancestors ${sbStr(x)})`)),
    "",
  ].join("\n");
}

/** Whether a file starts with `#!` (a script such as the npm `claude` or `codex` launcher). @param {string} p */
function isScript(p) {
  try { const fd = openSync(p, "r"); const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); return b.toString("latin1") === "#!"; } catch { return false; }
}

/** The package directory of a file inside an npm package: the nearest parent with a package.json. @param {string} file */
function packageDir(file) {
  for (let d = dirname(file), i = 0; i < 8 && d !== dirname(d); d = dirname(d), i++) if (existsSync(join(d, "package.json"))) return d;
  return dirname(file);
}

/**
 * What runs a harness on macOS and what the profile lets it read: a native binary runs as itself; a Node script (an npm
 * install of claude) runs on the Node found on PATH, with its package and that Node's install readable.
 * @param {string} bin resolved harness binary @param {string | null} [node] resolved node binary
 * @returns {{ argv: string[], files: string[], dirs: string[] }}
 */
export function macInstall(bin, node = null) {
  if (!isScript(bin)) return { argv: [bin], files: [bin], dirs: [] };
  if (!node) throw new Error(`${bin} is a Node script and node was not found on PATH`);
  return { argv: [node, bin], files: [], dirs: [packageDir(bin), dirname(dirname(node))] };
}

/** The resolved `node` on PATH, or null. */
function nodeOnPath() {
  for (const d of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { accessSync(join(d, "node"), constants.X_OK); return realpathSync(join(d, "node")); } catch { /* next */ }
  }
  return null;
}

/** The directory the slots live in: the per-user cache directory, resolved (/private/var/folders/<..>/C/autocraft-task). */
function slotBase() {
  const r = spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 10_000 });
  const d = r.status === 0 ? r.stdout.trim() : "";
  if (!d) throw new Error("getconf DARWIN_USER_CACHE_DIR gave no directory");
  return privateDir(join(realpathSync(d), "autocraft-task"));
}
/** @param {string} base @param {number} n */
export const slotRoot = (base, n) => `${base}/slot-${n}`;

/** Takes slot `n`'s lock (a file naming a live process); the release function, or null when another run holds it. @param {string} base @param {number} n */
function takeSlot(base, n) {
  const file = `${slotRoot(base, n)}.lock`;
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch {
      const pid = Number.parseInt((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })(), 10);
      if (pid > 0 && alive(pid)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** The lowest free slot, held until `release`. @param {string} base @returns {{ n: number, release: () => void }} */
function holdSlot(base) {
  for (let n = 0; n < MAC_MAX_SLOTS; n++) { const release = takeSlot(base, n); if (release) return { n, release }; }
  throw new Error(`all ${MAC_MAX_SLOTS} slots are busy`);
}

/** A slot for a lease that another process runs later (`claim`, `run --detach`): free now and named by no claimed lease. @param {string} base */
function pickSlot(base) {
  const dir = join(configDir(), "leases");
  const named = new Set(existsSync(dir) ? readdirSync(dir).map((f) => readJson(join(dir, f))?.slot).filter((n) => Number.isInteger(n)) : []);
  for (let n = 0; n < MAC_MAX_SLOTS; n++) {
    if (named.has(n)) continue;
    const release = takeSlot(base, n);
    if (release) { release(); return n; }
  }
  throw new Error(`all ${MAC_MAX_SLOTS} slots are busy or hold claimed leases`);
}

/** The values a flag takes in an argument list. @param {string[]} args @param {string} flag */
const argValues = (args, flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

/**
 * Where a call's files go in a slot: each prepared mount at its fixed sandbox path below the root, an empty directory for
 * each rooted --add-dir without a mount and for the parents of nested mounts (`<root>/repos`), and the mounts as the
 * harness and the file tools see them.
 * @param {string} root @param {{ host: string, path: string }[]} mounts prepared mounts at fixed sandbox paths @param {string[]} [addDirs] rooted --add-dir values
 */
export function slotPlan(root, mounts, addDirs = []) {
  const copies = mounts.map((m) => ({ src: m.host, dst: `${root}${checkMountPath(m.path)}` }));
  const empty = addDirs.filter((d) => d.startsWith(`${root}/`)).map((d) => `${root}${checkMountPath(d.slice(root.length))}`);
  const parents = copies.map((c) => dirname(c.dst)).filter((d) => d !== root);
  const dirs = [...new Set([...empty, ...parents])].filter((d) => !copies.some((c) => c.dst === d));
  return { copies, dirs, mounts: copies.map((c) => ({ host: c.dst, path: c.dst })) };
}

/** Entries of a slot no call replaces. */
const SLOT_FIXED = new Set(["work", "tmp"]);

/** Copies a tree with clonefile where the filesystem has it (APFS), as a plain copy elsewhere. @param {string} src @param {string} dst */
async function cloneTree(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  let r = await run("cp", process.platform === "darwin" ? ["-c", "-R", src, tmp] : ["-R", "--reflink=auto", src, tmp]);
  if (r.code !== 0 && process.platform === "darwin") { rmSync(tmp, { recursive: true, force: true }); r = await run("cp", ["-R", src, tmp]); }
  if (r.code !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`copying ${src}: ${r.stderr.trim().slice(0, 200)}`); }
  renameSync(tmp, dst);
}

/**
 * Fills a slot for one call: removes what the call does not use, copies each tree that differs from what the slot holds
 * (recorded beside the slot, not in it), makes the empty directories, writes the call's files and empties tmp/.
 * @param {string} root @param {ReturnType<typeof slotPlan>} plan @param {{ name: string, content: string }[]} files written at the slot's top level, mode 0600
 */
export async function fillSlot(root, plan, files) {
  const recordFile = `${root}.json`;
  /** @type {Record<string, string>} */
  const record = readJson(recordFile) ?? {};
  privateDir(root);
  const wanted = new Set([...plan.copies.map((c) => c.dst), ...plan.dirs, ...files.map((f) => `${root}/${f.name}`)]);
  /** @param {string} p */
  const drop = (p) => {
    rmSync(p, { recursive: true, force: true });
    for (const k of Object.keys(record)) if (k === p || k.startsWith(`${p}/`)) delete record[k];
  };
  /** Removes what the call does not use below `dir`; an empty directory of the plan keeps only the copies inside it. @param {string} dir */
  const prune = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (dir === root && SLOT_FIXED.has(e.name)) continue;
      if (plan.dirs.includes(p)) { if (record[p] !== undefined || !e.isDirectory()) drop(p); else prune(p); }
      else if (wanted.has(p)) continue;
      else if (e.isDirectory() && [...wanted].some((w) => w.startsWith(`${p}/`))) prune(p);
      else drop(p);
    }
  };
  prune(root);
  for (const c of plan.copies) {
    if (record[c.dst] === c.src && existsSync(c.dst)) continue;
    rmSync(c.dst, { recursive: true, force: true });
    delete record[c.dst];
    mkdirSync(dirname(c.dst), { recursive: true });
    await cloneTree(c.src, c.dst);
    record[c.dst] = c.src;
  }
  for (const d of plan.dirs) mkdirSync(d, { recursive: true });
  for (const f of files) {
    if (!/^[a-z][a-z0-9.-]*$/.test(f.name)) throw new Error(`bad slot file name ${f.name}`);
    writeFileSync(`${root}/${f.name}`, f.content, { mode: 0o600 });
  }
  mkdirSync(`${root}/work`, { recursive: true });
  rmSync(`${root}/tmp`, { recursive: true, force: true });
  for (const d of ["tmp/home", "tmp/t"]) mkdirSync(`${root}/${d}`, { recursive: true, mode: 0o700 });
  writePrivate(recordFile, record);
}

/**
 * The sandbox-exec command of one run: the profile file, the slot and its temp directory as parameters, the harness, its
 * working directory in the slot. `env` is the process's whole environment.
 * @param {{ profile: string, root: string, argv: string[], env: Record<string, string> }} s
 */
export function macCommand(s) {
  const tmp = `${s.root}/tmp`;
  return {
    cmd: SANDBOX_EXEC, args: ["-f", s.profile, "-D", `ROOT=${s.root}`, "-D", `TMP=${tmp}`, ...s.argv], cwd: `${s.root}/work`,
    // Claude Code keeps its own temp dir at /tmp/claude-<uid> unless CLAUDE_CODE_TMPDIR is set; on a Mac that has run Claude Code that
    // dir already exists outside the profile, and the mkdir fails.
    env: { HOME: `${tmp}/home`, TMPDIR: `${tmp}/t/`, CLAUDE_CODE_TMPDIR: `${tmp}/t`, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", ...s.env },
  };
}

/** The Keychain item the config recorded, or (configs from before it was recorded) the one the current environment names. @param {Config} cfg */
const keychainItemOf = (cfg) => cfg.claudeKeychain ?? claudeKeychainItem();

/**
 * The Keychain item of Claude Code's login on macOS, as Claude Code names it: service "Claude Code-credentials" (with the
 * first 8 hex digits of the SHA-256 of CLAUDE_CONFIG_DIR appended when that is set), account the user name.
 * @param {Record<string, string | undefined>} [env]
 */
export function claudeKeychainItem(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  let user = env.USER;
  if (!user) try { user = userInfo().username; } catch { user = ""; }
  return {
    service: `Claude Code-credentials${dir ? `-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`,
    account: user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user",
  };
}

/**
 * The access token of the user's own Claude Code login, read from the Keychain outside the sandbox with `security`, and
 * when it expires. The helper never refreshes it: a refresh rotates the login and would sign Claude Code out.
 * @returns {{ token: string, expiresAt: number | null } | null}
 */
/** @param {{ service: string, account: string }} [item]  the item recorded at `harness claude --keychain` time */
function keychainCredential(item = claudeKeychainItem()) {
  if (process.platform !== "darwin") return null;
  const { service, account } = item;
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-w", "-s", service], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return null;
  try {
    const o = JSON.parse(r.stdout.trim())?.claudeAiOauth;
    return typeof o?.accessToken === "string" && o.accessToken ? { token: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null } : null;
  } catch { return null; }
}

/**
 * The canary, run by Node inside the profile: it must read the slot and write its temp directory, and must not read a file
 * the helper planted in the home, list the home, ~/.ssh or the Keychains, or write the home or the slot. Prints one JSON line.
 */
const CANARY = `const fs = require("node:fs");
const [slotFile, tmp, planted, home, ssh, keychains, root] = process.argv.slice(1);
const t = (f) => { try { f(); return { ok: true }; } catch (e) { return { ok: false, code: e.code || String(e) }; } };
console.log(JSON.stringify({
  readSlot: t(() => fs.readFileSync(slotFile)), writeTmp: t(() => fs.writeFileSync(tmp + "/w", "x")),
  readPlanted: t(() => fs.readFileSync(planted)), listHome: t(() => fs.readdirSync(home)), listSsh: t(() => fs.readdirSync(ssh)),
  listKeychains: t(() => fs.readdirSync(keychains)), writeHome: t(() => fs.writeFileSync(planted + ".w", "x")), writeSlot: t(() => fs.writeFileSync(root + "/w", "x")),
}));`;

/** What each canary probe must give. */
const CANARY_WANT = { readSlot: true, writeTmp: true, readPlanted: false, listHome: false, listSsh: false, listKeychains: false, writeHome: false, writeSlot: false };

/**
 * Reads the canary's output: ok only when every probe gave what it must, with one line per probe.
 * @param {string} stdout @returns {{ ok: boolean, lines: string[] }}
 */
export function canaryVerdict(stdout) {
  let r;
  try { r = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { return { ok: false, lines: ["the canary printed no result"] }; }
  const lines = [], bad = [];
  for (const [k, want] of Object.entries(CANARY_WANT)) {
    const got = r?.[k]?.ok === true;
    lines.push(`${got === want ? "ok  " : "FAIL"} ${k}: ${got ? "allowed" : `denied (${r?.[k]?.code ?? "?"})`}${got === want ? "" : `, must be ${want ? "allowed" : "denied"}`}`);
    if (got !== want) bad.push(k);
  }
  return { ok: bad.length === 0, lines };
}

/** A sandbox run outside any slot (canary, doctor): its own root beside the slots, emptied first. @param {string} name */
function scratchSlot(name) {
  const root = `${slotBase()}/${name}`;
  rmSync(root, { recursive: true, force: true });
  for (const d of ["work", "tmp/home", "tmp/t"]) mkdirSync(`${root}/${d}`, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Runs the canary inside the profile the harness runs in, with Node as the harness. Throws nothing.
 * @returns {{ ok: boolean, lines: string[] }}
 */
function macCanary() {
  let planted = "";
  try {
    const home = realpathSync(homedir());
    const root = scratchSlot("canary");
    writeFileSync(`${root}/slot.txt`, "slot");
    planted = join(home, `.autocraft-task-canary-${randomBytes(6).toString("hex")}`);
    writeFileSync(planted, "planted", { mode: 0o600 });
    const node = realpathSync(process.execPath);
    const profile = `${root}.sb`;
    writeFileSync(profile, macProfile({ deny: macDenied(home), files: [node], dirs: [dirname(dirname(node))] }), { mode: 0o600 });
    const c = macCommand({ profile, root, argv: [node, "-e", CANARY, `${root}/slot.txt`, `${root}/tmp`, planted, home, join(home, ".ssh"), join(home, "Library", "Keychains"), root], env: {} });
    const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env: c.env, encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return { ok: false, lines: [`the canary did not run (exit ${r.status}): ${(r.stderr || String(r.error ?? "")).trim().slice(0, 300)}`] };
    return canaryVerdict(r.stdout);
  } catch (e) {
    return { ok: false, lines: [`the canary could not be set up: ${msg(e)}`] };
  } finally {
    if (planted) { rmSync(planted, { force: true }); rmSync(`${planted}.w`, { force: true }); }
  }
}

/** @type {{ ok: boolean, lines: string[] } | null} */
let canaryResult = null;
/** Throws unless the canary passed in this process (run once, before the first claim). */
function requireCanary() {
  if (process.platform !== "darwin") return;
  canaryResult ??= macCanary();
  if (!canaryResult.ok) throw new Error(`the macOS sandbox canary failed, so no call is claimed:\n  ${canaryResult.lines.join("\n  ")}`);
}

/** @type {Record<HarnessId, Adapter>} */
const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

// ---------------------------------------------------------------------------
// Files: config and lease secrets under the config directory (mode 0700/0600), everything else in the cache.

/**
 * @typedef {object} Config
 * @property {string} [server]
 * @property {string} [agentToken]
 * @property {HarnessId} [harness]
 * @property {string} [claudeToken]  a `claude setup-token` token
 * @property {string} [claudeConfigDir]  a Claude config directory whose login the helper uses instead (read only, never mounted; Linux: on macOS Claude Code keeps its login in the Keychain)
 * @property {"keychain"} [claudeAuth]  macOS: the helper uses the access token of the user's own Claude Code login in the Keychain instead
 * @property {{ service: string, account: string }} [claudeKeychain]  the Keychain item chosen at `harness claude --keychain` time
 * @property {string} [claudeBin]
 * @property {string} [codexBin]
 * @property {Partial<Record<Tier, string>>} [tiers]  model per tier; defaults are the adapter's
 * @property {string[]} [repos]
 * @property {Reserve} [reserve]  the local usage reserve: it only raises the server's, window by window
 */

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autocraft-task");
const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "autocraft-task");
const SESSION_TTL_MS = 3 * 3600_000;
const TREE_TTL_MS = 3 * 24 * 3600_000;
const WAIT_MS = 9 * 60_000;

/** @param {string} p */
function privateDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  chmodSync(p, 0o700);
  return p;
}

/** Writes `data` as JSON with mode 0600, atomically. @param {string} file @param {unknown} data */
function writePrivate(file, data) {
  privateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A Claude config directory's `.credentials.json`, read only. @param {string} dir @returns {any} */
const readClaudeCredentials = (dir) => readJson(join(dir, ".credentials.json"));

/** @returns {Config} */
const loadConfig = () => readJson(join(configDir(), "config.json")) ?? {};
/** @param {Config} c */
const saveConfig = (c) => writePrivate(join(configDir(), "config.json"), c);

/** `slot` and `root`: the macOS slot the claim named. @typedef {{ secret: string, title: string, requiredHelper: string, server: string, claimedAt: number, slot?: number, root?: string }} LeaseRecord */
/** @param {number | string} id */
const leaseFile = (id) => join(configDir(), "leases", `${Number(id)}.json`);
/** @param {number | string} id @returns {LeaseRecord | null} */
const readLease = (id) => readJson(leaseFile(id));
/** @param {number | string} id */
const dropLease = (id) => rmSync(leaseFile(id), { force: true });

/** `stop`: the helper can take no call until it is updated. @typedef {{ state: "running" | "submitted" | "failed" | "lost" | "released", line: string, pid?: number, at: number, stop?: boolean }} RunStatus */
/** @param {number | string} id */
const statusFile = (id) => join(cacheDir(), "runs", `${Number(id)}.json`);
/** @param {number | string} id @param {RunStatus} s */
function writeStatus(id, s) {
  privateDir(dirname(statusFile(id)));
  writeFileSync(`${statusFile(id)}.tmp`, JSON.stringify(s), { mode: 0o600 });
  renameSync(`${statusFile(id)}.tmp`, statusFile(id));
}

/** Secrets never appear in printed or submitted text. @param {string} s */
function redact(s) {
  let out = s;
  const cfg = loadConfig();
  for (const k of [cfg.agentToken, cfg.claudeToken, ...secretsInUse]) if (k && k.length >= 8) out = out.split(k).join("[redacted]");
  return out;
}
/** @type {Set<string>} */
const secretsInUse = new Set();

/** @param {unknown} e */
const msg = (e) => redact(e instanceof Error ? e.message : String(e));

// Session stores: sessions/<callId>.json names the store directory, the harness session id and, on macOS, the slot whose
// paths the session read; stores live in sessions/store-*.
const sessionsDir = () => join(cacheDir(), "sessions");
/** @param {number} callId @returns {{ sessionId: string, dir: string, at: number, slot?: number } | null} */
function readSession(callId) {
  const s = readJson(join(sessionsDir(), `${callId}.json`));
  return s && Date.now() - s.at < SESSION_TTL_MS && existsSync(s.dir) ? s : null;
}
/** Call ids whose session store this helper still holds; on macOS only those of slot `slot`. @param {number} [slot] */
function heldSessions(slot) {
  if (!existsSync(sessionsDir())) return [];
  return readdirSync(sessionsDir()).flatMap((f) => { const m = /^(\d+)\.json$/.exec(f); const s = m ? readSession(Number(m[1])) : null; return s && s.slot === slot ? [Number(m?.[1])] : []; });
}

/** Removes expired session stores, old cached trees, status files, lease files and task directories a crash left behind. */
function prune() {
  const now = Date.now();
  /** @param {string} p */
  const age = (p) => { try { return now - statSync(p).mtimeMs; } catch { return 0; } };
  const sd = sessionsDir();
  if (existsSync(sd)) {
    const live = new Set();
    for (const f of readdirSync(sd)) {
      if (!f.endsWith(".json")) continue;
      const s = readJson(join(sd, f));
      if (!s || now - s.at >= SESSION_TTL_MS) rmSync(join(sd, f), { force: true });
      else live.add(s.dir);
    }
    for (const d of readdirSync(sd)) if (d.startsWith("store-") && !live.has(join(sd, d)) && age(join(sd, d)) > SESSION_TTL_MS) rmSync(join(sd, d), { recursive: true, force: true });
  }
  const tasks = join(cacheDir(), "tasks");
  if (existsSync(tasks)) for (const d of readdirSync(tasks)) if (age(join(tasks, d)) > 24 * 3600_000) rmSync(join(tasks, d), { recursive: true, force: true });
  const trees = join(cacheDir(), "trees");
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir)) {
      const p = join(dir, d);
      if (depth > 0) walk(p, depth - 1);
      else if (age(p) > TREE_TTL_MS) rmSync(p, { recursive: true, force: true });
    }
  };
  walk(join(trees, "git"), 2);
  walk(join(trees, "tarball"), 1);
  const runs = join(cacheDir(), "runs");
  if (existsSync(runs)) for (const f of readdirSync(runs)) if (age(join(runs, f)) > 24 * 3600_000) rmSync(join(runs, f), { force: true });
  const leases = join(configDir(), "leases");
  if (existsSync(leases)) for (const f of readdirSync(leases)) if (age(join(leases, f)) > 24 * 3600_000) rmSync(join(leases, f), { force: true });
}

// ---------------------------------------------------------------------------
// HTTP.

class Gone extends Error {}

/** A reply other than 2xx and 410. `retryAfterMs`: the reply's Retry-After, or null. */
export class HttpError extends Error {
  /** @param {string} route @param {number} status @param {string} text @param {number | null} retryAfterMs */
  constructor(route, status, text, retryAfterMs) {
    super(`${route}: HTTP ${status} ${redact(text).slice(0, 300)}`.trim());
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A Retry-After header as milliseconds (delta seconds or an HTTP date); null when absent or unreadable. @param {string | null} v */
export function retryAfterMs(v, now = Date.now()) {
  if (!v) return null;
  if (/^\s*\d+\s*$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/**
 * Whether one request's error is worth trying again: 408, 429, 5xx, a network error (reset, refused, DNS), a request timeout
 * or a reply cut off. A 410, any other 4xx and the caller's own abort are final.
 * @param {unknown} e @param {AbortSignal} [signal]
 */
export function transient(e, signal) {
  if (signal?.aborted || e instanceof Gone) return false;
  if (e instanceof HttpError) return e.status === 408 || e.status === 429 || e.status >= 500;
  if (!e || typeof e !== "object") return false;
  // fetch rejects with a TypeError ("fetch failed", "terminated" for a body cut off); JSON.parse of a cut-off body with a SyntaxError.
  if (e instanceof TypeError || e instanceof SyntaxError) return true;
  const x = /** @type {{ name?: string, code?: string, cause?: { code?: string } }} */ (e);
  return x.name === "TimeoutError" || NET_CODES.has(x.code ?? "") || NET_CODES.has(x.cause?.code ?? "");
}

/** The wait before retry `attempt` (0 first): exponential from `baseMs` up to 30 s with jitter, at least the server's Retry-After. @param {number} attempt @param {number | null} retryAfter */
export function backoffMs(attempt, retryAfter, baseMs = 1000) {
  const exp = Math.min(30_000, baseMs * 2 ** attempt);
  const wait = exp / 2 + (Math.random() * exp) / 2;
  return retryAfter === null ? wait : Math.max(wait, retryAfter + Math.random() * baseMs);
}

/**
 * Runs `fn` until it succeeds, fails for good (`transient` says no) or runs out of time (`deadline`, ms since epoch) or of
 * `tries`; then throws its last error. `signal` ends the waits between tries.
 * @template T @param {() => Promise<T>} fn @param {{ deadline: number, tries?: number, signal?: AbortSignal, baseMs?: number }} o
 * @returns {Promise<T>}
 */
export async function withRetry(fn, o) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!transient(e, o.signal) || (o.tries !== undefined && attempt + 1 >= o.tries)) throw e;
      const wait = backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null, o.baseMs);
      if (Date.now() + wait >= o.deadline) throw e;
      try { await sleep(wait, undefined, o.signal && { signal: o.signal }); } catch { throw e; }
    }
  }
}

/**
 * One request; `body` makes it a POST. Throws Gone on 410, HttpError on any other non-2xx.
 * @param {string} server @param {string} route @param {string} bearer @param {unknown} [body] @param {{ signal?: AbortSignal, timeoutMs?: number }} [o]
 * @returns {Promise<any>}
 */
export async function api(server, route, bearer, body, o = {}) {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 60_000);
  const res = await fetch(`${server}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
  });
  if (res.status === 410) throw new Gone("the lease is gone");
  const text = await res.text();
  if (!res.ok) throw new HttpError(route, res.status, text, retryAfterMs(res.headers.get("retry-after")));
  return text.trim() ? JSON.parse(text) : {};
}

/** The server ends a lease this long after the call's time limit, or after its last heartbeat (docs/operations.md, Leases). */
const LEASE_GRACE_MS = 120_000;
/** Retries of a lease route stop this long before the lease's server deadline. */
const RETRY_MARGIN_MS = 90_000;
/** Retries of a tool call made from inside the sandbox, where the lease's deadline is unknown. */
const TOOL_RETRY_MS = 3 * 60_000;

/**
 * The heartbeats of one lease, from the claim until `stop`: phase `preparing`, then `running` from `running()` on (sent at
 * once; the server's time limit starts with it). Each beat is retried until the next is due; a 410 aborts `gone`.
 * @param {LeaseRecord} lease
 */
function heartbeats(lease) {
  const goneAc = new AbortController(), stopAc = new AbortController();
  /** @type {Heartbeat["phase"]} */
  let phase = "preparing";
  let progress = "", sent = "", wake = () => {};
  /** @type {number | null} */
  let runStart = null;
  const send = () => withRetry(() => api(lease.server, ROUTES.heartbeat, lease.secret, /** @type {Heartbeat} */ ({ phase, ...(progress && { progress }) }), { signal: stopAc.signal, timeoutMs: 20_000 }), { deadline: Date.now() + HEARTBEAT_S * 1000 - 2000, signal: stopAc.signal });
  void (async () => {
    while (!stopAc.signal.aborted) {
      sent = phase;
      try { await send(); } catch (e) { if (e instanceof Gone) { goneAc.abort(); return; } }
      try { await keepStatusFresh(); } catch { /* next beat */ }
      if (sent === phase && !stopAc.signal.aborted) await new Promise((r) => { const t = setTimeout(r, HEARTBEAT_S * 1000); wake = () => { clearTimeout(t); r(undefined); }; });
    }
  })();
  return {
    gone: goneAc.signal,
    get runStart() { return runStart; },
    /** The harness spawns now. */
    running() { if (runStart !== null) return; runStart = Date.now(); phase = "running"; wake(); },
    /** @param {string} p the harness's last progress line */
    progress(p) { progress = p; },
    stop() { stopAc.abort(); wake(); },
  };
}

// ---------------------------------------------------------------------------
// Plan usage and readiness. Before every claim the helper reads its harness's plan usage and claims only while every
// window keeps more than the reserve free (the user's, from the server, raised by the local `config reserve`). Anything
// it cannot read for sure holds: no reading, a failed or unparseable one, one older than USAGE_STALE_MS, or a window kind
// this helper does not know. A user's pause outranks recovered headroom; a run the provider refused for its limit parks
// the helper until the reset the provider named. The helper reports its readiness to the server (ROUTES.status) on every
// change and at least every STATUS_EVERY_MS, and keeps it in a 0600 status file.

export const USAGE_STALE_MS = 5 * 60_000;
/** A reading this young is used again instead of asking the provider (claims come every 15 s). */
const USAGE_REUSE_MS = 60_000;
/** While held, the helper reads its usage again this often. */
export const HOLD_RETRY_MS = 60_000;
export const STATUS_EVERY_MS = 5 * 60_000;
/** The longest a provider's refusal parks the helper: its reset time is text the helper cannot check. */
export const PARK_CAP_MS = 7 * 24 * 3600_000;
/** A refusal that names no reset parks for this long; the hold comes back if the usage still says so. */
const PARK_FALLBACK_MS = 15 * 60_000;
/** Added to a parsed reset so the first claim after it is not early. */
const PARK_GRACE_MS = 60_000;
/** A server that refused the helper's version is asked again after this long. */
const REFUSED_RETRY_MS = 10 * 60_000;
export const DEFAULT_RESERVE = { fiveHour: 20, weekly: 20 };
/** The window kinds the helper knows; any other kind in a reading holds. */
const WINDOW_KINDS = /** @type {const} */ (["five_hour", "weekly"]);
const RESERVE_OF = /** @type {const} */ ({ five_hour: "fiveHour", weekly: "weekly" });

/** @typedef {{ kind: string, usedPercent: number, resetsAt: number | null }} QuotaWindow  `kind` is five_hour, weekly, or the provider's name of a window the helper does not know; times in ms */
/** @typedef {{ at: number, windows: QuotaWindow[], blocked?: string } | { at: number, error: string }} QuotaReading */
/** @typedef {{ ok: true } | { ok: false, until: number | null, reason: string }} QuotaVerdict */
/** @typedef {{ until: number | null, at: number }} Pause  until: the reset it was taken at; null: until `resume` */
/** @typedef {{ until: number | null, at: number, reason: string }} Park  until null: the provider named no trusted time; a passing reading taken after `at` ends it */

/** The reserve the helper enforces: per window the larger of the server's (the default before it has sent one) and the local one. @param {Reserve | undefined} server @param {Reserve | undefined} local @returns {Reserve} */
export function effectiveReserve(server, local) {
  const s = server ?? DEFAULT_RESERVE;
  return { fiveHour: Math.max(s.fiveHour, local?.fiveHour ?? 0), weekly: Math.max(s.weekly, local?.weekly ?? 0) };
}

/** @param {number | null} t */
const clock = (t) => (t === null ? "" : new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
/** @param {string} kind */
const windowName = (kind) => (kind === "five_hour" ? "5-hour" : kind === "weekly" ? "weekly" : kind);

/**
 * Whether a reading lets the helper claim under `reserve`: every window's remaining percent (100 - used) above its reserve.
 * A hold names the windows that bind and lasts until the latest of their resets (null when one has none).
 * @param {QuotaReading | null} reading @param {Reserve} reserve @param {number} [now] @returns {QuotaVerdict}
 */
export function quotaVerdict(reading, reserve, now = Date.now()) {
  if (!reading) return { ok: false, until: null, reason: "no usage reading" };
  if ("error" in reading) return { ok: false, until: null, reason: `usage unknown: ${reading.error}` };
  if (!(now - reading.at <= USAGE_STALE_MS)) return { ok: false, until: null, reason: `the usage reading is ${Math.round((now - reading.at) / 60_000)} min old` };
  if (!reading.windows.length) return { ok: false, until: null, reason: "usage unknown: the reading has no plan window" };
  /** @type {QuotaWindow[]} */
  const binding = [];
  for (const w of reading.windows) {
    const known = /** @type {readonly string[]} */ (WINDOW_KINDS).includes(w.kind);
    if (!known) return { ok: false, until: null, reason: `usage unknown: a plan window of a kind this helper does not know (${w.kind})` };
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return { ok: false, until: null, reason: `usage unknown: the ${windowName(w.kind)} window has no percentage` };
    if (100 - w.usedPercent <= reserve[RESERVE_OF[/** @type {"five_hour" | "weekly"} */ (w.kind)]]) binding.push(w);
  }
  const latest = (/** @type {QuotaWindow[]} */ ws) => (ws.some((w) => w.resetsAt === null) ? null : Math.max(...ws.map((w) => /** @type {number} */ (w.resetsAt))));
  if (reading.blocked) return { ok: false, until: latest(reading.windows.filter((w) => w.usedPercent >= 100).length ? reading.windows.filter((w) => w.usedPercent >= 100) : reading.windows), reason: reading.blocked };
  if (!binding.length) return { ok: true };
  const what = binding.map((w) => `${windowName(w.kind)} window ${Math.round(w.usedPercent)}% used (reserve ${reserve[RESERVE_OF[/** @type {"five_hour" | "weekly"} */ (w.kind)]]}% free)`).join(", ");
  return { ok: false, until: latest(binding), reason: what };
}

/**
 * The helper's quota readiness from its pause, its park and the usage verdict: a pause first, then a park, then the usage.
 * `dropPark`: the park is over (its time passed, or a passing reading came after it).
 * @param {{ pause?: Pause | null, park?: Park | null, verdict: QuotaVerdict, readingAt: number | null, now?: number }} o
 * @returns {{ readiness: "ready" | "quota-held" | "paused", until: number | null, reason?: string, dropPause?: boolean, dropPark?: boolean }}
 */
export function quotaReadiness({ pause, park, verdict, readingAt, now = Date.now() }) {
  let dropPause = false, dropPark = false;
  if (pause && pause.until !== null && now >= pause.until) { dropPause = true; pause = null; }
  if (park && (park.until !== null ? now >= park.until : verdict.ok && readingAt !== null && readingAt > park.at)) { dropPark = true; park = null; }
  const drops = { ...(dropPause && { dropPause }), ...(dropPark && { dropPark }) };
  if (pause) return { readiness: "paused", until: pause.until, reason: pause.until === null ? "by the user, until `autocraft-task resume`" : "by the user, until the plan window resets", ...drops };
  if (park) return { readiness: "quota-held", until: park.until, reason: park.reason, ...drops };
  if (!verdict.ok) return { readiness: "quota-held", until: verdict.until, reason: verdict.reason, ...drops };
  return { readiness: "ready", until: null, ...drops };
}

/** @param {unknown} v @returns {number | null} */
const timeOf = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Whether a model scope (a display name such as "Opus", or a model id) is one of the models this helper runs. @param {any} model @param {string[]} models */
function runsModel(model, models) {
  const names = [model?.id, typeof model?.display_name === "string" ? model.display_name.split(/\s+/)[0] : null].filter((x) => typeof x === "string" && x).map((x) => x.toLowerCase());
  if (!names.length) return true;
  return models.some((m) => names.some((n) => m.toLowerCase().includes(n) || n.includes(m.toLowerCase())));
}

/**
 * Claude Code's plan usage (GET https://api.anthropic.com/api/oauth/usage, as Claude Code 2.1 reads it for /usage) as
 * windows. `limits` lists them with a kind and a group: session (the 5-hour window), weekly_all, and weekly_scoped for one
 * model (`scope.model`), which counts only when the helper runs that model. A reply without `limits` gives the named
 * windows five_hour, seven_day and the per-model seven_day_opus / seven_day_sonnet (utilization in percent).
 * @param {any} body @param {string[]} models the models the helper runs @param {number} [now] @returns {QuotaReading}
 */
export function parseClaudeUsage(body, models, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { at: now, error: "unreadable usage reply" };
  /** @type {QuotaWindow[]} */
  const windows = [];
  if (Array.isArray(body.limits)) {
    for (const l of body.limits) {
      if (!l || typeof l !== "object" || typeof l.kind !== "string") return { at: now, error: "unreadable usage reply: a limit without a kind" };
      const w = { usedPercent: l.percent, resetsAt: timeOf(l.resets_at) };
      if (l.kind === "weekly_scoped" && l.scope?.model && !runsModel(l.scope.model, models)) continue;
      const kind = l.kind === "session" ? "five_hour" : l.kind === "weekly_all" || l.kind === "weekly_scoped" ? "weekly"
        : l.group === "session" ? "five_hour" : l.group === "weekly" ? "weekly" : l.kind;
      windows.push({ kind, ...w });
    }
  } else {
    for (const [key, kind, model] of [["five_hour", "five_hour", null], ["seven_day", "weekly", null], ["seven_day_opus", "weekly", "opus"], ["seven_day_sonnet", "weekly", "sonnet"]]) {
      const w = body[/** @type {string} */ (key)];
      if (!w || typeof w !== "object") continue;
      if (model && !runsModel({ display_name: model }, models)) continue;
      windows.push({ kind: /** @type {string} */ (kind), usedPercent: w.utilization, resetsAt: timeOf(w.resets_at) });
    }
  }
  return { at: now, windows };
}

/**
 * The Codex app-server's `account/rateLimits/read` reply (codex-rs app-server-protocol v2 GetAccountRateLimitsResponse) as
 * windows: the default bucket (`rateLimits`) and the buckets of `rateLimitsByLimitId` whose normal model is one the helper
 * runs, each with a primary and a secondary window. A window of 300 minutes is the 5-hour one, 10080 the weekly one; any
 * other length is a kind the helper does not know. `ordinaryUsageAllowed: false` or a bucket's `rateLimitReachedType` blocks.
 * @param {any} res @param {string[]} models @param {number} [now] @returns {QuotaReading}
 */
export function parseCodexRateLimits(res, models, now = Date.now()) {
  if (!res || typeof res !== "object" || !res.rateLimits || typeof res.rateLimits !== "object") return { at: now, error: "unreadable rate-limit reply" };
  const buckets = [res.rateLimits];
  if (res.rateLimitsByLimitId && typeof res.rateLimitsByLimitId === "object") {
    for (const b of Object.values(res.rateLimitsByLimitId)) if (b && typeof b === "object" && typeof b.normalModelSlug === "string" && models.includes(b.normalModelSlug)) buckets.push(b);
  }
  /** @type {QuotaWindow[]} */
  const windows = [];
  let blocked;
  for (const b of buckets) {
    for (const w of [b.primary, b.secondary]) {
      if (!w) continue;
      if (typeof w !== "object") return { at: now, error: "unreadable rate-limit window" };
      const mins = w.windowDurationMins;
      windows.push({ kind: mins === 300 ? "five_hour" : mins === 10080 ? "weekly" : `${mins ?? "unknown"}-minute`, usedPercent: w.usedPercent, resetsAt: timeOf(w.resetsAt) });
    }
    if (typeof b.rateLimitReachedType === "string") blocked = `the provider reports its limit reached (${b.rateLimitReachedType})`;
  }
  if (res.ordinaryUsageAllowed === false) blocked = "the provider reports that the plan's usage is used up";
  return { at: now, windows, ...(blocked && { blocked }) };
}

/** Reads Claude Code's plan usage with the harness credential: no model call. @param {string} token @param {string[]} models @returns {Promise<{ reading: QuotaReading, retryAt?: number }>} */
async function claudeQuota(token, models) {
  const now = Date.now();
  let res;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": `autocraft-task/${HELPER_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { reading: { at: now, error: `the usage endpoint did not answer (${msg(e)})` } };
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    return { reading: { at: now, error: "the usage endpoint asked the helper to wait" }, retryAt: now + Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 5 * 60_000, 3600_000) };
  }
  if (res.status === 401 || res.status === 403) {
    const cfg = loadConfig();
    const hint = cfg.claudeToken && !cfg.claudeConfigDir && cfg.claudeAuth !== "keychain" ? "; a `claude setup-token` token may not read plan usage: use `harness claude --config-dir` (Linux) or `--keychain` (macOS)" : "; run claude once to refresh its login";
    return { reading: { at: now, error: `this Claude login may not read plan usage (HTTP ${res.status})${hint}` }, retryAt: now + 5 * 60_000 };
  }
  if (!res.ok) return { reading: { at: now, error: `the usage endpoint answered HTTP ${res.status}` } };
  let body;
  try { body = await res.json(); } catch { return { reading: { at: now, error: "unreadable usage reply" } }; }
  return { reading: parseClaudeUsage(body, models, now) };
}

/**
 * Asks the Codex app-server (`codex app-server`, JSON-RPC lines on stdio) for `account/rateLimits/read`, with the helper's
 * own CODEX_HOME. It may refresh the login, so it holds the Codex lock that calls hold; while a call runs there is no reading.
 * @param {string} bin @param {string} home @param {string[]} models @returns {Promise<{ reading: QuotaReading }>}
 */
async function codexQuota(bin, home, models) {
  const now = Date.now();
  const unlock = takeHarnessLock("codex");
  if (!unlock) return { reading: { at: now, error: "a Codex call is running on this helper" } };
  try {
    for (const f of CODEX_HOME_INSTRUCTIONS) rmSync(join(home, f), { force: true });
    const result = await new Promise((done) => {
      const p = spawn(bin, ["-c", 'cli_auth_credentials_store="file"', "app-server"], { env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: home, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"] });
      let buf = "", settled = false;
      /** @param {any} v */
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); p.stdin.end(); p.kill("SIGTERM"); done(v); };
      const timer = setTimeout(() => finish({ error: "the Codex app-server did not answer in 20 s" }), 20_000);
      /** @param {unknown} m */
      const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
      p.stdin.on("error", () => {});
      p.on("error", (e) => finish({ error: `the Codex app-server did not start (${e.message})` }));
      p.on("close", () => finish({ error: "the Codex app-server stopped before answering" }));
      p.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          let m;
          try { m = JSON.parse(l); } catch { continue; }
          if (m?.id === 1) {
            if (m.error) return finish({ error: `the Codex app-server refused to start a session (${String(m.error.message ?? "").slice(0, 200)})` });
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
          } else if (m?.id === 2) {
            return finish(m.error ? { error: `account/rateLimits/read failed (${String(m.error.message ?? "").slice(0, 200)})` } : { result: m.result });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "autocraft-task", title: null, version: HELPER_VERSION } } });
    });
    const r = /** @type {{ error?: string, result?: unknown }} */ (result);
    return { reading: r.error ? { at: now, error: r.error } : parseCodexRateLimits(r.result, models, now) };
  } finally {
    unlock();
  }
}

const usageFile = () => join(cacheDir(), "usage.json");

/**
 * The harness's plan usage: a reading of the last USAGE_REUSE_MS (shared by every helper process), or a new one; nothing
 * while the provider asked to wait.
 * @param {Config} cfg @param {Adapter} adapter @param {string} bin @param {string[]} models @returns {Promise<QuotaReading>}
 */
async function readQuota(cfg, adapter, bin, models) {
  const now = Date.now();
  /** @type {{ harness: string, models: string[], reading: QuotaReading, retryAt?: number } | null} */
  const cached = readJson(usageFile());
  const same = cached?.harness === adapter.id && JSON.stringify(cached.models) === JSON.stringify(models);
  if (same && cached.retryAt && now < cached.retryAt) return { at: now, error: `${"error" in cached.reading ? cached.reading.error : "the provider asked to wait"}; asking again after ${clock(cached.retryAt)}` };
  if (same && now - cached.reading.at < USAGE_REUSE_MS && now >= cached.reading.at) return cached.reading;
  /** @type {{ reading: QuotaReading, retryAt?: number }} */
  let r;
  if (adapter.id === "claude") {
    const token = adapter.token(cfg);
    r = token ? await claudeQuota(token, models) : { reading: { at: now, error: "no Claude login" } };
  } else r = await codexQuota(bin, codexHome(), models);
  writePrivate(usageFile(), { harness: adapter.id, models, reading: r.reading, ...(r.retryAt && { retryAt: r.retryAt }) });
  return r.reading;
}

/** The wire form of a reading: the most-used window of each kind. @param {QuotaReading | null} r @returns {UsageReading | undefined} */
export function usageOfReading(r) {
  if (!r || "error" in r) return undefined;
  /** @param {string} kind @returns {UsageWindow | null} */
  const top = (kind) => {
    const ws = r.windows.filter((w) => w.kind === kind && Number.isFinite(w.usedPercent)).sort((a, b) => b.usedPercent - a.usedPercent);
    return ws[0] ? { usedPercent: Math.min(100, Math.max(0, ws[0].usedPercent)), resetsAt: ws[0].resetsAt === null ? null : new Date(ws[0].resetsAt).toISOString() } : null;
  };
  return { fiveHour: top("five_hour"), weekly: top("weekly"), at: new Date(r.at).toISOString() };
}

// Control (config dir, the user's): the pause and the park. Status (cache): the last readiness, what the server last said.
const controlFile = () => join(configDir(), "control.json");
/** @returns {{ pause?: Pause, park?: Park }} */
const readControl = () => readJson(controlFile()) ?? {};
/** @param {{ pause?: Pause, park?: Park }} c */
const writeControl = (c) => writePrivate(controlFile(), c);
const helperStatusFile = () => join(cacheDir(), "status.json");

/**
 * The status file: the last readiness and its reading, the server's reserve, and when the server last got a status.
 * @typedef {object} StatusFile
 * @property {Readiness} [readiness]
 * @property {number | null} [until]
 * @property {string} [reason]
 * @property {UsageReading} [usage]
 * @property {Reserve} [reserve]  the effective reserve
 * @property {Reserve} [serverReserve]
 * @property {{ version: string, at: number, reason: string }} [refused]  the server refused this helper version
 * @property {{ until: number, reason: string }} [cooloff]  the server gives this token no calls until then (repeated lost leases)
 * @property {number} [at]
 * @property {number} [sentAt]
 * @property {string} [sentKey]
 * @property {HelperStatus} [sent]
 */
/** @returns {StatusFile} */
const readHelperStatus = () => readJson(helperStatusFile()) ?? {};
/** @param {(s: StatusFile) => StatusFile} f */
const updateHelperStatus = (f) => writePrivate(helperStatusFile(), f(readHelperStatus()));

/**
 * @typedef {object} Ready
 * @property {Readiness} readiness
 * @property {number | null} until
 * @property {string} [reason]
 * @property {Reserve} reserve
 * @property {QuotaReading | null} reading
 * @property {Adapter} [adapter]
 * @property {{ bin: string, version: string }} [detected]
 * @property {Partial<Record<Tier, string>>} models
 * @property {boolean} [quotaReady]  cooled off, but the usage would let it claim: the claim asks the server whether the cool-off still holds (an operator may end it)
 */

/**
 * Works out whether the helper may claim now, keeps it in the status file and reports it to the server when it changed or
 * the last report is STATUS_EVERY_MS old.
 * @param {Config} cfg @param {{ send?: boolean }} [opt] @returns {Promise<Ready>}
 */
async function checkReady(cfg, opt = {}) {
  const now = Date.now();
  const prev = readHelperStatus();
  const reserve = effectiveReserve(prev.serverReserve, cfg.reserve);
  /** @type {Ready} */
  let st;
  /** @type {Adapter | undefined} */
  let adapter;
  try { adapter = adapterOf(cfg); } catch { /* reported below */ }
  const models = adapter ? { ...adapter.defaultTiers, ...cfg.tiers } : { ...cfg.tiers };
  const base = { reserve, reading: null, models, ...(adapter && { adapter }) };
  const problem = platformProblem();
  if (prev.refused?.version === HELPER_VERSION && now - prev.refused.at < REFUSED_RETRY_MS) st = { ...base, readiness: "version-refused", until: null, reason: prev.refused.reason };
  else if (!adapter) st = { ...base, readiness: "harness-missing", until: null, reason: `no adapter for harness ${cfg.harness}` };
  else if (problem) st = { ...base, readiness: "sandbox-failed", until: null, reason: problem };
  else {
    const d = adapter.detect(cfg);
    const old = d.version ? adapter.unaudited?.(d.version) : null;
    let canary = null;
    try { requireCanary(); } catch (e) { canary = msg(e); }
    if (!d.bin || !d.version) st = { ...base, readiness: "harness-missing", until: null, reason: `${adapter.id} not found or not runnable` };
    else if (!d.loggedIn) st = { ...base, readiness: "harness-missing", until: null, reason: `no ${adapter.id} login: run \`autocraft-task harness ${adapter.id}\`` };
    else if (old) st = { ...base, readiness: "harness-missing", until: null, reason: old };
    else if (!Object.keys(models).length) st = { ...base, readiness: "harness-missing", until: null, reason: `no model is set for any tier ("tiers" in ${join(configDir(), "config.json")})` };
    else if (canary) st = { ...base, readiness: "sandbox-failed", until: null, reason: canary.split("\n")[0] ?? canary };
    else {
      const control = readControl();
      const cooloff = prev.cooloff && now < prev.cooloff.until && !(control.pause && (control.pause.until === null || now < control.pause.until)) ? prev.cooloff : null;
      // A pause needs no reading; without one the provider is asked only when the answer matters.
      const reading = control.pause && (control.pause.until === null || now < control.pause.until) ? null : await readQuota(cfg, adapter, d.bin, [...new Set(Object.values(models))]);
      const q = quotaReadiness({ pause: control.pause, park: control.park, verdict: quotaVerdict(reading, reserve, Date.now()), readingAt: reading && !("error" in reading) ? reading.at : null });
      if (q.dropPause || q.dropPark) {
        const c = readControl();
        if (q.dropPause) delete c.pause;
        if (q.dropPark) delete c.park;
        writeControl(c);
      }
      st = cooloff
        ? { ...base, readiness: "cooled-off", until: cooloff.until, reason: cooloff.reason, reading, detected: { bin: d.bin, version: d.version }, quotaReady: q.readiness === "ready" }
        : { ...base, readiness: q.readiness, until: q.until, ...(q.reason && { reason: q.reason }), reading, detected: { bin: d.bin, version: d.version } };
    }
  }
  const usage = usageOfReading(st.reading) ?? prev.usage;
  updateHelperStatus((s) => ({ ...s, readiness: st.readiness, until: st.until, reason: st.reason, reserve, at: now, ...(usage ? { usage } : {}) }));
  if (opt.send !== false) await sendStatus(cfg, adapter?.id ?? "claude", st, usage);
  return st;
}

/**
 * Reports a status to the server when it differs from the last one sent, or the last report is STATUS_EVERY_MS old; keeps
 * the user's reserve from the reply. A failed report is tried again with the next check.
 * @param {Config} cfg @param {HarnessId} harness @param {{ readiness: Readiness, until: number | null, reason?: string, reserve: Reserve, models: Partial<Record<Tier, string>> }} st @param {UsageReading | undefined} usage
 */
async function sendStatus(cfg, harness, st, usage) {
  if (!cfg.server || !cfg.agentToken) return;
  /** @type {HelperStatus} */
  const body = { readiness: st.readiness, ...(st.until !== null && { until: new Date(st.until).toISOString() }), ...(st.reason && { reason: redact(st.reason).slice(0, 300) }), harness, models: st.models, reserve: st.reserve, ...(usage && { usage }), slots: capacity.slots, busy: capacity.busy };
  const key = JSON.stringify({ ...body, usage: undefined });
  const prev = readHelperStatus();
  if (prev.sentKey === key && prev.sentAt !== undefined && Date.now() - prev.sentAt < STATUS_EVERY_MS) return;
  try {
    /** @type {StatusReply} */
    const r = await api(cfg.server, ROUTES.status, cfg.agentToken, body);
    updateHelperStatus((s) => ({ ...s, sentAt: Date.now(), sentKey: key, sent: body, ...(r?.reserve && { serverReserve: r.reserve }) }));
  } catch { /* the next check sends it again */ }
}

/** During a long run: the last status again once it is STATUS_EVERY_MS old, so the server knows the helper is alive. */
async function keepStatusFresh() {
  const cfg = loadConfig(), s = readHelperStatus();
  if (!cfg.server || !cfg.agentToken || !s.sent || (s.sentAt !== undefined && Date.now() - s.sentAt < STATUS_EVERY_MS)) return;
  try {
    await api(cfg.server, ROUTES.status, cfg.agentToken, s.sent);
    updateHelperStatus((x) => ({ ...x, sentAt: Date.now() }));
  } catch { /* next heartbeat */ }
}

/** One line for a readiness that is not `ready`. @param {{ readiness: Readiness, until: number | null, reason?: string }} st */
const heldLine = (st) => `${st.readiness}${st.reason ? `: ${st.reason}` : ""}${st.until !== null ? `; until ${clock(st.until)}` : ""}`;

const LIMIT_RE = /you(?:'|’)ve hit your (?:[a-z0-9-]+ )?limit|usage limit reached/i;
const UNIT_MS = /** @type {const} */ ({ d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 });

/** The offset of time zone `zone` from UTC at `ms`, in ms; null for an unknown zone. @param {number} ms @param {string} zone */
function zoneOffset(ms, zone) {
  let parts;
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms)); } catch { return null; }
  const n = (/** @type {string} */ t) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A provider's refusal for its usage limit in a failed run's error text, with the reset it names: an epoch
 * ("usage limit reached|1767225600"), a duration ("resets in 4h42m", "try again in 2 days 3 hours"), or a clock time with a
 * time zone ("resets 3pm (Europe/Berlin)", "resets Nov 21, 3:30pm (UTC)"), capped at PARK_CAP_MS. A clock time without a
 * zone is not trusted (`until` null); no stated time parks for PARK_FALLBACK_MS. Null when the text is no such refusal.
 * @param {string} text @param {number} [now] @returns {{ until: number | null, line: string } | null}
 */
export function parseRefusal(text, now = Date.now()) {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  const line = (text.slice(m.index).split("\n")[0] ?? "").trim().slice(0, 200);
  const cap = (/** @type {number} */ t) => Math.min(t, now + PARK_CAP_MS);
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch) {
    const t = timeOf(Number(epoch[1]));
    if (t !== null && t > now) return { until: cap(t + PARK_GRACE_MS), line };
  }
  const dur = /(?:resets?|try again)\s+in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (dur) {
    let ms = 0;
    for (const p of (dur[1] ?? "").matchAll(/(\d+)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)/gi)) ms += Number(p[1]) * UNIT_MS[/** @type {"d" | "h" | "m" | "s"} */ ((p[2] ?? "s")[0]?.toLowerCase() ?? "s")];
    if (ms > 0) return { until: cap(now + ms + PARK_GRACE_MS), line };
  }
  const at = /(?:resets?|try again at)\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i.exec(text)
    ?? /(?:resets?|try again at)\s+(?:at\s+)?()()()(\d{1,2}):(\d{2})()(?:\s*\(([^)]+)\))?/i.exec(text);
  if (at) {
    const zone = at[7];
    if (!zone || zoneOffset(now, zone) === null) return { until: null, line };
    let hour = Number(at[4]) % (at[6] ? 12 : 24);
    if (at[6]?.toLowerCase() === "p") hour += 12;
    const minute = Number(at[5] || 0);
    const off = /** @type {number} */ (zoneOffset(now, zone));
    const wall = new Date(now + off);
    const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : wall.getUTCMonth();
    if (month < 0) return { until: null, line };
    const day = at[2] ? Number(at[2]) : wall.getUTCDate();
    const year = at[3] ? Number(at[3]) : wall.getUTCFullYear();
    /** @param {number} addDays */
    const local = (addDays) => {
      const guess = Date.UTC(year, month, day + addDays, hour, minute);
      const o = zoneOffset(guess, zone) ?? 0;
      return guess - (zoneOffset(guess - o, zone) ?? o);
    };
    let t = local(0);
    if (t <= now && !at[1]) t = local(1);
    else if (t <= now && !at[3]) t = Date.UTC(year + 1, month, day, hour, minute) - off;
    if (t > now) return { until: cap(t + PARK_GRACE_MS), line };
    return { until: null, line };
  }
  return { until: now + PARK_FALLBACK_MS, line };
}

// ---------------------------------------------------------------------------
// Mounts.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** @param {string} cmd @param {string[]} args @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} */
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { if (stderr.length < 8000) stderr += d; });
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Extracts a tar stream into `dir` with tar. `feed` writes the stream and resolves when its producer
 * finished cleanly, so a failed producer never leaves a partial tree that looks complete.
 * @param {string} dir @param {(stdin: import("node:stream").Writable) => Promise<void>} feed
 */
async function untar(dir, feed) {
  const t = spawn("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  t.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
  t.stdin.on("error", () => {});
  const extracted = new Promise((resolve, reject) => {
    t.on("error", reject);
    t.on("close", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`tar: ${err.trim().slice(0, 300)}`))));
  });
  await Promise.all([feed(t.stdin), extracted]);
}

/** Builds a tree once: into a temporary directory, instruction files removed, then renamed into place. Reused while it exists. @param {string} dir @param {(tmp: string) => Promise<void>} fill */
async function cachedTree(dir, fill) {
  if (existsSync(dir)) { const t = new Date(); utimesSync(dir, t, t); return dir; }
  mkdirSync(dirname(dir), { recursive: true });
  const tmp = mkdtempSync(`${dir}.tmp-`);
  try {
    await fill(tmp);
    removeInstructionFiles(tmp);
    try { renameSync(tmp, dir); } catch (e) { if (!existsSync(dir)) throw e; }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();
/** Runs `fn` after every earlier call with the same key (one fetch per bare repo at a time). @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
function serial(key, fn) {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** A public repo at a commit, from GitHub through the bare-clone cache. @param {{ owner: string, repo: string, sha: string, ref?: string }} m */
async function gitTree(m) {
  if (!NAME.test(m.owner) || !NAME.test(m.repo) || !SHA.test(m.sha) || (m.ref !== undefined && (!REF.test(m.ref) || m.ref.includes("..")))) throw new Error(`bad git mount ${m.owner}/${m.repo}@${m.sha}`);
  const bare = join(cacheDir(), "git", m.owner, `${m.repo}.git`);
  const tree = join(cacheDir(), "trees", "git", m.owner, m.repo, m.sha);
  if (existsSync(tree)) return cachedTree(tree, async () => {});
  await serial(bare, async () => {
    if (!existsSync(join(bare, "HEAD"))) {
      mkdirSync(bare, { recursive: true });
      const init = await run("git", ["init", "--bare", "-q", bare]);
      if (init.code !== 0) throw new Error(`git init: ${init.stderr.trim()}`);
      await run("git", ["-C", bare, "remote", "add", "origin", `https://github.com/${m.owner}/${m.repo}.git`]);
    }
    const has = async () => (await run("git", ["-C", bare, "cat-file", "-e", `${m.sha}^{commit}`])).code === 0;
    if (await has()) return;
    const bySha = await run("git", ["-C", bare, "fetch", "-q", "--depth", "1", "origin", m.sha]);
    if (bySha.code !== 0 && m.ref) await run("git", ["-C", bare, "fetch", "-q", "--depth", "1", "origin", m.ref]);
    if (!(await has())) throw new Error(`could not fetch ${m.owner}/${m.repo}@${m.sha.slice(0, 12)}: ${bySha.stderr.trim().slice(0, 200)}`);
  });
  return cachedTree(tree, (tmp) => untar(tmp, (stdin) => new Promise((resolve, reject) => {
    const a = spawn("git", ["-C", bare, "archive", "--format=tar", m.sha], { env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
    a.stdout.pipe(stdin);
    a.on("error", reject);
    a.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${m.owner}/${m.repo}@${m.sha.slice(0, 12)} failed`))));
  })));
}

/**
 * A tree from the server's tarball route. A transient failure (5xx, reset, a stream cut off) starts the download again in a
 * fresh directory, until shortly before the preparation cap; `signal` ends it.
 * @param {string} server @param {string} secret @param {{ repo: string, sha: string }} m @param {AbortSignal} [signal]
 */
async function tarballTree(server, secret, m, signal) {
  if (!NAME.test(m.repo) || !SHA.test(m.sha)) throw new Error(`bad tarball mount ${m.repo}@${m.sha}`);
  const tree = join(cacheDir(), "trees", "tarball", m.repo, m.sha);
  const route = `${ROUTES.tarball}?repo=${encodeURIComponent(m.repo)}&sha=${m.sha}`;
  return withRetry(() => cachedTree(tree, async (tmp) => {
    const timeout = AbortSignal.timeout(10 * 60_000);
    const res = await fetch(`${server}${route}`, { headers: { Authorization: `Bearer ${secret}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (res.status === 410) throw new Gone("the lease is gone");
    if (!res.ok || !res.body) throw new HttpError(`tarball ${m.repo}`, res.status, res.ok ? "no body" : await res.text().catch(() => ""), retryAfterMs(res.headers.get("retry-after")));
    const body = /** @type {any} */ (res.body);
    await untar(tmp, (stdin) => pipeline(Readable.fromWeb(body), stdin));
  }), { deadline: Date.now() + PREPARE_MAX_S * 1000 - RETRY_MARGIN_MS, ...(signal && { signal }) });
}

/** Inline files into a fresh directory of the task. @param {string} dir @param {{ name: string, base64: string }[]} files */
function filesTree(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const parts = f.name.split("/");
    if (!f.name || f.name.startsWith("/") || parts.some((c) => c === "" || c === "." || c === "..")) throw new Error(`bad file name in bundle: ${f.name}`);
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), Buffer.from(f.base64, "base64"));
  }
  return dir;
}

/** @param {string} server @param {string} secret @param {TaskBundle} b @param {string} taskDir @param {AbortSignal} [signal] */
async function prepareMounts(server, secret, b, taskDir, signal) {
  return Promise.all(b.mounts.map(async (m, i) => {
    checkMountPath(m.path);
    const host = m.kind === "git" ? await gitTree(m) : m.kind === "tarball" ? await tarballTree(server, secret, m, signal) : m.kind === "files" ? filesTree(join(taskDir, "files", String(i)), m.files) : null;
    if (!host) throw new Error(`unknown mount kind ${/** @type {any} */ (m).kind}`);
    return { host, path: m.path };
  }));
}

// ---------------------------------------------------------------------------
// Platform.

/** Why model calls can't run here, or null. */
function platformProblem() {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? null : `sandbox-exec is missing (${SANDBOX_EXEC})`;
  if (process.platform !== "linux") return "autocraft-task runs model calls only on Linux, WSL and macOS: it confines the harness with bubblewrap or sandbox-exec.";
  if (!existsSync(BWRAP)) return `bubblewrap is missing (${BWRAP}); install the bubblewrap package.`;
  return null;
}

/** @param {Config} cfg */
function adapterOf(cfg) {
  const a = ADAPTERS[cfg.harness ?? "claude"];
  if (!a) throw new Error(`no adapter for harness ${cfg.harness}`);
  return a;
}

/** @param {Config} cfg */
function needLogin(cfg) {
  if (!cfg.server || !cfg.agentToken) throw new Error("not logged in: run `autocraft-task login <server-url>` with the agent token on stdin");
  return { server: cfg.server, agentToken: cfg.agentToken };
}

// ---------------------------------------------------------------------------
// Claiming and running.

/**
 * Claims one call when the helper is ready (checkReady); otherwise claims nothing and says why (`held`). On macOS the claim
 * names the path root of slot `slot` (a free one when not given), which the lease keeps, and offers only that slot's sessions.
 * A lease that comes back with a higher reserve than the one checked, which the usage no longer allows, is released.
 * @param {Config} cfg @param {number} [slot] @returns {Promise<ClaimReply | { held: Ready }>}
 */
async function claimOnce(cfg, slot) {
  const { server, agentToken } = needLogin(cfg);
  const ready = await checkReady(cfg);
  const cooled = ready.readiness === "cooled-off" && ready.quotaReady === true;
  if ((ready.readiness !== "ready" && !cooled) || !ready.adapter || !ready.detected) return { held: ready };
  const adapter = ready.adapter, d = ready.detected, tiers = ready.models;
  const mac = process.platform === "darwin";
  const n = mac ? slot ?? pickSlot(slotBase()) : undefined;
  const root = n === undefined ? undefined : slotRoot(slotBase(), n);
  /** @type {Claim} */
  const claim = { requestId: randomBytes(16).toString("hex"), protocol: PROTOCOL_VERSION, helperVersion: HELPER_VERSION, harness: adapter.id, harnessVersion: d.version, tiers, efforts: Object.fromEntries(Object.keys(tiers).map((t) => [t, adapter.maxEffort])), ...(cfg.repos && { repos: cfg.repos }), sessions: heldSessions(n), ...(root && { root }) };
  /** @type {ClaimReply} */
  let reply;
  try {
    // Retries resend the same request id, so a claim whose reply was lost gets its lease back instead of leaving it to expire.
    reply = await withRetry(() => api(server, ROUTES.claim, agentToken, claim), { tries: 5, deadline: Date.now() + Math.min(60, CLAIM_ID_TTL_S / 2) * 1000 });
  } catch (e) {
    // Another protocol version, or a helper older than the server accepts: nothing runs until the helper is updated.
    if (e instanceof HttpError && e.status === 409) {
      updateHelperStatus((s) => ({ ...s, refused: { version: HELPER_VERSION, at: Date.now(), reason: msg(e).slice(0, 300) } }));
      await checkReady(cfg);
    }
    throw e;
  }
  const raised = reply.reserve && JSON.stringify(effectiveReserve(reply.reserve, cfg.reserve)) !== JSON.stringify(ready.reserve);
  if (reply.reserve) updateHelperStatus((s) => ({ ...s, serverReserve: reply.reserve }));
  if (reply.lease) {
    /** @type {LeaseRecord} */
    const rec = { secret: reply.lease.secret, title: reply.lease.title, requiredHelper: reply.lease.requiredHelper, server, claimedAt: Date.now(), ...(root && { slot: n, root }) };
    writePrivate(leaseFile(reply.lease.id), rec);
    if (raised) {
      const again = await checkReady(cfg);
      if (again.readiness !== "ready") {
        /** @type {Release} */
        const body = { reason: `the user's usage reserve rose: ${heldLine(again)}`.slice(0, 300) };
        try { await withRetry(() => api(server, ROUTES.release, reply.lease.secret, body), { deadline: rec.claimedAt + LEASE_GRACE_MS - HEARTBEAT_S * 1000 }); } catch { /* the lease expires on its own */ }
        dropLease(reply.lease.id);
        return { held: again };
      }
    }
  } else if (reply.until !== undefined && reply.until > Date.now()) {
    // A cool-off: the helper says so in its readiness and asks again with each hold check (an operator may end it early).
    const until = reply.until;
    updateHelperStatus((s) => ({ ...s, cooloff: { until, reason: reply.reason ?? "the server gives this helper no calls for a while" } }));
    return { held: await checkReady(cfg) };
  }
  if (cooled) {
    updateHelperStatus(({ cooloff: _c, ...s }) => s);
    await checkReady(cfg);
  } else if (raised && !reply.lease) await checkReady(cfg);
  return reply;
}

/**
 * Runs one claimed lease to its end: heartbeats from the start, bundle, mounts, sandboxed harness, submit.
 * Returns the status line; never throws. `slotHeld`: the caller holds the lease's slot (macOS).
 * Anything that goes wrong before the harness spawns gives the call back (no attempt used); only a run's failure is
 * reported as `ok: false`. Every report is retried until shortly before the lease's deadline, and recorded as submitted,
 * failed or released only once the server accepted it.
 * @param {Config} cfg @param {number} id @param {{ signal?: AbortSignal, slotHeld?: boolean }} [opt]
 * @returns {Promise<RunStatus>}
 */
async function runLease(cfg, id, opt = {}) {
  const lease = readLease(id);
  /** @param {RunStatus["state"]} state @param {string} line @param {boolean} [stop] @returns {RunStatus} */
  const end = (state, line, stop = false) => { const s = { state, line: redact(line), at: Date.now(), ...(stop && { stop }) }; writeStatus(id, s); if (state !== "running") dropLease(id); return s; };
  if (!lease) return end("failed", `failed: no lease ${id} was claimed on this machine`);
  secretsInUse.add(lease.secret);
  writeStatus(id, { state: "running", line: `running: ${lease.title}`, pid: process.pid, at: Date.now() });
  const started = Date.now();
  const beat = heartbeats(lease);
  const prepareEnd = lease.claimedAt + PREPARE_MAX_S * 1000;
  // The preparation stops early enough that its release still has the full retry margin before the server's cap.
  const prepTimeout = AbortSignal.timeout(Math.max(1, prepareEnd - 2 * RETRY_MARGIN_MS - Date.now()));
  // Ends the preparation's requests: Ctrl-C, the lease gone, or the preparation cap.
  const prep = AbortSignal.any([beat.gone, prepTimeout, ...(opt.signal ? [opt.signal] : [])]);
  let timeoutSeconds = 0;
  // The server's deadline: the preparation cap, then the call's time limit from the first `running` heartbeat.
  const deadline = () => (beat.runStart === null ? prepareEnd : beat.runStart + timeoutSeconds * 1000 + LEASE_GRACE_MS) - RETRY_MARGIN_MS;
  /** @param {string} route @param {unknown} [body] @param {AbortSignal} [signal] */
  const call = (route, body, signal) => withRetry(() => api(lease.server, route, lease.secret, body, signal && { signal }), { deadline: deadline(), ...(signal && { signal }) });
  const lost = () => end("lost", `lost: ${lease.title}: the lease was withdrawn`);
  /** @param {string} what @param {unknown} e */
  const undelivered = (what, e) => (e instanceof Gone ? lost() : end("lost", `lost: ${lease.title}: ${what} did not reach the server: ${msg(e)}`));
  /** @param {string} error @param {Usage} [usage] */
  const fail = async (error, usage) => {
    /** @type {Submit} */
    const body = { ok: false, error: redact(error).slice(0, 2000), ...(usage && { usage }), durationMs: Date.now() - started };
    try { await call(ROUTES.submit, body); } catch (e) { return undelivered(`the failure (${error})`, e); }
    return end("failed", `failed: ${lease.title}: ${error}`);
  };
  /**
   * The helper's own fault, not the call's: the call goes back to the queue without using an attempt.
   * @param {string} reason @param {boolean} [stop] the helper can take no call until it is updated
   */
  const giveBack = async (reason, stop = false) => {
    /** @type {Release} */
    const body = { reason: redact(reason).slice(0, 300) };
    try { await call(ROUTES.release, body); } catch (e) { return undelivered(`the release (${reason})`, e); }
    return end("released", `released: ${lease.title}: ${reason}`, stop);
  };
  /** Why the preparation stopped, when one of its signals did. */
  const prepStopped = () => (opt.signal?.aborted ? "stopped on the helper" : prepTimeout.aborted ? `preparing took longer than ${(PREPARE_MAX_S * 1000 - 2 * RETRY_MARGIN_MS) / 60_000} min` : null);
  /** @type {string[]} */
  const tokens = [];
  let releaseSlot = () => {};
  let taskDir = "", unlock = () => {};
  try {
    if (compareVersions(HELPER_VERSION, lease.requiredHelper) < 0) return await giveBack(`helper ${HELPER_VERSION} is older than the required ${lease.requiredHelper}; download ${lease.server}${ROUTES.helper}`, true);
    const problem = platformProblem();
    if (problem) return await giveBack(problem, true);
    if (process.platform === "darwin") {
      if (lease.root === undefined || lease.slot === undefined) return await giveBack("the lease was claimed without a slot");
      if (!opt.slotHeld) {
        const r = takeSlot(slotBase(), lease.slot);
        if (!r) return await giveBack(`slot ${lease.slot} is busy with another run`);
        releaseSlot = r;
      }
    }
    try { prune(); } catch { /* best effort */ }
    const adapter = adapterOf(cfg);
    const d = adapter.detect(cfg);
    const token = adapter.token(cfg) ?? "";
    if (!d.bin || !token) return await giveBack(`${adapter.id} binary or token missing on the helper`, true);
    tokens.push(token); secretsInUse.add(token);
    if (adapter.exclusive) {
      const release = takeHarnessLock(adapter.id);
      if (!release) return await giveBack(`another ${adapter.id} call is running on this helper, and they share one login`);
      unlock = release;
    }
    const old = d.version && adapter.unaudited?.(d.version);
    if (old) return await giveBack(old, true);
    const unsafe = adapter.preflight?.(d.bin, token);
    if (unsafe) return await giveBack(unsafe, true);
    /** @type {TaskBundle} */
    const b = await call(ROUTES.bundle, undefined, prep);
    // A bundle of the wrong shape is the server's fault, the same for every helper: the call fails rather than circling.
    if (typeof b?.callId !== "number" || typeof b.stdin !== "string" || !Array.isArray(b.mounts) || !Array.isArray(b.mcpServers)) return await fail("unreadable bundle");
    timeoutSeconds = b.timeoutSeconds;
    const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
    if (!model) return await giveBack(`no ${adapter.id} model is set for the ${b.tier} tier ("tiers" in the config)`);
    let runToken = token;
    if (adapter.tokenFor) {
      const t = adapter.tokenFor(cfg, b.timeoutSeconds);
      if ("problem" in t) return await giveBack(t.problem);
      runToken = t.token;
    }
    tokens.push(runToken); secretsInUse.add(runToken);
    privateDir(join(cacheDir(), "tasks"));
    taskDir = mkdtempSync(join(cacheDir(), "tasks", `${b.callId}-`));
    const out = await execute(b, { adapter, bin: d.bin, token: runToken, model, taskDir, lease, root: lease.root ?? "", ...(lease.slot !== undefined && { slot: lease.slot }), ...(opt.signal && { signal: opt.signal }), prep, beat });
    if ("giveBack" in out) return await giveBack(prepStopped() ?? out.giveBack);
    if ("fail" in out) return await fail(out.fail, out.usage);
    const { r, reply, tools } = out;
    if (r.gone) return lost();
    if (r.timedOut) return await fail(`timed out after ${b.timeoutSeconds} s`, reply.usage);
    if (r.stopped) return await giveBack("stopped on the helper");
    if (!reply.ok) {
      // The provider's usage limit: the call goes back without using an attempt, and the helper parks until the reset.
      const refusal = parseRefusal(`${reply.error ?? ""}\n${r.stderr}`);
      if (refusal) {
        const c = readControl();
        writeControl({ ...c, park: { until: refusal.until, at: Date.now(), reason: `the provider refused a run: ${refusal.line}` } });
        try { await checkReady(cfg); } catch { /* reported with the next check */ }
        return await giveBack(`the provider refused the run for its usage limit: ${refusal.line}`);
      }
      return await fail(`${reply.error ?? "no result"} (exit ${r.code}) ${r.stderr.trim().slice(-300)}`.trim(), reply.usage);
    }
    const usage = reply.usage ?? { inputTokens: 0, outputTokens: 0 };
    /** @type {Submit} */
    const body = { ok: true, text: reply.text, model: reply.model, usage, ...(reply.modelUsage && { modelUsage: reply.modelUsage }), ...(reply.costUsd !== undefined && { costUsd: reply.costUsd }), ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.sessionId && { sessionId: reply.sessionId }), ...(tools.length > 0 && { tools }), durationMs: Date.now() - started };
    /** @type {SubmitReply} */
    let s;
    // A finished reply is never turned into a failure: the same body is retried until the server takes it or the lease ends.
    try { s = await call(ROUTES.submit, body); } catch (e) { return undelivered("the reply", e); }
    if (!s.accepted) return end("failed", `rejected: ${lease.title}: ${s.reason ?? "no reason given"}`);
    return end("submitted", `submitted: ${lease.title}, ${kTokens(tokensOf(usage))} tokens`);
  } catch (e) {
    if (e instanceof Gone || beat.gone.aborted) return lost();
    if (beat.runStart === null) return await giveBack(prepStopped() ?? `preparing failed: ${msg(e)}`);
    return await fail(msg(e));
  } finally {
    beat.stop();
    unlock();
    releaseSlot();
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(lease.secret);
    for (const t of tokens) secretsInUse.delete(t);
  }
}

/**
 * Runs one bundle in the sandbox: its files (in the slot on macOS), the session store, the file tools and the harness.
 * Private trees and MCP servers need the lease; `try` runs without one. With a lease, `prep` ends the preparation's requests
 * and `beat` carries its heartbeats; nothing spawns once either ended or `signal` aborted.
 * @param {TaskBundle} b
 * @param {{ adapter: Adapter, bin: string, token: string, model: string, taskDir: string, lease: LeaseRecord | null, root: string, slot?: number, signal?: AbortSignal, prep?: AbortSignal, beat?: ReturnType<typeof heartbeats> }} x
 * @returns {Promise<{ giveBack: string } | { fail: string, usage?: Usage } | { r: Awaited<ReturnType<typeof harness>>, reply: Reply, tools: SubmitTool[] }>}
 */
async function execute(b, x) {
  const { adapter } = x;
  const server = x.lease?.server ?? "", secret = x.lease?.secret ?? "";
  let mounts;
  try { mounts = await prepareMounts(server, secret, b, x.taskDir, x.prep); } catch (e) {
    if (e instanceof Gone || x.prep?.aborted) throw e;
    return { giveBack: `setting up the files failed: ${msg(e)}` };
  }
  for (const n of b.mcpServers) if (!NAME.test(n)) return { fail: `bad MCP server name ${n}` };
  const mcp = b.mcpServers.length ? JSON.stringify(mcpConfig(server, b.mcpServers, secret)) : "";
  // Session store: a follow-up continues its parent's; a call whose arguments keep the session gets a new one.
  let sessionDir, resumeId;
  if (b.resume) {
    const parent = readSession(b.resume.parentCallId);
    if (!parent || parent.slot !== x.slot) return { fail: `the session of call ${b.resume.parentCallId} is no longer held by this helper${parent ? " in this slot" : ""}` };
    sessionDir = parent.dir; resumeId = parent.sessionId;
  } else if (b.keepSession) {
    privateDir(sessionsDir());
    sessionDir = mkdtempSync(join(sessionsDir(), "store-"));
  }
  let mcpFile = "";
  /** @type {AdapterTask["mac"]} */
  let mac;
  if (x.root) {
    const hint = b.hints.claude;
    const plan = slotPlan(x.root, mounts, argValues(hint?.args ?? [], "--add-dir"));
    await fillSlot(x.root, plan, [...(mcp ? [{ name: "mcp.json", content: mcp }] : []), ...(adapter.id === "claude" && hint?.agents !== undefined ? [{ name: "agents.json", content: hint.agents }] : [])]);
    mounts = plan.mounts;
    if (mcp) mcpFile = `${x.root}/mcp.json`;
    const install = adapter.install(x.bin);
    const writes = [...(sessionDir ? [realpathSync(sessionDir)] : []), ...(adapter.id === "codex" ? [realpathSync(x.token)] : [])];
    const profile = join(x.taskDir, "profile.sb");
    writeFileSync(profile, macProfile({ deny: macDenied(realpathSync(homedir())), files: install.files, dirs: install.dirs, writes }), { mode: 0o600 });
    mac = { root: x.root, profile, install };
  } else if (mcp) {
    mcpFile = join(x.taskDir, "mcp.json");
    writeFileSync(mcpFile, mcp, { mode: 0o600 });
  }
  let files = /** @type {{ url: string, token: string, close: () => void } | null} */ (null);
  try {
    if (adapter.fileTools) files = await serveFileTools(mounts);
    if (x.beat?.gone.aborted || x.prep?.aborted || x.signal?.aborted) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      throw x.beat?.gone.aborted ? new Gone("the lease is gone") : new Error("stopped before the run");
    }
    const c = adapter.command({ bundle: b, model: x.model, bin: x.bin, token: x.token, mounts, taskDir: x.taskDir, mcpFile, sessionDir, resumeId, lease: { server, secret }, ...(files && { files: { url: files.url, token: files.token } }), ...(mac && { mac }) });
    const r = await harness(c, b, x.beat ?? null, x.signal, adapter, x.root);
    const reply = adapter.parse(r.stdout, x.model);
    if (r.gone) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      return { r, reply, tools: [] };
    }
    // A tool the call may not use: the reply never leaves this machine, and the session is not kept. Codex's rollout is in
    // its home (the helper's own, on macOS too), which `token` names.
    /** @type {{ problem: string | null, tools?: SubmitTool[] } | undefined} */
    const checked = r.unexpected ? { problem: r.unexpected } : adapter.verify?.({ token: x.token, sessionId: reply.sessionId, servers: b.mcpServers, keep: !!sessionDir });
    const tools = checked?.tools ?? adapter.tools?.(r.stdout, r.stamps) ?? [];
    if (checked?.problem) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      return { fail: checked.problem, ...(reply.usage && { usage: reply.usage }) };
    }
    if (sessionDir && reply.sessionId) writePrivate(join(sessionsDir(), `${b.callId}.json`), { sessionId: reply.sessionId, dir: sessionDir, at: Date.now(), ...(x.slot !== undefined && { slot: x.slot }) });
    else if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
    return { r, reply, tools };
  } finally {
    files?.close();
  }
}

/**
 * Runs the sandboxed harness: stdin in, stopped at the bundle's timeout, when the lease is gone or when `signal` aborts.
 * With a lease, the spawn moves its heartbeats to `running` (the time limit counts from there, here and on the server)
 * and they carry the last progress line. Progress lines name paths without the slot's root.
 * @param {{ cmd: string, args: string[], env: Record<string, string>, cwd?: string }} c @param {TaskBundle} b @param {ReturnType<typeof heartbeats> | null} beat @param {AbortSignal | undefined} signal @param {Adapter} adapter @param {string} root
 */
function harness(c, b, beat, signal, adapter, root) {
  return new Promise((resolve) => {
    const p = spawn(c.cmd, c.args, { env: c.env, stdio: ["pipe", "pipe", "pipe"], ...(c.cwd && { cwd: c.cwd }) });
    beat?.running();
    let stdout = "", stderr = "", partial = "", gone = false, timedOut = false, stopped = false, settled = false;
    /** @type {string[]} arrival time of each complete stdout line */
    const stamps = [];
    /** @type {string | undefined} */
    let unexpected;
    const kill = () => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 5000).unref(); };
    p.stdout.on("data", (d) => {
      stdout += d;
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      const at = new Date().toISOString();
      for (const l of lines) {
        stamps.push(at);
        const x = adapter.progress(root ? l.split(root).join("") : l);
        if (x) beat?.progress(x);
        const bad = !unexpected && adapter.guard?.(l, b.mcpServers);
        if (bad) { unexpected = bad; kill(); }
      }
    });
    p.stderr.on("data", (d) => { if (stderr.length < 16_000) stderr += d; });
    p.stdin.on("error", () => {});
    p.stdin.end(b.stdin);
    const timer = setTimeout(() => { timedOut = true; kill(); }, b.timeoutSeconds * 1000);
    const onAbort = () => { stopped = true; kill(); };
    const onGone = () => { gone = true; kill(); };
    signal?.addEventListener("abort", onAbort);
    beat?.gone.addEventListener("abort", onGone);
    /** @param {number | null} code */
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort); beat?.gone.removeEventListener("abort", onGone);
      resolve({ code, stdout, stamps, stderr: redact(stderr), gone, timedOut, stopped, unexpected });
    };
    p.on("error", (e) => { stderr += String(e); done(-1); });
    p.on("close", done);
  });
}

// ---------------------------------------------------------------------------
// Commands.

/** Reads one secret from stdin; on a terminal the input is not echoed. @param {string} prompt @returns {Promise<string>} */
async function readSecret(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let s = "";
    for await (const chunk of stdin) s += chunk;
    return s.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let s = "";
    /** @param {string} d */
    const on = (d) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", on); process.stderr.write("\n"); resolve(s.trim()); return; }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on("data", on);
  });
}

/** @param {string} url */
function serverUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("the server URL must be https (http only for localhost)");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** @param {string[]} argv */
async function cmdLogin(argv) {
  if (!argv[0]) throw new Error("usage: autocraft-task login <server-url>  (agent token on stdin)");
  const server = serverUrl(argv[0]);
  const token = await readSecret("Agent token: ");
  if (!token || /\s/.test(token)) throw new Error("no agent token on stdin");
  saveConfig({ ...loadConfig(), server, agentToken: token });
  console.log(`logged in to ${server}`);
}

/** @param {string[]} argv */
async function cmdHarness(argv) {
  const id = argv[0];
  if (id === "codex") return codexLogin(argv.slice(1));
  if (id !== "claude") throw new Error("usage: autocraft-task harness claude [--keychain]  (a `claude setup-token` token on stdin)\n       autocraft-task harness claude --config-dir [<dir>]\n       autocraft-task harness codex [--device-auth]");
  const { claudeToken: _t, claudeConfigDir: _d, claudeAuth: _a, claudeKeychain: _k, ...rest } = loadConfig();
  if (argv.includes("--keychain")) {
    // macOS: the access token of the user's own Claude Code login, read from the Keychain before each call.
    if (process.platform !== "darwin") throw new Error("--keychain reads Claude Code's login from the macOS Keychain; elsewhere use --config-dir or a setup-token");
    const item = claudeKeychainItem();
    if (!keychainCredential()) throw new Error(`no Claude Code login in the Keychain item "${item.service}" (account ${item.account}): sign in to Claude Code first`);
    // The item is recorded now: a later shell with another CLAUDE_CONFIG_DIR must not switch to a different login.
    saveConfig({ ...rest, harness: "claude", claudeAuth: "keychain", claudeKeychain: item });
    console.log(`the helper reads the Claude login from the Keychain item "${item.service}" before each call; it never refreshes it, so use Claude Code now and then, or store a setup-token instead`);
    return;
  }
  const at = argv.indexOf("--config-dir");
  if (at >= 0) {
    if (process.platform === "darwin") throw new Error(CLAUDE_CONFIG_DIR_MACOS);
    const given = argv[at + 1];
    const dir = resolve(given && !given.startsWith("-") ? given : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const o = readClaudeCredentials(dir)?.claudeAiOauth;
    if (typeof o?.accessToken !== "string" || typeof o.expiresAt !== "number") throw new Error(`no Claude login in ${dir}/.credentials.json: run claude with CLAUDE_CONFIG_DIR=${dir} and log in`);
    saveConfig({ ...rest, harness: "claude", claudeConfigDir: dir });
    const d = claudeAdapter.detect(loadConfig());
    console.log(`using the Claude login in ${dir} (its access token is valid for ${Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000))} more minutes; claude refreshes it whenever it runs)${d.bin ? `; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "; claude was not found on PATH"}`);
    return;
  }
  const token = await readSecret("Claude token (from `claude setup-token`): ");
  if (!token || /\s/.test(token)) throw new Error("no token on stdin");
  saveConfig({ ...rest, harness: "claude", claudeToken: token });
  const d = claudeAdapter.detect(loadConfig());
  console.log(d.bin ? `stored the Claude token; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "stored the Claude token; claude was not found on PATH");
}

/**
 * Logs Codex in to the helper's own CODEX_HOME, a login separate from the user's ~/.codex with its own refresh token,
 * so the helper's refreshes never invalidate the user's session. `--device-auth` for a machine without a browser.
 * @param {string[]} argv
 */
async function codexLogin(argv) {
  const extra = argv.filter((a) => a === "--device-auth");
  const bin = resolveCodexBin(loadConfig());
  if (!bin) throw new Error("codex was not found on PATH (or set codexBin in the config)");
  privateDir(codexHome());
  const r = spawnSync(bin, ["-c", 'cli_auth_credentials_store="file"', "login", ...extra], { stdio: "inherit", env: { ...process.env, CODEX_HOME: codexHome() } });
  if (r.status !== 0) throw new Error(`codex login failed (exit ${r.status})`);
  saveConfig({ ...loadConfig(), harness: "codex" });
  const tiers = loadConfig().tiers ?? {};
  console.log(`logged Codex in for the helper (its own login in ${codexHome()}); harness set to codex${Object.keys(tiers).length ? "" : `. Set "tiers" in ${join(configDir(), "config.json")}: the Codex model id for top, mid and small`}`);
}

async function cmdClaim() {
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  const r = await claimOnce(loadConfig());
  if ("held" in r) { console.log(`not claiming: ${heldLine(r.held)}`); return null; }
  if (!r.lease) { console.log(r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; claim again in ${r.retryAfter} s`); return null; }
  console.log(`lease ${r.lease.id}: ${r.lease.title}`);
  return r.lease.id;
}

/** @param {string} id */
function leaseId(id) {
  if (!/^\d+$/.test(id ?? "")) throw new Error(`not a lease id: ${id}`);
  return Number(id);
}

/** @param {string[]} argv */
async function cmdRun(argv) {
  const detach = argv.includes("--detach");
  const pos = argv.filter((a) => !a.startsWith("--"));
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  const cfg = loadConfig();
  requireCanary();
  let id;
  // macOS: a run in this process holds its slot from the claim to the end; a detached run's child takes it.
  const held = !pos[0] && !detach && process.platform === "darwin" ? holdSlot(slotBase()) : null;
  try {
    if (pos[0]) id = leaseId(pos[0]);
    else {
      const r = await claimOnce(cfg, held?.n);
      if ("held" in r) { console.log(`not claiming: ${heldLine(r.held)}`); return 0; }
      if (!r.lease) { console.log(r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; try again in ${r.retryAfter} s`); return 0; }
      id = r.lease.id;
    }
    return await runOrDetach(cfg, id, detach, held !== null);
  } finally {
    held?.release();
  }
}

/** @param {Config} cfg @param {number} id @param {boolean} detach @param {boolean} slotHeld */
async function runOrDetach(cfg, id, detach, slotHeld) {
  const lease = readLease(id);
  if (!lease) throw new Error(`no lease ${id} was claimed on this machine`);
  if (detach) {
    mkdirSync(join(cacheDir(), "runs"), { recursive: true });
    const log = openSync(join(cacheDir(), "runs", `${id}.log`), "a", 0o600);
    writeStatus(id, { state: "running", line: `running: ${lease.title}`, at: Date.now() });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", String(id)], { detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    writeStatus(id, { state: "running", line: `running: ${lease.title}`, pid: child.pid, at: Date.now() });
    child.unref();
    console.log(`started lease ${id}: ${lease.title}; wait with: autocraft-task wait ${id}`);
    return 0;
  }
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  process.once("SIGTERM", () => ac.abort());
  const s = await runLease(cfg, id, { signal: ac.signal, slotHeld });
  console.log(s.line);
  return s.state === "submitted" ? 0 : 1;
}

/** @param {string[]} argv */
async function cmdWait(argv) {
  const id = leaseId(argv[0]);
  const until = Date.now() + WAIT_MS;
  for (;;) {
    /** @type {RunStatus | null} */
    const s = readJson(statusFile(id));
    if (!s) { console.log(`no run of lease ${id} on this machine`); return 1; }
    if (s.state !== "running") { console.log(s.line); return s.state === "submitted" ? 0 : 1; }
    if (s.pid && !alive(s.pid)) { console.log(`failed: the helper process of lease ${id} stopped`); return 1; }
    if (Date.now() >= until) { console.log(`${s.line}; still running, wait again: autocraft-task wait ${id}`); return 3; }
    await sleep(1000);
  }
}

/** @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/** Takes the helper-wide lock of one harness (a lock file naming a live process); the release function, or null when another process holds it. @param {string} id */
function takeHarnessLock(id) {
  privateDir(configDir());
  const file = join(configDir(), `${id}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch {
      const pid = Number.parseInt((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })(), 10);
      if (pid > 0 && alive(pid)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** @param {string[]} argv */
async function cmdWork(argv) {
  const i = argv.indexOf("--parallel");
  const n = i >= 0 ? Number(argv[i + 1]) : 1;
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--parallel takes a number from 1 to 16");
  const exclusive = adapterOf(loadConfig());
  if (exclusive.exclusive && n > 1) throw new Error(`${exclusive.id} runs one call at a time: its login refreshes in place and must not be shared by parallel calls`);
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  requireCanary();
  const ac = new AbortController();
  process.on("SIGINT", () => { if (ac.signal.aborted) process.exit(130); console.log("stopping: running calls are stopped and reported; press Ctrl-C again to quit at once"); ac.abort(); });
  let idleSaid = "", heldSaid = "";
  /** @param {number} ms */
  const pause = (ms) => sleep(ms, undefined, { signal: ac.signal }).catch(() => {});
  const loop = async () => {
    // macOS: each loop holds one slot for its lifetime, so its claims name that slot's root and sessions.
    const held = process.platform === "darwin" ? holdSlot(slotBase()) : null;
    try { await claimLoop(held?.n); } finally { held?.release(); }
  };
  /** @param {number | undefined} slot */
  const claimLoop = async (slot) => {
    while (!ac.signal.aborted) {
      let r;
      try { r = await claimOnce(loadConfig(), slot); } catch (e) { console.log(`claim failed: ${msg(e)}; retrying in 60 s`); await pause(60_000); continue; }
      if ("held" in r) {
        // An external wait on this machine: the usage is read again every minute, and the status kept fresh.
        const line = heldLine(r.held);
        if (line !== heldSaid) { console.log(`not claiming: ${line}`); heldSaid = line; idleSaid = ""; }
        await pause(HOLD_RETRY_MS);
        continue;
      }
      if (heldSaid) { console.log("ready again"); heldSaid = ""; }
      if (!r.lease) {
        const say = r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; claiming again in ${r.retryAfter} s`;
        if (idleSaid !== say) { console.log(say); idleSaid = say; }
        await pause(Math.max(1, r.retryAfter) * 1000);
        continue;
      }
      idleSaid = "";
      console.log(`lease ${r.lease.id}: ${r.lease.title}`);
      const s = await runLease(loadConfig(), r.lease.id, { signal: ac.signal, slotHeld: slot !== undefined });
      console.log(s.line);
      if (s.stop) { console.log("stopping: this helper can take no call until that is fixed"); ac.abort(); }
      // A released call goes back to the queue; claiming at once would likely hand it straight back.
      else if (s.state === "released") await pause(60_000);
    }
  };
  await Promise.all(Array.from({ length: n }, loop));
  return 0;
}

/** Prints whether the helper takes calls now, with the usage, reserve and pause behind it. */
async function cmdStatus() {
  const cfg = loadConfig();
  const st = await checkReady(cfg);
  const s = readHelperStatus(), c = readControl();
  console.log(st.readiness === "ready" ? "ready: claims calls" : heldLine(st));
  const u = s.usage;
  /** @param {string} name @param {UsageWindow | null | undefined} w */
  const win = (name, w) => (w ? `${name} ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${clock(Date.parse(w.resetsAt))}` : ""}` : `${name} not reported`);
  if (u) console.log(`usage: ${win("5-hour", u.fiveHour)}; ${win("weekly", u.weekly)} (read ${clock(Date.parse(u.at))})`);
  const server = s.serverReserve;
  console.log(`reserve kept free: 5-hour ${st.reserve.fiveHour}%, weekly ${st.reserve.weekly}% (server ${server ? `${server.fiveHour}%/${server.weekly}%` : "not heard yet, default 20%/20%"}${cfg.reserve ? `, local ${cfg.reserve.fiveHour}%/${cfg.reserve.weekly}%` : ""})`);
  if (c.pause) console.log(`paused ${c.pause.until === null ? "until `autocraft-task resume`" : `until ${clock(c.pause.until)}`}`);
  if (c.park) console.log(`held after a refusal ${c.park.until === null ? "until a usage reading shows headroom" : `until ${clock(c.park.until)}`}: ${c.park.reason}`);
  console.log(`status file: ${helperStatusFile()}`);
  return st.readiness === "ready" ? 0 : 3;
}

/** Pauses the helper until the reset of the window that holds it (the 5-hour window when none does), or until `resume` when no reset is known. */
async function cmdPause() {
  const cfg = loadConfig();
  const st = await checkReady(cfg, { send: false });
  const r = st.reading;
  const fiveHour = r && !("error" in r) ? r.windows.filter((w) => w.kind === "five_hour" && w.resetsAt !== null).map((w) => /** @type {number} */ (w.resetsAt)).sort((a, b) => b - a)[0] : undefined;
  const until = st.readiness === "quota-held" && st.until !== null ? st.until : st.readiness === "paused" ? (readControl().pause?.until ?? null) : fiveHour ?? null;
  writeControl({ ...readControl(), pause: { until, at: Date.now() } });
  await checkReady(cfg);
  console.log(until === null ? "paused until `autocraft-task resume` (no reset time is known)" : `paused until ${clock(until)}, or \`autocraft-task resume\``);
}

/** Ends a pause, and a hold after a provider's refusal; the usage still decides. */
async function cmdResume() {
  const { pause: _p, park: _k, ...rest } = readControl();
  writeControl(rest);
  const st = await checkReady(loadConfig());
  console.log(st.readiness === "ready" ? "resumed: ready" : `resumed; ${heldLine(st)}`);
}

/** @param {string[]} argv */
async function cmdConfig(argv) {
  if (argv[0] !== "reserve") throw new Error("usage: autocraft-task config reserve <5h> <weekly> | off");
  const { reserve: _r, ...rest } = loadConfig();
  if (argv[1] === "off") { saveConfig(rest); console.log("the server's reserve applies"); return; }
  const n = argv.slice(1, 3).map((v) => (/^\d{1,3}$/.test(v ?? "") ? Number(v) : NaN));
  if (n.length !== 2 || !n.every((v) => v >= 0 && v <= 100)) throw new Error("usage: autocraft-task config reserve <5h> <weekly>  (percent of each window kept free, 0 to 100), or off");
  const local = { fiveHour: /** @type {number} */ (n[0]), weekly: /** @type {number} */ (n[1]) };
  saveConfig({ ...rest, reserve: local });
  const server = readHelperStatus().serverReserve;
  const eff = effectiveReserve(server, local);
  console.log(`reserve kept free: 5-hour ${eff.fiveHour}%, weekly ${eff.weekly}%${eff.fiveHour > local.fiveHour || eff.weekly > local.weekly ? ` (the server's ${server ? `${server.fiveHour}%/${server.weekly}%` : "default 20%/20%"} is higher where the local value is lower: a local reserve only raises it)` : ""}`);
}

/**
 * Runs a bundle from a file in the sandbox without a server and prints the reply: for testing the sandbox and a harness.
 * Its mounts must be git or files mounts and it may name no MCP servers. On macOS it runs in slot `--slot` (0), and the
 * bundle's paths must already be below that slot's root (scripts/remote-bundle.ts --root).
 * @param {string[]} argv
 */
async function cmdTry(argv) {
  const i = argv.indexOf("--slot");
  const file = argv.find((a, k) => !a.startsWith("--") && argv[k - 1] !== "--slot");
  if (!file) throw new Error("usage: autocraft-task try <bundle.json> [--slot N]");
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  requireCanary();
  /** @type {TaskBundle} */
  const b = JSON.parse(readFileSync(file, "utf8"));
  if (b.mcpServers?.length) throw new Error("try runs without a server: the bundle may name no MCP servers");
  const cfg = loadConfig();
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  const t = adapter.tokenFor ? adapter.tokenFor(cfg, b.timeoutSeconds) : { token: adapter.token(cfg) ?? "" };
  if ("problem" in t) throw new Error(t.problem);
  const token = t.token;
  if (!d.bin || !token) throw new Error(`${adapter.id} binary or login missing`);
  const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
  if (!model) throw new Error(`no ${adapter.id} model is set for the ${b.tier} tier`);
  const mac = process.platform === "darwin";
  const held = mac ? (() => { const n = i >= 0 ? Number(argv[i + 1]) : 0; const r = Number.isInteger(n) ? takeSlot(slotBase(), n) : null; if (!r) throw new Error(`slot ${argv[i + 1] ?? 0} is busy or not a slot number`); return { n, release: r }; })() : null;
  const root = held ? slotRoot(slotBase(), held.n) : "";
  if (root && !JSON.stringify(b.hints).includes(root)) console.error(`warning: the bundle's arguments do not name ${root}; build it with --root ${root}`);
  privateDir(join(cacheDir(), "tasks"));
  const taskDir = mkdtempSync(join(cacheDir(), "tasks", "try-"));
  secretsInUse.add(token);
  try {
    const out = await execute({ ...b, callId: 0, resume: undefined }, { adapter, bin: d.bin, token, model, taskDir, lease: null, root, ...(held && { slot: held.n }) });
    if ("giveBack" in out || "fail" in out) { console.log(JSON.stringify(out)); return 1; }
    console.log(redact(JSON.stringify({ exit: out.r.code, timedOut: out.r.timedOut, ...out.reply, tools: out.tools.length, stderr: out.r.stderr.trim().slice(-2000) }, null, 2)));
    return out.reply.ok ? 0 : 1;
  } finally {
    held?.release();
    rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(token);
  }
}

async function cmdDoctor() {
  let bad = 0;
  /** @param {boolean} ok @param {string} line */
  const check = (ok, line) => { console.log(`${ok ? "ok  " : "FAIL"} ${line}`); if (!ok) bad++; };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `node ${process.versions.node}${major >= 22 ? "" : " (22 or later needed)"}`);
  const problem = platformProblem();
  const mac = process.platform === "darwin";
  check(!problem, problem ?? (mac ? `platform darwin, sandbox-exec at ${SANDBOX_EXEC}` : `platform ${process.platform}, bubblewrap at ${BWRAP}`));
  if (problem) return 1;
  if (mac) {
    canaryResult = macCanary();
    check(canaryResult.ok, canaryResult.ok ? `the sandbox canary passed; slot 0 is ${slotRoot(slotBase(), 0)}` : "the sandbox canary failed: no call will be claimed");
    for (const l of canaryResult.lines) console.log(`       ${l}`);
  } else {
    const ns = spawnSync(BWRAP, ["--unshare-all", "--share-net", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { encoding: "utf8", timeout: 20_000 });
    check(ns.status === 0, ns.status === 0 ? "a sandbox starts" : `a sandbox does not start: ${(ns.stderr || "").trim().slice(0, 200)}`);
  }
  for (const tool of ["git", "tar"]) { const r = spawnSync(tool, ["--version"], { encoding: "utf8" }); check(r.status === 0, r.status === 0 ? `${tool} found` : `${tool} not found`); }
  const cfg = loadConfig();
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  check(!!d.bin && !!d.version, d.bin ? `${adapter.id} ${d.version ?? "(no version)"} at ${d.bin}` : `${adapter.id} not found on PATH`);
  if (d.version && adapter.unaudited) { const old = adapter.unaudited(d.version); check(!old, old ?? `${adapter.id} ${d.version} is an audited version`); }
  if (d.bin) {
    const c = mac ? macVersion(adapter, d.bin) : adapter.versionInSandbox(d.bin);
    const r = spawnSync(c.cmd, c.args, { env: c.env, encoding: "utf8", timeout: 30_000, ...("cwd" in c && { cwd: c.cwd }) });
    check(r.status === 0, r.status === 0 ? `${adapter.id} runs inside the sandbox` : `${adapter.id} does not run inside the sandbox: ${redact((r.stderr || "").trim()).slice(0, 200)}`);
  }
  if (adapter.id === "claude" && cfg.claudeAuth === "keychain") {
    const item = keychainItemOf(cfg), k = keychainCredential(item);
    const left = k?.expiresAt ? Math.round((k.expiresAt - Date.now()) / 60_000) : null;
    check(!!k && (left === null || left > 0), k ? `claude login from the Keychain (${item.service}), access token ${left === null ? "without an expiry" : left > 0 ? `valid for ${left} min` : "expired: use Claude Code once to refresh it"}` : `no Claude login in the Keychain item "${item.service}" (account ${item.account}): sign in to Claude Code, or store a setup-token`);
  } else if (adapter.id === "claude" && cfg.claudeConfigDir && mac) check(false, CLAUDE_CONFIG_DIR_MACOS);
  else {
    check(d.loggedIn, d.loggedIn ? `${adapter.id} login stored` : `no ${adapter.id} login: run \`autocraft-task harness ${adapter.id}\``);
    if (adapter.id === "claude" && cfg.claudeConfigDir && d.loggedIn) {
      const t = claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), 0);
      check("token" in t, "token" in t ? `uses the Claude login in ${cfg.claudeConfigDir}` : t.problem);
    }
  }
  if (adapter.id === "codex" && d.bin && d.loggedIn) {
    const r = spawnSync(d.bin, ["login", "status"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: codexHome() } });
    check(r.status === 0, r.status === 0 ? `codex: ${(r.stderr || r.stdout).trim().split("\n")[0]}` : "codex login status: not logged in; run `autocraft-task harness codex`");
  }
  check(!!cfg.server && !!cfg.agentToken, cfg.server ? `server ${cfg.server}${cfg.agentToken ? ", agent token stored" : ", no agent token"}` : "not logged in: run `autocraft-task login <server-url>`");
  if (cfg.server) {
    try {
      const res = await fetch(`${cfg.server}${ROUTES.helper}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      check(res.ok, res.ok ? "server reachable" : `server answered HTTP ${res.status}`);
    } catch (e) { check(false, `server unreachable: ${msg(e)}`); }
  }
  const tiers = Object.entries({ ...adapter.defaultTiers, ...cfg.tiers });
  check(tiers.length > 0, tiers.length ? `tiers: ${tiers.map(([t, m]) => `${t}=${m}`).join(", ")}` : `no tiers set: add "tiers" with ${adapter.id} model ids to the config`);
  return bad ? 1 : 0;
}

/**
 * The harness's version command inside the macOS profile, in a scratch slot.
 * @param {Adapter} adapter @param {string} bin
 */
function macVersion(adapter, bin) {
  const root = scratchSlot("doctor");
  const install = adapter.install(bin);
  const profile = `${root}.sb`;
  const codex = adapter.id === "codex" && existsSync(codexHome());
  writeFileSync(profile, macProfile({ deny: macDenied(realpathSync(homedir())), files: install.files, dirs: install.dirs, ...(codex && { writes: [realpathSync(codexHome())] }) }), { mode: 0o600 });
  return macCommand({ profile, root, argv: [...install.argv, "--version"], env: adapter.id === "codex" ? { CODEX_HOME: codexHome() } : { CLAUDE_CONFIG_DIR: `${root}/tmp/home/.claude`, DISABLE_AUTOUPDATER: "1" } });
}

/**
 * Proxies stdio MCP (one JSON-RPC message per line) to the lease's streamable HTTP server `name`.
 * The secret comes from the lease store, or from AUTOCRAFT_TASK_LEASE_SECRET and AUTOCRAFT_TASK_SERVER inside a sandbox.
 * @param {string[]} argv
 */
async function cmdMcp(argv) {
  const [name, id] = argv;
  if (!name || !NAME.test(name) || !id) throw new Error("usage: autocraft-task mcp <server-name> <lease>");
  const { secret, server } = leaseAccess(id);
  const url = `${server}${ROUTES.mcp}/${name}`;
  let session = "", version = "";
  /** @param {unknown} m */
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @param {string} line */
  const forward = async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    try {
      // Retried until the server answers with a status that is not transient; a reply's body, once read, is not.
      const res = await withRetry(async () => {
        const res = await fetch(url, { method: "POST", body: line, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session && { "Mcp-Session-Id": session }), ...(version && { "MCP-Protocol-Version": version }) } });
        if (res.status === 410) throw new Gone("the lease is gone");
        if (!res.ok && res.status !== 202) throw new HttpError(`${ROUTES.mcp}/${name}`, res.status, await res.text().catch(() => ""), retryAfterMs(res.headers.get("retry-after")));
        return res;
      }, { deadline: Date.now() + TOOL_RETRY_MS });
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      if (res.status === 202) return;
      /** @param {any} x */
      const emit = (x) => { if (x?.result?.protocolVersion && m?.method === "initialize") version = x.result.protocolVersion; out(x); };
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
        let buf = "";
        for await (const chunk of /** @type {any} */ (res.body)) {
          buf += Buffer.from(chunk).toString("utf8");
          let k;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, k); buf = buf.slice(k + 2);
            const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data) try { emit(JSON.parse(data)); } catch { /* not JSON */ }
          }
        }
      } else {
        const text = await res.text();
        if (text) { const j = JSON.parse(text); for (const x of Array.isArray(j) ? j : [j]) emit(x); }
      }
    } catch (e) {
      if (m && m.id !== undefined && m.method) out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `autocraft-task proxy: ${msg(e)}` } });
    }
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const p = forward(line).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
  return 0;
}

/**
 * The secret and server of a lease: from the lease store, or from AUTOCRAFT_TASK_LEASE_SECRET and AUTOCRAFT_TASK_SERVER inside a sandbox.
 * @param {string | undefined} id
 */
function leaseAccess(id) {
  const lease = id === undefined ? null : readLease(leaseId(id));
  const secret = lease?.secret ?? process.env.AUTOCRAFT_TASK_LEASE_SECRET;
  const server = lease?.server ?? process.env.AUTOCRAFT_TASK_SERVER ?? loadConfig().server;
  if (!secret || !server) throw new Error(id === undefined ? "no lease: give its id or set AUTOCRAFT_TASK_LEASE_SECRET" : `no lease ${id} on this machine`);
  secretsInUse.add(secret);
  return { secret: /** @type {string} */ (secret), server: /** @type {string} */ (server) };
}

/**
 * One tool call of a lease's server without MCP, for harnesses that take tools as commands: prints the result's text, exit 1 for an
 * error result. A `check` call can take minutes; the server keeps the request alive meanwhile.
 * @param {string[]} argv
 */
async function cmdTool(argv) {
  const [name, tool, json, id] = argv;
  if (!name || !NAME.test(name) || !tool || !/^[a-z][a-z0-9_]{0,60}$/.test(tool)) throw new Error("usage: autocraft-task tool <server-name> <tool> [<json arguments>] [<lease>]");
  let args;
  try { args = JSON.parse(json ?? "{}"); } catch { throw new Error("the tool arguments must be JSON"); }
  const { secret, server } = leaseAccess(id);
  // A `check` streams whitespace while it runs; a reply cut off or a 5xx runs the call again.
  /** @type {{ content?: { text?: string }[], isError?: boolean }} */
  const r = await withRetry(() => api(server, `${ROUTES.tool}/${name}/${tool}`, secret, args, { timeoutMs: 60 * 60_000 }), { deadline: Date.now() + TOOL_RETRY_MS });
  console.log((r.content ?? []).map((c) => c.text ?? "").join("\n"));
  return r.isError ? 1 : 0;
}

const USAGE = `autocraft-task ${HELPER_VERSION}: runs AutoCraft model calls under your own harness subscription.

  login <server-url>          store the agent token (read from stdin)
  harness claude [--keychain] store a \`claude setup-token\` token (read from stdin); on macOS
                              --keychain uses your Claude Code login from the Keychain instead
  harness claude --config-dir [<dir>]  use the login of a Claude config directory (default $CLAUDE_CONFIG_DIR or ~/.claude; Linux)
  harness codex [--device-auth]  log Codex in to the helper's own CODEX_HOME (not your ~/.codex)
  claim                       claim one call; prints its lease id
  run [--detach] [<lease>]    run a claimed lease, or claim and run one
  wait <lease>                wait for a detached run (returns after at most 9 minutes)
  work [--parallel N]         claim, run and submit in a loop
  doctor                      check platform, sandbox (on macOS with a canary), harness, login and server
  try <bundle.json> [--slot N]  run a bundle from a file without a server and print the reply (testing)
  mcp <server-name> <lease>   stdio-to-HTTP proxy for one of the lease's MCP servers
  tool <server-name> <tool> [<json>] [<lease>]
                              one tool call without MCP; prints the result
  status                      whether the helper claims now, with the plan usage, reserve and pause behind it
  pause-until-reset           claim nothing until the plan window resets, even when usage recovers
  resume                      end a pause, and a hold after the provider refused a run for its limit
  config reserve <5h> <weekly>  keep more of each plan window free than the server's reserve (percent); \`off\` drops it

The helper claims only while every plan window keeps more than the reserve free (set per user on the
dashboard, default 20%), and holds whenever it cannot read the usage.

Config: ${"$XDG_CONFIG_HOME"}/autocraft-task/config.json (mode 0600); "tiers" maps top/mid/small to models
(Claude defaults to opus, sonnet and haiku; Codex has no defaults).`;

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "login": await cmdLogin(rest); return 0;
      case "harness": await cmdHarness(rest); return 0;
      case "claim": await cmdClaim(); return 0;
      case "run": return await cmdRun(rest);
      case "wait": return await cmdWait(rest);
      case "work": return await cmdWork(rest);
      case "doctor": return await cmdDoctor();
      case "try": return await cmdTry(rest);
      case "mcp": return await cmdMcp(rest);
      case "tool": return await cmdTool(rest);
      case "status": return await cmdStatus();
      case "pause-until-reset": await cmdPause(); return 0;
      case "resume": await cmdResume(); return 0;
      case "config": await cmdConfig(rest); return 0;
      case "version": case "--version": console.log(HELPER_VERSION); return 0;
      default: console.log(USAGE); return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
    }
  } catch (e) {
    console.error(`autocraft-task: ${msg(e)}`);
    return 1;
  }
}

const self = fileURLToPath(import.meta.url);
let direct = false;
try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self); } catch { /* imported */ }
if (direct) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
