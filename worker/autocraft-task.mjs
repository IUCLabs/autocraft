#!/usr/bin/env node
// @ts-check
// autocraft-task: runs AutoCraft model calls on a maintainer's own machine, under their own harness subscription.
// It claims a call, fetches its bundle (prompt, checkouts, MCP servers), runs the harness in a read-only
// sandbox confined to the task directory, sends heartbeats and submits the reply. Planner, gates, GitHub
// writes and builds stay on the server.
//
// One file, only `node:` imports, Node 22 or later. The dashboard serves it at /worker/autocraft-task.mjs.
// Linux and WSL only: the harness runs inside bubblewrap.
//
//   autocraft-task login <server-url>      agent token on stdin
//   autocraft-task harness claude          a `claude setup-token` token on stdin
//   autocraft-task harness claude --config-dir [<dir>]  the login of a Claude config directory, read at each call
//   autocraft-task harness codex [--device-auth]  logs Codex in to the helper's own CODEX_HOME
//   autocraft-task claim                   claims one call; prints its lease id
//   autocraft-task run [--detach] [<lease>]  runs a claimed lease (claims one when none is given)
//   autocraft-task wait <lease>            waits for a detached run (at most 9 minutes)
//   autocraft-task work [--parallel N]     claims, runs and submits in a loop
//   autocraft-task doctor                  checks platform, sandbox, harness, login and server
//   autocraft-task mcp <server> <lease>    stdio-to-HTTP proxy for one of the lease's MCP servers
//   autocraft-task tool <server> <tool> [<json>] [<lease>]  one tool call without MCP; prints the result

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const HELPER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Wire format: a copy of src/remote/protocol.ts (the helper is served alone, so it keeps its own).

/** Must equal the server's; the server refuses a claim from a helper of another version. */
export const PROTOCOL_VERSION = 1;

export const ROUTES = {
  claim: "/api/remote/claim",
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
 * @property {string[]} [repos]
 * @property {number[]} [sessions]
 */
/** @typedef {{ lease: null, retryAfter: number } | { lease: { id: number, secret: string, title: string, requiredHelper: string } }} ClaimReply */
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
/** @typedef {{ progress?: string }} Heartbeat */
/** @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} Usage */
/**
 * @typedef {{ ok: true, text: string, model: string, usage: Usage, modelUsage?: Record<string, Usage>, costUsd?: number, turns?: number, sessionId?: string, durationMs: number }
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
 * @property {(bin: string) => { cmd: string, args: string[], env: Record<string, string> }} versionInSandbox  the harness's version command inside the sandbox (doctor)
 * @property {(bin: string, token: string) => string | null} [preflight]  prepares the harness's files before every call; why it must not run, or null
 * @property {boolean} [exclusive]  one call at a time per helper (the harness refreshes a shared login)
 * @property {boolean} [fileTools]  the run gets the helper's read-only file tools (its own read tool can't be confined)
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
  if (result.is_error || typeof result.result !== "string") return { ok: false, text: "", ...base, error: `model error ${typeof result.result === "string" ? result.result : ""}`.trim().slice(0, 400) };
  return { ok: true, text: result.result, ...base };
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
  token: (cfg) => (cfg.claudeConfigDir ? readClaudeCredentials(cfg.claudeConfigDir)?.claudeAiOauth?.accessToken : cfg.claudeToken),
  tokenFor(cfg, timeoutSeconds) {
    if (!cfg.claudeConfigDir) return cfg.claudeToken ? { token: cfg.claudeToken } : { problem: "no Claude token stored" };
    return claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), timeoutSeconds);
  },
  defaultTiers: { top: "opus", mid: "sonnet", small: "haiku" },
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
    const agentsFile = hint.agents !== undefined ? join(t.taskDir, "agents.json") : undefined;
    if (agentsFile) writeFileSync(agentsFile, hint.agents ?? "", { mode: 0o600 });
    return claudeSandbox({ claudeBin: t.bin, oauthToken: t.token, claudeArgs: args, mounts: t.mounts, agentsFile, mcpFile: t.mcpFile || undefined, sessionDir: t.sessionDir });
  },
  parse: parseClaudeOutput,
  resume: (args, sessionId) => claudeResume(args, sessionId),
  progress: claudeProgress,
  versionInSandbox: (bin) => claudeSandbox({ claudeBin: bin, claudeArgs: ["--version"], mounts: [] }),
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
  { name: "read_file", description: "Reads a text file: numbered lines, at most 2000 from `offset` (1-based).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path, e.g. /repo/src/main.rs" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: READ_LINES } }, required: ["path"] } },
  { name: "grep", description: "Searches files under a directory for an extended regular expression; prints path:line:text, at most 200 lines.", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory or file; default /repo" }, glob: { type: "string", description: "Only file names matching this, e.g. *.rs" }, ignore_case: { type: "boolean" } }, required: ["pattern"] } },
  { name: "glob", description: "Lists files whose path below `path` matches a glob (** any depth, * and ? within a name), at most 500.", inputSchema: { type: "object", properties: { pattern: { type: "string", description: "e.g. **/*.rs" }, path: { type: "string", description: "Directory; default /repo" } }, required: ["pattern"] } },
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
    const { real, root, mount } = hostPath(mounts, a.path ?? "/repo");
    const re = globRegex(a.pattern);
    const base = sandboxPathOf(mount, root, real);
    const hits = walkFiles(real, 50_000).filter((r) => re.test(r));
    return hits.length ? hits.slice(0, GLOB_MAX).map((r) => `${base}/${r}`).join("\n") + (hits.length > GLOB_MAX ? `\n(${hits.length} files; narrow the pattern)` : "") : "no files match";
  }
  if (name === "grep") {
    if (typeof a.pattern !== "string" || !a.pattern) throw new Error("pattern is required");
    const { real, root, mount } = hostPath(mounts, a.path ?? "/repo");
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
//   --ignore-user-config (codex-home/src/instructions/mod.rs, arg0/src/lib.rs), so the helper removes them from its home;
//   project_doc_max_bytes = 0 turns off AGENTS.md from the working directory (core/src/agents_md.rs); /etc/codex is not
//   in the sandbox.
// Codex has no turn limit: the bundle's wall-clock limit bounds the call.

const SANDBOX_CODEX = "/opt/codex/codex";
const CODEX_HOME_PATH = "/codex-home";
const CODEX_PROFILE = "autocraft";
const LEASE_ENV = "AUTOCRAFT_TASK_LEASE_SECRET";
const FILES_ENV = "AUTOCRAFT_TASK_FILES_TOKEN";
/** Files Codex reads from CODEX_HOME whatever the flags say. */
const CODEX_HOME_INSTRUCTIONS = ["AGENTS.md", "AGENTS.override.md", ".env", "config.toml"];
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Built-in Codex features turned off: the shell, and every tool that reaches past the task directory or the call's MCP servers. */
const CODEX_FEATURES_OFF = ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "apps", "plugins", "remote_plugin", "tool_suggest", "skill_search", "skill_mcp_dependency_install", "hooks", "image_generation", "multi_agent", "goals", "workspace_dependencies"];

/** A TOML basic string: JSON's escapes are TOML's, except that TOML also forbids a raw DEL. @param {string} v */
const toml = (v) => JSON.stringify(v).replace(/\u007f/g, "\\u007F");

/**
 * `codex` arguments for one call: exec (or exec resume) reading the prompt on stdin, the model and effort, no shell,
 * the call's MCP servers on our dashboard and the helper's file tools (tokens from the environment), and none of the
 * user's config or instructions.
 * @param {{ model: string, effort: string, system: string | null, server: string, servers: string[], files: string, keepSession: boolean, resumeId?: string, toolTimeoutSec: number }} o
 */
export function codexArgs(o) {
  if (o.resumeId !== undefined && !THREAD_ID.test(o.resumeId)) throw new Error(`not a Codex thread id: ${o.resumeId}`);
  const http = (/** @type {string} */ name, /** @type {string} */ url, /** @type {string} */ env, /** @type {number} */ timeout) =>
    `${name}={url=${toml(url)}, bearer_token_env_var="${env}", default_tools_approval_mode="approve", startup_timeout_sec=30, tool_timeout_sec=${timeout}}`;
  const mcp = o.servers.map((n) => {
    if (!NAME.test(n) || n.includes(".") || n === FILE_TOOLS_SERVER) throw new Error(`bad MCP server name ${n}`);
    return http(n, `${o.server}${ROUTES.mcp}/${n}`, LEASE_ENV, Math.max(60, Math.round(o.toolTimeoutSec)));
  });
  return ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", WORK_PATH,
    // A call whose session may get a follow-up keeps its rollout in CODEX_HOME; any other leaves nothing behind.
    ...(o.keepSession || o.resumeId ? [] : ["--ephemeral"]),
    "-c", `model=${toml(o.model)}`, "-c", `model_reasoning_effort=${toml(o.effort)}`,
    "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", "agents={enabled=false}", "-c", 'cli_auth_credentials_store="file"',
    "-c", `features={${CODEX_FEATURES_OFF.map((f) => `${f}=false`).join(", ")}}`,
    "-c", `shell_environment_policy={inherit="none", set={PATH="/usr/bin", HOME="${SANDBOX_HOME}", LANG="C.UTF-8"}}`,
    "-c", `default_permissions="${CODEX_PROFILE}"`,
    "-c", `permissions={${CODEX_PROFILE}={extends=":read-only", filesystem={"${CODEX_HOME_PATH}"="deny"}}}`,
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
  const triple = process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  const pkgArch = process.arch === "arm64" ? "arm64" : "x64";
  for (const c of candidates) {
    let p;
    try { accessSync(c, constants.X_OK); p = realpathSync(c); } catch { continue; }
    let head = "";
    try { const fd = openSync(p, "r"); const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); head = b.toString("latin1"); } catch { /* unreadable */ }
    if (head !== "#!") return p;
    // npm: <pkg>/bin/codex.js runs <platform pkg>/vendor/<triple>/bin/codex, or <pkg>/vendor/<triple>/bin/codex.
    const pkg = dirname(dirname(p));
    for (const v of [join(pkg, "node_modules", "@openai", `codex-linux-${pkgArch}`, "vendor"), join(dirname(pkg), `codex-linux-${pkgArch}`, "vendor"), join(pkg, "vendor")]) {
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
  exclusive: true,
  fileTools: true,
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
    return null;
  },
  command(t) {
    if (!t.files) throw new Error("the file tools are not running");
    const args = codexArgs({ model: t.model, effort: t.bundle.effort, system: t.bundle.system, server: t.lease.server, servers: t.bundle.mcpServers, files: t.files.url, keepSession: t.bundle.keepSession, ...(t.resumeId && { resumeId: t.resumeId }), toolTimeoutSec: t.bundle.timeoutSeconds });
    return codexSandbox({ codexBin: t.bin, codexHome: t.token, codexArgs: args, mounts: t.mounts, env: { [FILES_ENV]: t.files.token, ...(t.bundle.mcpServers.length && { [LEASE_ENV]: t.lease.secret }) } });
  },
  parse: parseCodexOutput,
  resume: (args, sessionId) => {
    if (!THREAD_ID.test(sessionId)) throw new Error(`not a Codex thread id: ${sessionId}`);
    const out = args.slice(0, -1).filter((a, i, all) => a !== "resume" && all[i - 1] !== "resume" && a !== "--ephemeral");
    return [...out, "resume", sessionId, "-"];
  },
  progress: codexProgress,
  versionInSandbox: (bin) => codexSandbox({ codexBin: bin, codexHome: codexHome(), codexArgs: ["--version"], mounts: [] }),
};

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
 * @property {string} [claudeConfigDir]  a Claude config directory whose login the helper uses instead (read only, never mounted)
 * @property {string} [claudeBin]
 * @property {string} [codexBin]
 * @property {Partial<Record<Tier, string>>} [tiers]  model per tier; defaults are the adapter's
 * @property {string[]} [repos]
 */

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autocraft-task");
const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "autocraft-task");
const SESSION_TTL_MS = 3 * 3600_000;
const TREE_TTL_MS = 3 * 24 * 3600_000;
const WAIT_MS = 9 * 60_000;
const HEARTBEAT_MS = 30_000;

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

/** @typedef {{ secret: string, title: string, requiredHelper: string, server: string, claimedAt: number }} LeaseRecord */
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

// Session stores: sessions/<callId>.json names the store directory and the harness session id; stores live in sessions/store-*.
const sessionsDir = () => join(cacheDir(), "sessions");
/** @param {number} callId @returns {{ sessionId: string, dir: string, at: number } | null} */
function readSession(callId) {
  const s = readJson(join(sessionsDir(), `${callId}.json`));
  return s && Date.now() - s.at < SESSION_TTL_MS && existsSync(s.dir) ? s : null;
}
/** Call ids whose session store this helper still holds. */
function heldSessions() {
  if (!existsSync(sessionsDir())) return [];
  return readdirSync(sessionsDir()).flatMap((f) => { const m = /^(\d+)\.json$/.exec(f); return m && readSession(Number(m[1])) ? [Number(m[1])] : []; });
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

/**
 * @param {string} server @param {string} route @param {string} bearer @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function api(server, route, bearer, body) {
  const res = await fetch(`${server}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 410) throw new Gone("the lease is gone");
  const text = await res.text();
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status} ${redact(text).slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
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

/** A tree from the server's tarball route. @param {string} server @param {string} secret @param {{ repo: string, sha: string }} m */
async function tarballTree(server, secret, m) {
  if (!NAME.test(m.repo) || !SHA.test(m.sha)) throw new Error(`bad tarball mount ${m.repo}@${m.sha}`);
  const tree = join(cacheDir(), "trees", "tarball", m.repo, m.sha);
  return cachedTree(tree, async (tmp) => {
    const res = await fetch(`${server}${ROUTES.tarball}?repo=${encodeURIComponent(m.repo)}&sha=${m.sha}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (res.status === 410) throw new Gone("the lease is gone");
    if (!res.ok || !res.body) throw new Error(`tarball ${m.repo}: HTTP ${res.status}`);
    const body = /** @type {any} */ (res.body);
    await untar(tmp, (stdin) => pipeline(Readable.fromWeb(body), stdin));
  });
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

/** @param {string} server @param {string} secret @param {TaskBundle} b @param {string} taskDir */
async function prepareMounts(server, secret, b, taskDir) {
  return Promise.all(b.mounts.map(async (m, i) => {
    checkMountPath(m.path);
    const host = m.kind === "git" ? await gitTree(m) : m.kind === "tarball" ? await tarballTree(server, secret, m) : m.kind === "files" ? filesTree(join(taskDir, "files", String(i)), m.files) : null;
    if (!host) throw new Error(`unknown mount kind ${/** @type {any} */ (m).kind}`);
    return { host, path: m.path };
  }));
}

// ---------------------------------------------------------------------------
// Platform.

/** Why model calls can't run here, or null. */
function platformProblem() {
  if (process.platform !== "linux") return "autocraft-task runs model calls only on Linux and WSL for now: it confines the harness with bubblewrap. The macOS sandbox is not built yet.";
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

/** @param {Config} cfg @returns {Promise<ClaimReply>} */
async function claimOnce(cfg) {
  const { server, agentToken } = needLogin(cfg);
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  if (!d.bin || !d.version) throw new Error(`${adapter.id} not found or not runnable`);
  if (!d.loggedIn) throw new Error(`no ${adapter.id} login: run \`autocraft-task harness ${adapter.id}\``);
  const tiers = { ...adapter.defaultTiers, ...cfg.tiers };
  if (!Object.keys(tiers).length) throw new Error(`no model is set for any tier: add "tiers" (top, mid, small) with ${adapter.id} model ids to ${join(configDir(), "config.json")}`);
  /** @type {Claim} */
  const claim = { protocol: PROTOCOL_VERSION, helperVersion: HELPER_VERSION, harness: adapter.id, harnessVersion: d.version, tiers, ...(cfg.repos && { repos: cfg.repos }), sessions: heldSessions() };
  /** @type {ClaimReply} */
  const reply = await api(server, ROUTES.claim, agentToken, claim);
  if (reply.lease) {
    /** @type {LeaseRecord} */
    const rec = { secret: reply.lease.secret, title: reply.lease.title, requiredHelper: reply.lease.requiredHelper, server, claimedAt: Date.now() };
    writePrivate(leaseFile(reply.lease.id), rec);
  }
  return reply;
}

/**
 * Runs one claimed lease to its end: bundle, mounts, sandboxed harness with heartbeats, submit.
 * Returns the status line; never throws.
 * @param {Config} cfg @param {number} id @param {{ signal?: AbortSignal }} [opt]
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
  /** @param {Submit} s */
  const submit = async (s) => {
    // A network failure is retried; an HTTP error or a 410 is final.
    for (let i = 0; ; i++) {
      try { return /** @type {SubmitReply} */ (await api(lease.server, ROUTES.submit, lease.secret, s)); }
      catch (e) { if (e instanceof Gone || i >= 2 || (e instanceof Error && e.message.startsWith(ROUTES.submit))) throw e; await sleep(5000); }
    }
  };
  /** @param {string} error @param {Usage} [usage] */
  const fail = async (error, usage) => {
    try { await submit({ ok: false, error: redact(error).slice(0, 2000), ...(usage && { usage }), durationMs: Date.now() - started }); } catch (e) { if (e instanceof Gone) return end("lost", `lost: ${lease.title}: the lease was withdrawn`); }
    return end("failed", `failed: ${lease.title}: ${error}`);
  };
  /**
   * The helper's own fault, not the call's: the call goes back to the queue without using an attempt.
   * @param {string} reason @param {boolean} [stop] the helper can take no call until it is updated
   */
  const giveBack = async (reason, stop = false) => {
    /** @type {Release} */
    const body = { reason: redact(reason).slice(0, 300) };
    try { await api(lease.server, ROUTES.release, lease.secret, body); } catch (e) { if (e instanceof Gone) return end("lost", `lost: ${lease.title}: the lease was withdrawn`); }
    return end("released", `released: ${lease.title}: ${reason}`, stop);
  };
  if (compareVersions(HELPER_VERSION, lease.requiredHelper) < 0) return giveBack(`helper ${HELPER_VERSION} is older than the required ${lease.requiredHelper}; download ${lease.server}${ROUTES.helper}`, true);
  const problem = platformProblem();
  if (problem) return giveBack(problem, true);
  /** @type {string[]} */
  const tokens = [];
  let taskDir = "", unlock = () => {}, files = /** @type {{ url: string, token: string, close: () => void } | null} */ (null);
  try {
    try { prune(); } catch { /* best effort */ }
    const adapter = adapterOf(cfg);
    const d = adapter.detect(cfg);
    const token = adapter.token(cfg);
    if (!d.bin || !token) return giveBack(`${adapter.id} binary or token missing on the helper`, true);
    tokens.push(token); secretsInUse.add(token);
    if (adapter.exclusive) {
      const release = takeHarnessLock(adapter.id);
      if (!release) return giveBack(`another ${adapter.id} call is running on this helper, and they share one login`);
      unlock = release;
    }
    const unsafe = adapter.preflight?.(d.bin, token);
    if (unsafe) return giveBack(unsafe, true);
    /** @type {TaskBundle} */
    const b = await api(lease.server, ROUTES.bundle, lease.secret);
    if (typeof b?.callId !== "number" || typeof b.stdin !== "string" || !Array.isArray(b.mounts) || !Array.isArray(b.mcpServers)) return fail("unreadable bundle");
    const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
    if (!model) return giveBack(`no ${adapter.id} model is set for the ${b.tier} tier ("tiers" in the config)`);
    let runToken = token;
    if (adapter.tokenFor) {
      const t = adapter.tokenFor(cfg, b.timeoutSeconds);
      if ("problem" in t) return giveBack(t.problem);
      runToken = t.token;
    }
    tokens.push(runToken); secretsInUse.add(runToken);
    privateDir(join(cacheDir(), "tasks"));
    taskDir = mkdtempSync(join(cacheDir(), "tasks", `${b.callId}-`));
    let mounts;
    try { mounts = await prepareMounts(lease.server, lease.secret, b, taskDir); } catch (e) {
      if (e instanceof Gone) throw e;
      return giveBack(`setting up the files failed: ${msg(e)}`);
    }
    let mcpFile = "";
    if (b.mcpServers.length) {
      for (const n of b.mcpServers) if (!NAME.test(n)) return fail(`bad MCP server name ${n}`);
      mcpFile = join(taskDir, "mcp.json");
      writeFileSync(mcpFile, JSON.stringify(mcpConfig(lease.server, b.mcpServers, lease.secret)), { mode: 0o600 });
    }
    // Session store: a follow-up continues its parent's; a call whose arguments keep the session gets a new one.
    let sessionDir, resumeId;
    if (b.resume) {
      const parent = readSession(b.resume.parentCallId);
      if (!parent) return fail(`the session of call ${b.resume.parentCallId} is no longer held by this helper`);
      sessionDir = parent.dir; resumeId = parent.sessionId;
    } else if (b.keepSession) {
      privateDir(sessionsDir());
      sessionDir = mkdtempSync(join(sessionsDir(), "store-"));
    }
    if (adapter.fileTools) files = await serveFileTools(mounts);
    const c = adapter.command({ bundle: b, model, bin: d.bin, token: runToken, mounts, taskDir, mcpFile, sessionDir, resumeId, lease: { server: lease.server, secret: lease.secret }, ...(files && { files: { url: files.url, token: files.token } }) });
    const r = await harness(c, b, lease, opt.signal, adapter);
    if (r.gone) return end("lost", `lost: ${lease.title}: the lease was withdrawn`);
    const reply = adapter.parse(r.stdout, model);
    if (sessionDir && reply.sessionId) writePrivate(join(sessionsDir(), `${b.callId}.json`), { sessionId: reply.sessionId, dir: sessionDir, at: Date.now() });
    else if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
    if (r.timedOut) return fail(`timed out after ${b.timeoutSeconds} s`, reply.usage);
    if (r.stopped) return giveBack("stopped on the helper");
    if (!reply.ok) return fail(`${reply.error ?? "no result"} (exit ${r.code}) ${r.stderr.trim().slice(-300)}`.trim(), reply.usage);
    const usage = reply.usage ?? { inputTokens: 0, outputTokens: 0 };
    const s = await submit({ ok: true, text: reply.text, model: reply.model, usage, ...(reply.modelUsage && { modelUsage: reply.modelUsage }), ...(reply.costUsd !== undefined && { costUsd: reply.costUsd }), ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.sessionId && { sessionId: reply.sessionId }), durationMs: Date.now() - started });
    if (!s.accepted) return end("failed", `rejected: ${lease.title}: ${s.reason ?? "no reason given"}`);
    return end("submitted", `submitted: ${lease.title}, ${kTokens(tokensOf(usage))} tokens`);
  } catch (e) {
    if (e instanceof Gone) return end("lost", `lost: ${lease.title}: the lease was withdrawn`);
    return fail(msg(e));
  } finally {
    files?.close();
    unlock();
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(lease.secret);
    for (const t of tokens) secretsInUse.delete(t);
  }
}

/**
 * Runs the sandboxed harness: stdin in, heartbeats every 30 s with the last progress line, stopped at the
 * bundle's timeout, on a 410 heartbeat or when `signal` aborts.
 * @param {{ cmd: string, args: string[], env: Record<string, string> }} c @param {TaskBundle} b @param {LeaseRecord} lease @param {AbortSignal | undefined} signal @param {Adapter} adapter
 */
function harness(c, b, lease, signal, adapter) {
  return new Promise((resolve) => {
    const p = spawn(c.cmd, c.args, { env: c.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", partial = "", progress = "", gone = false, timedOut = false, stopped = false, settled = false;
    const kill = () => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 5000).unref(); };
    p.stdout.on("data", (d) => {
      stdout += d;
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) { const x = adapter.progress(l); if (x) progress = x; }
    });
    p.stderr.on("data", (d) => { if (stderr.length < 16_000) stderr += d; });
    p.stdin.on("error", () => {});
    p.stdin.end(b.stdin);
    const beat = setInterval(async () => {
      try { await api(lease.server, ROUTES.heartbeat, lease.secret, /** @type {Heartbeat} */ (progress ? { progress } : {})); }
      catch (e) { if (e instanceof Gone) { gone = true; kill(); } }
    }, HEARTBEAT_MS);
    const timer = setTimeout(() => { timedOut = true; kill(); }, b.timeoutSeconds * 1000);
    const onAbort = () => { stopped = true; kill(); };
    signal?.addEventListener("abort", onAbort);
    /** @param {number | null} code */
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearInterval(beat); clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr: redact(stderr), gone, timedOut, stopped });
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
  if (id !== "claude") throw new Error("usage: autocraft-task harness claude  (a `claude setup-token` token on stdin)\n       autocraft-task harness claude --config-dir [<dir>]\n       autocraft-task harness codex [--device-auth]");
  const at = argv.indexOf("--config-dir");
  if (at >= 0) {
    const given = argv[at + 1];
    const dir = resolve(given && !given.startsWith("-") ? given : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const o = readClaudeCredentials(dir)?.claudeAiOauth;
    if (typeof o?.accessToken !== "string" || typeof o.expiresAt !== "number") throw new Error(`no Claude login in ${dir}/.credentials.json: run claude with CLAUDE_CONFIG_DIR=${dir} and log in`);
    const { claudeToken: _, ...rest } = loadConfig();
    saveConfig({ ...rest, harness: "claude", claudeConfigDir: dir });
    const d = claudeAdapter.detect(loadConfig());
    console.log(`using the Claude login in ${dir} (its access token is valid for ${Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000))} more minutes; claude refreshes it whenever it runs)${d.bin ? `; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "; claude was not found on PATH"}`);
    return;
  }
  const token = await readSecret("Claude token (from `claude setup-token`): ");
  if (!token || /\s/.test(token)) throw new Error("no token on stdin");
  const { claudeConfigDir: _, ...rest } = loadConfig();
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
  if (!r.lease) { console.log(`no task queued; claim again in ${r.retryAfter} s`); return null; }
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
  let id;
  if (pos[0]) id = leaseId(pos[0]);
  else {
    const r = await claimOnce(cfg);
    if (!r.lease) { console.log(`no task queued; try again in ${r.retryAfter} s`); return 0; }
    id = r.lease.id;
  }
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
  const s = await runLease(cfg, id, { signal: ac.signal });
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
  const ac = new AbortController();
  process.on("SIGINT", () => { if (ac.signal.aborted) process.exit(130); console.log("stopping: running calls are stopped and reported; press Ctrl-C again to quit at once"); ac.abort(); });
  let idleSaid = false;
  /** @param {number} ms */
  const pause = (ms) => sleep(ms, undefined, { signal: ac.signal }).catch(() => {});
  const loop = async () => {
    while (!ac.signal.aborted) {
      let r;
      try { r = await claimOnce(loadConfig()); } catch (e) { console.log(`claim failed: ${msg(e)}; retrying in 60 s`); await pause(60_000); continue; }
      if (!r.lease) {
        if (!idleSaid) { console.log(`no task queued; claiming again in ${r.retryAfter} s`); idleSaid = true; }
        await pause(Math.max(1, r.retryAfter) * 1000);
        continue;
      }
      idleSaid = false;
      console.log(`lease ${r.lease.id}: ${r.lease.title}`);
      const s = await runLease(loadConfig(), r.lease.id, { signal: ac.signal });
      console.log(s.line);
      if (s.stop) { console.log("stopping: this helper can take no call until that is fixed"); ac.abort(); }
      // A released call goes back to the queue; claiming at once would likely hand it straight back.
      else if (s.state === "released") await pause(60_000);
    }
  };
  await Promise.all(Array.from({ length: n }, loop));
  return 0;
}

async function cmdDoctor() {
  let bad = 0;
  /** @param {boolean} ok @param {string} line */
  const check = (ok, line) => { console.log(`${ok ? "ok  " : "FAIL"} ${line}`); if (!ok) bad++; };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `node ${process.versions.node}${major >= 22 ? "" : " (22 or later needed)"}`);
  const problem = platformProblem();
  check(!problem, problem ?? `platform ${process.platform}, bubblewrap at ${BWRAP}`);
  if (problem) return 1;
  const ns = spawnSync(BWRAP, ["--unshare-all", "--share-net", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { encoding: "utf8", timeout: 20_000 });
  check(ns.status === 0, ns.status === 0 ? "a sandbox starts" : `a sandbox does not start: ${(ns.stderr || "").trim().slice(0, 200)}`);
  for (const tool of ["git", "tar"]) { const r = spawnSync(tool, ["--version"], { encoding: "utf8" }); check(r.status === 0, r.status === 0 ? `${tool} found` : `${tool} not found`); }
  const cfg = loadConfig();
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  check(!!d.bin && !!d.version, d.bin ? `${adapter.id} ${d.version ?? "(no version)"} at ${d.bin}` : `${adapter.id} not found on PATH`);
  if (d.bin) {
    const c = adapter.versionInSandbox(d.bin);
    const r = spawnSync(c.cmd, c.args, { env: c.env, encoding: "utf8", timeout: 30_000 });
    check(r.status === 0, r.status === 0 ? `${adapter.id} runs inside the sandbox` : `${adapter.id} does not run inside the sandbox: ${redact((r.stderr || "").trim()).slice(0, 200)}`);
  }
  check(d.loggedIn, d.loggedIn ? `${adapter.id} login stored` : `no ${adapter.id} login: run \`autocraft-task harness ${adapter.id}\``);
  if (adapter.id === "claude" && cfg.claudeConfigDir && d.loggedIn) {
    const t = claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), 0);
    check("token" in t, "token" in t ? `uses the Claude login in ${cfg.claudeConfigDir}` : t.problem);
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
      const res = await fetch(url, { method: "POST", body: line, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session && { "Mcp-Session-Id": session }), ...(version && { "MCP-Protocol-Version": version }) } });
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      if (res.status === 202) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  const res = await fetch(`${server}${ROUTES.tool}/${name}/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  if (res.status === 410) throw new Gone("the lease is gone");
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${redact(text).slice(0, 300)}`);
  /** @type {{ content?: { text?: string }[], isError?: boolean }} */
  const r = JSON.parse(text);
  console.log((r.content ?? []).map((c) => c.text ?? "").join("\n"));
  return r.isError ? 1 : 0;
}

const USAGE = `autocraft-task ${HELPER_VERSION}: runs AutoCraft model calls under your own harness subscription.

  login <server-url>          store the agent token (read from stdin)
  harness claude              store a \`claude setup-token\` token (read from stdin)
  harness claude --config-dir [<dir>]  use the login of a Claude config directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
  harness codex [--device-auth]  log Codex in to the helper's own CODEX_HOME (not your ~/.codex)
  claim                       claim one call; prints its lease id
  run [--detach] [<lease>]    run a claimed lease, or claim and run one
  wait <lease>                wait for a detached run (returns after at most 9 minutes)
  work [--parallel N]         claim, run and submit in a loop
  doctor                      check platform, sandbox, harness, login and server
  mcp <server-name> <lease>   stdio-to-HTTP proxy for one of the lease's MCP servers
  tool <server-name> <tool> [<json>] [<lease>]
                              one tool call without MCP; prints the result

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
      case "mcp": return await cmdMcp(rest);
      case "tool": return await cmdTool(rest);
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
