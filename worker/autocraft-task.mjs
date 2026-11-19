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
//   autocraft-task claim                   claims one call; prints its lease id
//   autocraft-task run [--detach] [<lease>]  runs a claimed lease (claims one when none is given)
//   autocraft-task wait <lease>            waits for a detached run (at most 9 minutes)
//   autocraft-task work [--parallel N]     claims, runs and submits in a loop
//   autocraft-task doctor                  checks platform, sandbox, harness, login and server
//   autocraft-task mcp <server> <lease>    stdio-to-HTTP proxy for one of the lease's MCP servers

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
// Harness adapters. A Codex adapter goes beside `claudeAdapter` and into ADAPTERS.

/**
 * What an adapter gets for one run.
 * @typedef {object} AdapterTask
 * @property {TaskBundle} bundle
 * @property {string} model      the model this helper runs for the bundle's tier
 * @property {string} bin        resolved harness binary on the host
 * @property {string} token      the harness credential (environment only, never argv)
 * @property {{ host: string, path: string }[]} mounts   prepared read-only mounts, `path` inside the sandbox
 * @property {string} taskDir    host directory for generated files (MCP config, agents file)
 * @property {string} mcpFile    host file with the MCP config, or "" when the call has no MCP servers
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
 * @property {Record<Tier, string>} defaultTiers
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
const FIXED_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/etc", "/proc", "/dev", "/tmp", "/home", "/work", "/opt", "/mcp.json", "/agents.json"];

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
  token: (cfg) => cfg.claudeToken,
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
};

/** @type {Record<HarnessId, Adapter | undefined>} */
const ADAPTERS = { claude: claudeAdapter, codex: undefined };

// ---------------------------------------------------------------------------
// Files: config and lease secrets under the config directory (mode 0700/0600), everything else in the cache.

/**
 * @typedef {object} Config
 * @property {string} [server]
 * @property {string} [agentToken]
 * @property {HarnessId} [harness]
 * @property {string} [claudeToken]
 * @property {string} [claudeBin]
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
  mkdirSync(dirname(statusFile(id)), { recursive: true });
  writeFileSync(`${statusFile(id)}.tmp`, JSON.stringify(s));
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

/** Removes expired session stores, old cached trees and task directories a crash left behind. */
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
  if (!d.loggedIn) throw new Error(`no ${adapter.id} token: run \`autocraft-task harness ${adapter.id}\``);
  /** @type {Claim} */
  const claim = { protocol: PROTOCOL_VERSION, helperVersion: HELPER_VERSION, harness: adapter.id, harnessVersion: d.version, tiers: { ...adapter.defaultTiers, ...cfg.tiers }, ...(cfg.repos && { repos: cfg.repos }), sessions: heldSessions() };
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
  let taskDir = "";
  try {
    try { prune(); } catch { /* best effort */ }
    const adapter = adapterOf(cfg);
    const d = adapter.detect(cfg);
    const token = adapter.token(cfg);
    if (!d.bin || !token) return giveBack(`${adapter.id} binary or token missing on the helper`, true);
    /** @type {TaskBundle} */
    const b = await api(lease.server, ROUTES.bundle, lease.secret);
    if (typeof b?.callId !== "number" || typeof b.stdin !== "string" || !Array.isArray(b.mounts) || !Array.isArray(b.mcpServers)) return fail("unreadable bundle");
    const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
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
    const c = adapter.command({ bundle: b, model, bin: d.bin, token, mounts, taskDir, mcpFile, sessionDir, resumeId });
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
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(lease.secret);
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
  if (id !== "claude") throw new Error("usage: autocraft-task harness claude  (a `claude setup-token` token on stdin)");
  const token = await readSecret("Claude token (from `claude setup-token`): ");
  if (!token || /\s/.test(token)) throw new Error("no token on stdin");
  saveConfig({ ...loadConfig(), harness: "claude", claudeToken: token });
  const d = claudeAdapter.detect(loadConfig());
  console.log(d.bin ? `stored the Claude token; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "stored the Claude token; claude was not found on PATH");
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

/** @param {string[]} argv */
async function cmdWork(argv) {
  const i = argv.indexOf("--parallel");
  const n = i >= 0 ? Number(argv[i + 1]) : 1;
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--parallel takes a number from 1 to 16");
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
    const c = claudeSandbox({ claudeBin: d.bin, claudeArgs: ["--version"], mounts: [] });
    const r = spawnSync(c.cmd, c.args, { env: c.env, encoding: "utf8", timeout: 30_000 });
    check(r.status === 0, r.status === 0 ? `${adapter.id} runs inside the sandbox` : `${adapter.id} does not run inside the sandbox: ${redact((r.stderr || "").trim()).slice(0, 200)}`);
  }
  check(d.loggedIn, d.loggedIn ? `${adapter.id} token stored` : `no ${adapter.id} token: run \`autocraft-task harness ${adapter.id}\``);
  check(!!cfg.server && !!cfg.agentToken, cfg.server ? `server ${cfg.server}${cfg.agentToken ? ", agent token stored" : ", no agent token"}` : "not logged in: run `autocraft-task login <server-url>`");
  if (cfg.server) {
    try {
      const res = await fetch(`${cfg.server}${ROUTES.helper}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      check(res.ok, res.ok ? "server reachable" : `server answered HTTP ${res.status}`);
    } catch (e) { check(false, `server unreachable: ${msg(e)}`); }
  }
  check(true, `tiers: ${Object.entries({ ...adapter.defaultTiers, ...cfg.tiers }).map(([t, m]) => `${t}=${m}`).join(", ")}`);
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
  const lease = readLease(leaseId(id));
  const secret = lease?.secret ?? process.env.AUTOCRAFT_TASK_LEASE_SECRET;
  const server = lease?.server ?? process.env.AUTOCRAFT_TASK_SERVER ?? loadConfig().server;
  if (!secret || !server) throw new Error(`no lease ${id} on this machine`);
  secretsInUse.add(secret);
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

const USAGE = `autocraft-task ${HELPER_VERSION}: runs AutoCraft model calls under your own harness subscription.

  login <server-url>          store the agent token (read from stdin)
  harness claude              store a \`claude setup-token\` token (read from stdin)
  claim                       claim one call; prints its lease id
  run [--detach] [<lease>]    run a claimed lease, or claim and run one
  wait <lease>                wait for a detached run (returns after at most 9 minutes)
  work [--parallel N]         claim, run and submit in a loop
  doctor                      check platform, sandbox, harness, login and server
  mcp <server-name> <lease>   stdio-to-HTTP proxy for one of the lease's MCP servers

Config: ${"$XDG_CONFIG_HOME"}/autocraft-task/config.json (mode 0600); "tiers" maps top/mid/small to models.`;

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
