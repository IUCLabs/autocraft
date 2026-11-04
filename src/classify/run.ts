// Runs the classifiers: Jev (one `jev ask` per item) and Haiku (batches through `claude -p`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "../../web/src/api/types.ts";
import { createHash } from "node:crypto";
import { jevParallel } from "../agents/accounts.ts";
import { jevAvailable, jevFailure, markJevUnavailable, markJevWorking } from "../agents/jev.ts";
import { accountConfigDir, claudeRoom, startClaudeRun, startJevRun, tryStartFollowUp, CancelledError, type Started } from "../agents/call.ts";
import { touchStore, type SessionAsk } from "../prepush/resume.ts";
import { finishRun, setRunProgress } from "../agents/runs.ts";
import { fixTurnMessage, type Lint, type LintProblem } from "../replylint.ts";
import { coalesce, lineFeed } from "./progress.ts";
import { scrubError } from "../agents/text.ts";
import { scrub } from "../runner/scrub.ts";
import { itemTools } from "../itemtools/index.ts";
import { startBridge, CHECK_SERVER, type Bridge } from "../checktool/bridge.ts";
import type { CheckTool } from "../checktool/index.ts";
import { CHECK_MAX_WALL_MS } from "../core/rules.ts";
import { agentsFile, mcpFile } from "../sandbox/agent-files.ts";
import { MCP_PATH } from "../sandbox/agents.ts";
import { resolveClaudeBin, sandboxCommand, TOKEN_MARGIN_MS, tokenNearExpiry } from "../sandbox/index.ts";
import { REFERENCE_PATH, type SandboxSpec } from "../sandbox/command.ts";
import { holdCheckouts } from "../sandbox/checkout.ts";
import { sessionStore } from "../sandbox/session-store.ts";
import { defaultWorkspace } from "../sandbox/workspace.ts";
import { runModelStep } from "../agents/step.ts";
import { CLASSIFY_HAIKU, CLASSIFY_JEV } from "../agents/steps.ts";
import { CLAUDE_PROMPTS, JEV_ARGS, JEV_USD_PER_INPUT_TOKEN, JEV_PROMPTS, claudeArgs, claudeParts, claudePromptOf, jevPromptOf, joinParts, renderClaude, withoutRepoDir, renderJev, type ClaudeInput, type ClaudePromptId, type JevPromptId } from "../prompts/index.ts";
import type { DupePair } from "../dupes/pair.ts";
import { flagsOf, jevVerdict, parseHaikuReply, parseRef, refOf, type Item, type JevAnswers, type Verdict } from "./parse.ts";
import { envVar } from "../env.ts";

export function loadRefs(file: string): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const r = parseRef(line);
    if (!r) throw new Error(`bad item line: ${line}`);
    out.push(r);
  }
  return out;
}

export function loadItems(db: DatabaseSync, refs: { repo: string; number: number }[]): Item[] {
  const q = db.prepare(`SELECT repo, number, kind, title, body, additions + deletions AS lines_changed,
    changed_files AS files_changed, author_association FROM items WHERE repo = ? AND number = ?`);
  return refs.map((r) => {
    const row = q.get(r.repo, r.number) as Item | undefined;
    if (!row) throw new Error(`${refOf(r)} is not in the database`);
    return row;
  });
}

type Proc = { code: number | null; stdout: string; stderr: string };
/** `env` is added to the process environment of the child. `onLine` gets each complete line of stdout as it arrives (the whole stdout is still returned). */
export type Runner = (cmd: string, args: string[], input: string, cwd?: string, timeoutMs?: number, env?: Record<string, string>, onLine?: (line: string) => void) => Promise<Proc>;

export function exec(cmd: string, args: string[], input: string, cwd?: string, timeoutMs = 600_000, env?: Record<string, string>, onLine?: (line: string) => void): Promise<Proc> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, ...(env && { env: { ...process.env, ...env } }) });
    let stdout = "", stderr = "";
    let partial = "";
    p.stdout.on("data", (d) => {
      stdout += d;
      if (!onLine) return;
      partial += d;
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const l of lines) try { onLine(l); } catch { /* progress is best effort */ }
    });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

export const POOL_POLL_MS = 500;

export type PoolOptions = {
  /** Run the first job alone and the rest after it returns, so the rest read the prompt cache the first one wrote. */
  first?: boolean;
  /** How long to wait before asking `room` again when nothing finished (default POOL_POLL_MS). */
  pollMs?: number;
};

/**
 * Runs the jobs with at most `width` at once. A function instead of a number
 * is asked before each start how many more jobs may start now (for model
 * calls: the free account slots); it is asked again whenever a job ends or
 * after the poll time. When none of the pool's jobs is running, one starts
 * regardless, so the call itself waits for a slot or reports that no account is enabled.
 * The first failure is thrown once the running jobs have ended.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], width: number | (() => number), opts: PoolOptions = {}): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  const running = new Set<Promise<void>>();
  let next = 0, failed: { e: unknown } | null = null;
  const launch = (): Promise<void> => {
    const i = next++;
    const p: Promise<void> = jobs[i]!().then((r) => void (results[i] = r), (e) => void (failed ??= { e })).finally(() => running.delete(p));
    running.add(p);
    return p;
  };
  if (opts.first && jobs.length > 1) await launch();
  while (next < jobs.length && !failed) {
    const room = typeof width === "number" ? width - running.size : width();
    if (room > 0 || !running.size) {
      launch();
      continue;
    }
    await Promise.race([...running, new Promise((r) => setTimeout(r, opts.pollMs ?? POOL_POLL_MS))]);
  }
  await Promise.all(running);
  if (failed) throw (failed as { e: unknown }).e;
  return results;
}

const now = () => new Date().toISOString();

export type Usage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
  /** Subagent use on other models (the explorer), one entry per model; the fields above count the called model only. */
  extra?: { model: string; usage: Usage }[];
};

const family = (m: string): string => /haiku/i.test(m) ? "haiku" : /sonnet/i.test(m) ? "sonnet" : /opus/i.test(m) ? "opus" : m;

type ModelUsage = Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;

/**
 * Usage of one `claude -p` result. With `modelUsage` (per model, subagents included) the called model's
 * tokens and cost go in the main fields and every other model in `extra`; without it, `usage` and
 * `total_cost_usd` are the called model's. `all` sums the tokens of every model, for the agent run.
 */
export function resultUsage(j: { usage?: Record<string, number>; total_cost_usd?: number; modelUsage?: ModelUsage }, model: string): { usage: Usage; all: { input: number; output: number; cacheRead: number; cacheWrite: number } } {
  const u = j.usage ?? {};
  const plain: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: j.total_cost_usd ?? null };
  const entries = Object.entries(j.modelUsage ?? {});
  if (!entries.length) return { usage: plain, all: { input: plain.input, output: plain.output, cacheRead: plain.cacheRead, cacheWrite: plain.cacheWrite } };
  const by = new Map<string, Usage>();
  for (const [m, x] of entries) {
    const f = family(m), cur = by.get(f) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    by.set(f, { input: cur.input + (x.inputTokens ?? 0), output: cur.output + (x.outputTokens ?? 0), cacheRead: cur.cacheRead + (x.cacheReadInputTokens ?? 0), cacheWrite: cur.cacheWrite + (x.cacheCreationInputTokens ?? 0), cost: (cur.cost ?? 0) + (x.costUSD ?? 0) });
  }
  const mine = family(model);
  const main = by.get(mine) ?? plain;
  by.delete(mine);
  const extra = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([m, usage]) => ({ model: m, usage }));
  const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") => main[k] + extra.reduce((a, e) => a + e.usage[k], 0);
  return { usage: { ...main, ...(extra.length > 0 && { extra }) }, all: { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") } };
}

export function saveVerdict(db: DatabaseSync, classifier: string, runId: string, v: Verdict): void {
  const [repo, num] = v.ref.split("#");
  db.prepare(`INSERT OR REPLACE INTO classifications (repo, number, classifier, run_id, at, type_label, flags, reason, probs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repo!, Number(num), classifier, runId, now(), v.type_label, flagsOf(v), v.reason, v.probs);
}

export function saveUsage(db: DatabaseSync, runId: string, agent: string, stage: string, model: string, items: number, u: Usage, start: string, end: string): void {
  db.prepare(`INSERT OR REPLACE INTO token_usage (run_id, agent, stage, model, items, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, started_at, ended_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, agent, stage, model, items, u.input, u.output, u.cacheRead, u.cacheWrite, start, end, u.cost);
  // Subagent models get their own rows (same run and stage), so the Cost page splits by model and its totals stay whole.
  for (const e of u.extra ?? []) {
    db.prepare(`INSERT OR REPLACE INTO token_usage (run_id, agent, stage, model, items, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, started_at, ended_at, cost_usd) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, `${agent}+${e.model}`, stage, e.model, e.usage.input, e.usage.output, e.usage.cacheRead, e.usage.cacheWrite, start, end, e.usage.cost);
  }
}

let runner: Runner = exec;

/** Tests swap the process runner for a fake; returns a function that restores the real one. */
export function setRunner(r: Runner): () => void {
  runner = r;
  return () => { runner = exec; };
}

const versions = new Map<string, string>();
/** A short hash of the registered prompt text, so runs show which wording they used. */
function promptVersion(id: ClaudePromptId | JevPromptId): string {
  let v = versions.get(id);
  if (!v) {
    const p = id in CLAUDE_PROMPTS ? claudePromptOf(id as ClaudePromptId).template : JSON.stringify(jevPromptOf(id as JevPromptId).request);
    v = createHash("sha256").update(p).digest("hex").slice(0, 10);
    versions.set(id, v);
  }
  return v;
}

/** Item refs of a prompt's input: items carry repo and number, review PRs a `repo#number` ref. */
function refsOf(input: readonly unknown[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const x of input as { repo?: string; number?: number; ref?: string; a?: { number: number }; b?: { number: number }; items?: unknown[] }[]) {
    if (typeof x.repo === "string" && typeof x.number === "number") out.push({ repo: x.repo, number: x.number });
    // An area batch: one repo's list and its items.
    else if (typeof x.repo === "string" && Array.isArray((x as { items?: unknown }).items)) out.push(...refsOf((x as { items: unknown[] }).items));
    // A duplicate pair: both items.
    else if (typeof x.repo === "string" && x.a && x.b) out.push({ repo: x.repo, number: x.a.number }, { repo: x.repo, number: x.b.number });
    else if (typeof x.ref === "string") {
      const r = parseRef(x.ref);
      if (r) out.push(r);
    }
  }
  return out;
}

/** One line for the Agents page: how many answers came back and, where the answers carry one, their verdicts. */
function replySummary(text: string, asked: number): string {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  try {
    const arr = JSON.parse(text.slice(a, b + 1)) as { verdict?: string; type_label?: string }[];
    const tally = new Map<string, number>();
    for (const x of arr) {
      const k = x.verdict ?? x.type_label;
      if (typeof k === "string") tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const parts = [...tally].map(([k, n]) => `${n} ${k}`);
    return `${arr.length} of ${asked} answered${parts.length ? `: ${parts.join(", ")}` : ""}`;
  } catch {
    return "answer is not a JSON list";
  }
}

/** The result of a `--output-format json` run: with a subagent the event list holds several `result` events and the last one is final. */
export const lastResult = <T extends { type?: string }>(parsed: T[] | T): T | undefined => (Array.isArray(parsed) ? parsed.findLast((e) => e.type === "result") : parsed);

function parseOutput(stdout: string): { type?: string }[] | { type?: string } {
  try {
    return JSON.parse(stdout) as { type?: string }[] | { type?: string };
  } catch {
    const events = stdout.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l) as { type?: string }]; } catch { return []; } });
    if (!events.length) throw new Error("no events");
    return events;
  }
}

const exitClass = (code: number | null): string => (code === null ? "timed out or killed" : code === -1 ? "could not start" : `exit code ${code}`);

const madeDirs = new Set<string>();
/**
 * The working directory of every `claude` call: one empty directory under the app's cache, never inside a
 * git repository or below a CLAUDE.md. The CLI puts its working directory into its system prompt, so a
 * directory per call would give each call its own prompt prefix and no call would read the prompt cache.
 */
export function claudeCwd(): string {
  const dir = envVar("CLAUDE_CWD") ?? join(homedir(), ".cache/autocraft/claude-cwd");
  if (!madeDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  }
  return dir;
}

/**
 * `onProgress`: called with a short plain line for each tool call of a sandboxed call, as it happens; the latest line is also kept on the agent run.
 * `checkout`: host directory of a read-only checkout; with it, a prompt that registers a sandbox runs with its tools inside bubblewrap (src/sandbox).
 * `reference`: host directory of the repo's reference documentation; a sandboxed call mounts it read-only at /reference and its prompt says so (src/reference.ts).
 * `shared`: for a prompt with the workspace, replaces the default workspace (every tracked repository's default branch, src/sandbox/workspace.ts).
 * `itemTools`: the item tools' read-only mounts and MCP servers (`mcpServers` as in an MCP config), for the call and its explorer; null means none, absent means `itemTools()` (src/itemtools).
 * `check`: the build tool of a patch call (src/checktool); a sandboxed call of a prompt whose sandbox allows it gets the `check` tool, and the call may run that much longer.
 * `maxWaitMs`: the longest wait for a free account slot; past it the call throws a WaitLimitError (src/agents/call.ts). Absent: wait as long as it takes.
 * `session`: a sandboxed call keeps its session store and reports it in `session.kept` (the caller removes it). With `session.resume` the call continues that session with the message on its account, or returns undefined from `askOnce` when it cannot.
 * `lint`: checks the parsed reply (src/replylint.ts). With problems, and for a sandboxed call of a prompt that registers `lint`, one follow-up message goes to the same session and its reply is linted too.
 */
export type AskOptions = { check?: CheckTool; lint?: Lint; onProgress?: (line: string) => void; checkout?: string; reference?: string; maxWaitMs?: number; shared?: { name: string; dir: string }[]; session?: SessionAsk; itemTools?: { mounts: { host: string; path: string }[]; mcpServers: Record<string, unknown> } | null };

type WorkspaceFn = (db: DatabaseSync) => Promise<{ name: string; dir: string }[]>;
let workspaceOf: WorkspaceFn = defaultWorkspace;
/** Tests swap the workspace lookup; returns a function that restores the real one. */
export function setWorkspace(f: WorkspaceFn): () => void {
  workspaceOf = f;
  return () => { workspaceOf = defaultWorkspace; };
}

/**
 * Sends a registered prompt (src/prompts) to `claude -p`. Callers pass a prompt
 * id and the prompt's input, never prompt text: that keeps every prompt on the
 * Prompts page. A new stage registers its prompt there first.
 *
 * Every call is an agent run: it waits for an enabled account with a free slot
 * and headroom, runs with that account's CLAUDE_CONFIG_DIR, and is recorded from
 * start to end (src/agents).
 */
export type Reply = { text: string; usage: Usage; turns?: number };
/** `problems` are what the lint still found in `text` (absent when there was no lint or the reply could not be linted); `fixTurn` is true when a follow-up message was sent. */
export type LintedReply = Reply & { problems?: LintProblem[]; fixTurn?: boolean };

/** The follow-up message for a patch call whose model answered without running clippy. */
export const CHECK_REMINDER = "You have not run the check tool with command clippy on your final diff. Before you answer you must: call check with command fmt and then command clippy, passing your complete final diff as patch; fix what they report; and reply with the final diff that passed, as the diff only.";

/** Whether a reply with a diff of Rust files came from a call that never got a clippy result from the check tool. */
export function needsClippy(tool: Pick<CheckTool, "ran">, reply: string): boolean {
  return /^\+\+\+ (?:b\/)?\S+\.rs\s*$/m.test(reply) && !tool.ran.has("clippy");
}

export async function askClaude<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: DatabaseSync, opts: AskOptions = {}): Promise<LintedReply | null> {
  const ses = opts.session;
  if (ses?.resume) {
    const r = await askOnce(id, model, input, db, opts);
    if (r) return r;
    // No resume was possible or the resumed turn failed: a new call, whose input carries the earlier patch and the findings.
    const fresh: SessionAsk = {};
    const again = await askOnce(id, model, input, db, { ...opts, session: fresh });
    ses.kept = fresh.kept;
    delete ses.resume;
    return again ?? null;
  }
  return (await askOnce(id, model, input, db, opts)) ?? null;
}

async function askOnce<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: DatabaseSync, opts: AskOptions): Promise<LintedReply | null | undefined> {
  const ses = opts.session;
  let sandboxed = opts.checkout !== undefined && CLAUDE_PROMPTS[id].sandbox !== undefined;
  const reference = sandboxed && CLAUDE_PROMPTS[id].sandbox?.reference ? opts.reference : undefined;
  if (reference) input = input.map((x) => ({ ...x, reference: true })) as ClaudeInput[K];
  let parts = claudeParts(id, input, sandboxed);
  const items = refsOf(input);
  const resume = ses?.resume;
  let run: Started | undefined;
  if (resume) {
    // The session lives in one account's config directory and in a store bound to the same checkout path; without either, or with no room on that account, the caller asks anew.
    const dir = accountConfigDir(db, resume.session.account);
    const margin = TOKEN_MARGIN_MS + (opts.check !== undefined && CLAUDE_PROMPTS[id].sandbox?.check === true ? CHECK_MAX_WALL_MS : 0);
    if (!sandboxed || !dir || resume.session.checkout !== opts.checkout || !existsSync(resume.session.dir) || tokenNearExpiry(join(dir, ".credentials.json"), Date.now(), margin)) return undefined;
    const runId = tryStartFollowUp(db, resume.session.account, { promptId: id, promptVersion: promptVersion(id), provider: "claude", model, items, prompt: resume.message });
    if (runId === null) return undefined;
    run = { runId, configDir: dir, accountId: resume.session.account };
    touchStore(resume.session.dir);
  }
  run ??= await startClaudeRun(db, { promptId: id, promptVersion: promptVersion(id), provider: "claude", model, items, prompt: joinParts(parts) }, undefined, opts.maxWaitMs);
  const end = (e: Parameters<typeof finishRun>[2]) => finishRun(db, run.runId, e);
  let sessions: string | undefined, kept = false;
  let bridge: Bridge | undefined, bridgeConfig: string | undefined;
  try {
    // The sandbox never refreshes the token: with little lifetime left the call runs on the host without tools, where a refresh is safe.
    const checkTool = opts.check !== undefined && CLAUDE_PROMPTS[id].sandbox?.check === true ? opts.check : undefined;
    if (sandboxed && tokenNearExpiry(join(run.configDir, ".credentials.json"), Date.now(), TOKEN_MARGIN_MS + (checkTool ? CHECK_MAX_WALL_MS : 0))) {
      console.log("sandbox skipped: token near expiry");
      // A resume only continues a sandboxed session; the caller asks anew.
      if (resume) {
        end({ state: "failed", summary: "skipped: token near expiry" });
        return undefined;
      }
      sandboxed = false;
      input = withoutRepoDir(input);
      parts = claudeParts(id, input, false);
      db.prepare("UPDATE agent_run_texts SET prompt = ? WHERE run_id = ?").run(scrub(joinParts(parts).slice(0, 1_000_000)), run.runId);
    }
    const workspace = sandboxed && CLAUDE_PROMPTS[id].sandbox?.workspace === true;
    const shared = workspace ? opts.shared ?? await workspaceOf(db) : undefined;
    const it = workspace ? opts.itemTools === undefined ? itemTools() : opts.itemTools : null;
    if (sandboxed && checkTool) bridge = await startBridge(checkTool, run.runId);
    const servers = { ...(it?.mcpServers ?? {}), ...(bridge ? { [CHECK_SERVER]: bridge.mcpServer } : {}) };
    const tools = it || bridge ? { mounts: [...(it?.mounts ?? []), ...(bridge ? [bridge.mount] : [])], servers: Object.keys(servers).sort(), file: mcpFile(servers) } : undefined;
    if (bridge && tools) bridgeConfig = tools.file;
    // Only a sandboxed call can be continued: its session store is a directory of ours. A call on the host keeps no session (it would land in the account's own config directory).
    const persist = sandboxed && ((opts.lint !== undefined && CLAUDE_PROMPTS[id].lint === true) || bridge !== undefined || ses !== undefined);
    if (persist) sessions = resume?.session.dir ?? sessionStore();
    const args = claudeArgs(id, model, sandboxed, tools && { config: MCP_PATH, servers: tools.servers }, parts.system, reference !== undefined, persist);
    const cwd = claudeCwd();
    const timeoutMs = CLAUDE_PROMPTS[id].limits.timeoutSeconds * 1000 + (bridge ? CHECK_MAX_WALL_MS : 0);
    let spec: SandboxSpec | undefined;
    if (sandboxed) {
      const claudeBin = resolveClaudeBin(), credentials = join(run.configDir, ".credentials.json");
      if (!claudeBin || !existsSync(credentials)) throw new Error("sandboxed call: claude binary or the account's credentials file not found");
      spec = { claudeBin, checkout: opts.checkout!, credentials, claudeArgs: args, shared, ...(workspace && { agentsFile: agentsFile(Object.keys(it?.mcpServers ?? {}).sort()) }), ...(sessions && { sessionDir: sessions }), extraMounts: tools || reference ? [...(tools ? [...tools.mounts, { host: tools.file, path: MCP_PATH }] : []), ...(reference ? [{ host: reference, path: REFERENCE_PATH }] : [])] : undefined };
    }

    /** One `claude -p` process on the run `runId`: the first message, or with `resume` a follow-up on the same session. Never throws for a failed call. */
    const turn = async (runId: number, stdin: string, resume?: string): Promise<(Reply & { sessionId?: string }) | null> => {
      const finish = (e: Parameters<typeof finishRun>[2]) => finishRun(db, runId, e);
      const extra = resume ? ["--resume", resume] : [];
      let r: Proc;
      if (spec) {
        const c = sandboxCommand({ ...spec, claudeArgs: [...args, ...extra] });
        const runProgress = coalesce((line: string) => setRunProgress(db, runId, line));
        const feed = lineFeed((line) => { opts.onProgress?.(line); runProgress.push(line); });
        const release = holdCheckouts([opts.checkout!, ...(shared ?? []).map((x) => x.dir)]);
        try {
          r = await runner(c.cmd, c.args, stdin, cwd, timeoutMs, undefined, feed);
        } finally {
          release();
        }
        runProgress.flush();
      } else r = await runner("claude", [...args, ...extra], stdin, cwd, timeoutMs, { CLAUDE_CONFIG_DIR: run.configDir });
      // Stderr is scrubbed up front. For a sandboxed call the reply text is scrubbed after parsing, so a match cannot break the JSON.
      if (sandboxed) r = { ...r, stderr: scrub(r.stderr) };
      try {
        // `--output-format json` prints the event list (older CLI versions only the final result object); stream-json prints one event per line.
        const parsed = parseOutput(r.stdout);
        const j = lastResult(parsed) as { result?: string; is_error?: boolean; session_id?: string; total_cost_usd?: number; num_turns?: number; usage?: Record<string, number>; modelUsage?: ModelUsage } | undefined;
        if (!j) {
          finish({ state: "failed", error: `no result (${exitClass(r.code)}) ${r.stderr}`.slice(0, 400), summary: "no result", output: sandboxed ? scrub(r.stdout) : r.stdout });
          return null;
        }
        const { usage, all: tokens } = resultUsage(j, model);
        if (j.is_error || typeof j.result !== "string") {
          finish({ state: "failed", tokens, error: scrubError(`model error ${typeof j.result === "string" ? j.result : ""}`), summary: "model error", output: sandboxed ? scrub(r.stdout) : r.stdout });
          return null;
        }
        const turns = sandboxed ? j.num_turns : undefined;
        // Backstop: nothing that looks like a token or key leaves the sandbox call.
        const text = sandboxed ? scrub(j.result) : j.result;
        const sessionId = typeof j.session_id === "string" ? j.session_id : (Array.isArray(parsed) ? parsed.find((e) => typeof (e as { session_id?: unknown }).session_id === "string") as { session_id?: string } | undefined : undefined)?.session_id;
        finish({ state: "done", tokens, summary: (resume ? "fix turn answered" : turns === undefined ? replySummary(text, items.length) : `answered in ${turns} turns`) + (!resume && checkTool && checkTool.calls ? `, ${checkTool.calls} checks (${Math.round(checkTool.usedMs / 1000)} s)` : ""), output: text });
        return { text, usage, ...(turns !== undefined && { turns }), ...(sessionId && { sessionId }) };
      } catch {
        finish({ state: "failed", error: scrubError(`unreadable output (${exitClass(r.code)}) ${r.stderr}`), summary: r.code === 0 ? "unreadable output" : exitClass(r.code), output: sandboxed ? scrub(r.stdout) : r.stdout });
        return null;
      }
    };

    const first = await turn(run.runId, resume ? resume.message : parts.stdin, resume?.session.id);
    if (!first) return null;
    let { sessionId, ...reply } = first;
    // The prompt tells the model to run clippy on its final diff, and a model may skip it: one follow-up message on the same session asks for it.
    if (bridge && sessions && sessionId && checkTool && needsClippy(checkTool, reply.text) && !(spec && tokenNearExpiry(spec.credentials, Date.now(), timeoutMs + TOKEN_MARGIN_MS))) {
      const message = CHECK_REMINDER;
      let started: number | null = null;
      try { started = tryStartFollowUp(db, run.accountId, { promptId: id, promptVersion: promptVersion(id), provider: "claude", model, items, prompt: message }); } catch (e) { console.log(`check reminder not started: ${(e as Error).message}`); }
      if (started !== null) {
        let again: (Reply & { sessionId?: string }) | null = null;
        try { again = await turn(started, message, sessionId); } catch (e) { finishRun(db, started, { state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" }); }
        if (again) {
          reply = { text: again.text, usage: add(reply.usage, again.usage), ...(reply.turns !== undefined && { turns: reply.turns }) };
          sessionId = again.sessionId ?? sessionId;
        }
      }
    }
    if (ses && sessions && sessionId && sandboxed) {
      ses.kept = { id: sessionId, dir: sessions, account: run.accountId, checkout: opts.checkout! };
      kept = true;
    }
    if (!opts.lint) return reply;
    let problems: LintProblem[] | null = null;
    try { problems = await opts.lint(reply.text, "first"); } catch (e) { if (e instanceof CancelledError) throw e; console.log(`lint failed: ${(e as Error).message}`); }
    if (problems === null) return reply;
    if (!problems.length) return { ...reply, problems };
    if (!sessions || !sessionId) return { ...reply, problems };
    // The fix turn can run as long as the call's own limit; with less token life than that (plus the sandbox's margin) it is skipped, because the sandbox never refreshes the token.
    if (spec && tokenNearExpiry(spec.credentials, Date.now(), timeoutMs + TOKEN_MARGIN_MS)) {
      console.log("fix turn skipped: token near expiry");
      return { ...reply, problems };
    }

    // One fix turn on the same session and account; its own agent run, so its tokens and outcome show on the Agents page.
    const message = fixTurnMessage(problems);
    let fixRun: number;
    try {
      const started = tryStartFollowUp(db, run.accountId, { promptId: id, promptVersion: promptVersion(id), provider: "claude", model, items, prompt: message });
      if (started === null) {
        console.log("fix turn skipped: the account has no free slot or headroom");
        return { ...reply, problems };
      }
      fixRun = started;
    } catch (e) {
      console.log(`fix turn not started: ${(e as Error).message}`);
      return { ...reply, problems };
    }
    let fix: (Reply & { sessionId?: string }) | null = null;
    try {
      fix = await turn(fixRun, message, sessionId);
    } catch (e) {
      finishRun(db, fixRun, { state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    }
    if (!fix) return { ...reply, problems, fixTurn: true };
    const total = add(reply.usage, fix.usage);
    let after: LintProblem[] | null = null;
    try { after = await opts.lint(fix.text, "fix"); } catch (e) { if (e instanceof CancelledError) throw e; console.log(`lint failed: ${(e as Error).message}`); }
    // A fix reply the lint cannot read (or that is not in the format) is not used; the first reply stands.
    if (after === null) return { text: reply.text, usage: total, ...(reply.turns !== undefined && { turns: reply.turns }), problems, fixTurn: true };
    return { text: fix.text, usage: total, ...(reply.turns !== undefined && { turns: reply.turns }), problems: after, fixTurn: true };
  } catch (e) {
    end({ state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    throw e;
  } finally {
    if (sessions && !kept) rmSync(sessions, { recursive: true, force: true });
    bridge?.close();
    // Check tasks still open when the call ends (killed, timed out, parallel leftovers) are cancelled.
    opts.check?.close();
    // The config of a bridged call holds that call's token.
    if (bridgeConfig) rmSync(bridgeConfig, { force: true });
  }
}

/** Sends a registered Jev request (src/prompts) for one item to `jev ask`; the same rule as `askClaude`. Recorded as an agent run without an account. */
export async function askJev(id: JevPromptId, item: Item | DupePair | { ref: string }, db: DatabaseSync, body: string = renderJev(id, item as Item | DupePair), perCallUsage = true): Promise<Proc> {
  const runId = startJevRun(db, { promptId: id, promptVersion: promptVersion(id), provider: "jev", model: "jev", items: refsOf([item]), prompt: body });
  const start = now();
  try {
    const r = await runner("jev", JEV_ARGS, body, undefined, JEV_PROMPTS[id].limits.timeoutSeconds * 1000);
    let tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    try {
      const j = JSON.parse(r.stdout) as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (j.usage) tokens = { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 };
    } catch { /* the caller reports an unreadable answer */ }
    // A step that sums its retries into one row (usage option of runModelStep) saves nothing here.
    if (tokens && perCallUsage) saveUsage(db, String(runId), "jev", id.split(".")[0]!, JEV_PROMPTS[id].models[0]!, 1, { ...tokens, cost: tokens.input * JEV_USD_PER_INPUT_TOKEN }, start, now());
    const outage = jevFailure(r);
    if (outage) markJevUnavailable(db, outage.kind, outage.reason);
    else if (r.code === 0) markJevWorking(db, Date.parse(start));
    if (r.code === 0 && tokens) finishRun(db, runId, { state: "done", tokens, summary: "answered", output: r.stdout });
    else finishRun(db, runId, { state: "failed", error: scrubError(`${exitClass(r.code)} ${r.stderr}`), summary: r.code === 0 ? "unreadable answer" : exitClass(r.code), output: r.stdout });
    return r;
  } catch (e) {
    finishRun(db, runId, { state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    throw e;
  }
}

export const add = (a: Usage, b: Usage): Usage => {
  const extra = new Map<string, Usage>();
  for (const e of [...(a.extra ?? []), ...(b.extra ?? [])]) extra.set(e.model, add(extra.get(e.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, e.usage));
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0), ...(extra.size > 0 && { extra: [...extra].map(([model, usage]) => ({ model, usage })) }) };
};

const HAIKU = CLAUDE_PROMPTS["classify.haiku"];

export async function runHaiku(db: DatabaseSync, runId: string, items: Item[], batchSize = HAIKU.limits.perCall, model = HAIKU.models[0]!, opts: { cold?: boolean } = {}): Promise<void> {
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  await pool(batches.map((batch, n) => async () => {
    const r = await runModelStep(db, CLASSIFY_HAIKU, batch, { model, usage: { run: runId, agent: `haiku-${String(n).padStart(2, "0")}`, stage: "classify" } });
    if (r.ok) for (const verdicts of r.values) for (const v of verdicts) saveVerdict(db, "haiku", runId, v);
    const left = r.ok ? r.rest ?? [] : batch;
    if (left.length) console.error(`haiku batch ${n}: no valid answer for ${left.map(refOf).join(", ")}`);
  }), () => claudeRoom(db), { first: opts.cold });
}

export async function runJev(db: DatabaseSync, runId: string, items: Item[], width = jevParallel(db)): Promise<void> {
  await pool(items.map((item) => async () => {
    // Once a call shows Jev is unavailable, the items still waiting are left for Haiku.
    if (!jevAvailable(db)) return;
    const ref = refOf(item);
    const r = await runModelStep(db, CLASSIFY_JEV, item, { usage: { run: runId, agent: `jev-${ref}`, stage: "classify", items: (ok) => (ok ? 1 : 0), withoutUsage: true, skipWhen: (x) => !x.ok && !jevAvailable(db) } });
    if (r.ok) saveVerdict(db, "jev", runId, r.value);
    else if (jevAvailable(db)) console.error(`jev: no valid answer for ${ref}`);
  }), width);
}
