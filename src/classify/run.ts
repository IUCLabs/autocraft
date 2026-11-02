// Runs the classifiers: Jev (one `jev ask` per item) and Haiku (batches through `claude -p`).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "../../web/src/api/types.ts";
import { createHash } from "node:crypto";
import { jevParallel } from "../agents/accounts.ts";
import { claudeRoom, startClaudeRun, startJevRun } from "../agents/call.ts";
import { finishRun } from "../agents/runs.ts";
import { scrubError } from "../agents/text.ts";
import { CLAUDE_PROMPTS, JEV_ARGS, JEV_PROMPTS, claudeArgs, claudePromptOf, jevPromptOf, renderClaude, renderJev, type ClaudeInput, type ClaudePromptId, type JevPromptId } from "../prompts/index.ts";
import { flagsOf, jevVerdict, parseHaikuReply, parseRef, refOf, type Item, type JevAnswers, type Verdict } from "./parse.ts";

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
/** `env` is added to the process environment of the child. */
export type Runner = (cmd: string, args: string[], input: string, cwd?: string, timeoutMs?: number, env?: Record<string, string>) => Promise<Proc>;

export function exec(cmd: string, args: string[], input: string, cwd?: string, timeoutMs = 600_000, env?: Record<string, string>): Promise<Proc> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, ...(env && { env: { ...process.env, ...env } }) });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
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

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null };

export function saveVerdict(db: DatabaseSync, classifier: string, runId: string, v: Verdict): void {
  const [repo, num] = v.ref.split("#");
  db.prepare(`INSERT OR REPLACE INTO classifications (repo, number, classifier, run_id, at, type_label, flags, reason, probs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repo!, Number(num), classifier, runId, now(), v.type_label, flagsOf(v), v.reason, v.probs);
}

export function saveUsage(db: DatabaseSync, runId: string, agent: string, stage: string, model: string, items: number, u: Usage, start: string, end: string): void {
  db.prepare(`INSERT OR REPLACE INTO token_usage (run_id, agent, stage, model, items, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, started_at, ended_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, agent, stage, model, items, u.input, u.output, u.cacheRead, u.cacheWrite, start, end, u.cost);
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
  for (const x of input as { repo?: string; number?: number; ref?: string }[]) {
    if (typeof x.repo === "string" && typeof x.number === "number") out.push({ repo: x.repo, number: x.number });
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

const exitClass = (code: number | null): string => (code === null ? "timed out or killed" : code === -1 ? "could not start" : `exit code ${code}`);

/**
 * Sends a registered prompt (src/prompts) to `claude -p`. Callers pass a prompt
 * id and the prompt's input, never prompt text: that keeps every prompt on the
 * Prompts page. A new stage registers its prompt there first.
 *
 * Every call is an agent run: it waits for an enabled account with a free slot
 * and headroom, runs with that account's CLAUDE_CONFIG_DIR, and is recorded from
 * start to end (src/agents).
 */
export async function askClaude<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: DatabaseSync): Promise<{ text: string; usage: Usage } | null> {
  const args = claudeArgs(id, model);
  const prompt = renderClaude(id, input);
  const items = refsOf(input);
  const run = await startClaudeRun(db, { promptId: id, promptVersion: promptVersion(id), provider: "claude", model, items, prompt });
  const end = (e: Parameters<typeof finishRun>[2]) => finishRun(db, run.runId, e);
  try {
    const cwd = mkdtempSync(join(tmpdir(), "classify-"));
    const r = await runner("claude", args, prompt, cwd, CLAUDE_PROMPTS[id].limits.timeoutSeconds * 1000, { CLAUDE_CONFIG_DIR: run.configDir });
    try {
      // Some CLI versions print the event list, others only the final result object.
      const parsed = JSON.parse(r.stdout) as { type?: string }[] | { type?: string };
      const j = (Array.isArray(parsed) ? parsed.find((e) => e.type === "result") : parsed) as { result?: string; is_error?: boolean; total_cost_usd?: number; usage?: Record<string, number> } | undefined;
      if (!j) {
        end({ state: "failed", error: `no result (${exitClass(r.code)}) ${r.stderr}`.slice(0, 400), summary: "no result", output: r.stdout });
        return null;
      }
      const u = j.usage ?? {};
      const usage: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: j.total_cost_usd ?? null };
      const tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
      if (j.is_error || typeof j.result !== "string") {
        end({ state: "failed", tokens, error: scrubError(`model error ${typeof j.result === "string" ? j.result : ""}`), summary: "model error", output: r.stdout });
        return null;
      }
      end({ state: "done", tokens, summary: replySummary(j.result, items.length), output: j.result });
      return { text: j.result, usage };
    } catch {
      end({ state: "failed", error: scrubError(`unreadable output (${exitClass(r.code)}) ${r.stderr}`), summary: r.code === 0 ? "unreadable output" : exitClass(r.code), output: r.stdout });
      return null;
    }
  } catch (e) {
    end({ state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    throw e;
  }
}

/** Sends a registered Jev request (src/prompts) for one item to `jev ask`; the same rule as `askClaude`. Recorded as an agent run without an account. */
export async function askJev(id: JevPromptId, item: Item, db: DatabaseSync): Promise<Proc> {
  const body = renderJev(id, item);
  const runId = startJevRun(db, { promptId: id, promptVersion: promptVersion(id), provider: "jev", model: "jev", items: refsOf([item]), prompt: body });
  try {
    const r = await runner("jev", JEV_ARGS, body, undefined, JEV_PROMPTS[id].limits.timeoutSeconds * 1000);
    let tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    try {
      const j = JSON.parse(r.stdout) as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (j.usage) tokens = { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 };
    } catch { /* the caller reports an unreadable answer */ }
    if (r.code === 0 && tokens) finishRun(db, runId, { state: "done", tokens, summary: "answered", output: r.stdout });
    else finishRun(db, runId, { state: "failed", error: scrubError(`${exitClass(r.code)} ${r.stderr}`), summary: r.code === 0 ? "unreadable answer" : exitClass(r.code), output: r.stdout });
    return r;
  } catch (e) {
    finishRun(db, runId, { state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    throw e;
  }
}

export const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0) });

const HAIKU = CLAUDE_PROMPTS["classify.haiku"];

export async function runHaiku(db: DatabaseSync, runId: string, items: Item[], batchSize = HAIKU.limits.perCall, model = HAIKU.models[0]!, opts: { cold?: boolean } = {}): Promise<void> {
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  await pool(batches.map((batch, n) => async () => {
    const start = now();
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let todo = batch;
    for (let attempt = 0; attempt < HAIKU.limits.attempts && todo.length; attempt++) {
      const reply = await askClaude("classify.haiku", model, todo, db);
      if (!reply) continue;
      usage = add(usage, reply.usage);
      const { verdicts, missing } = parseHaikuReply(reply.text, todo.map(refOf));
      for (const v of verdicts) saveVerdict(db, "haiku", runId, v);
      todo = todo.filter((i) => missing.includes(refOf(i)));
    }
    if (todo.length) console.error(`haiku batch ${n}: no valid answer for ${todo.map(refOf).join(", ")}`);
    saveUsage(db, runId, `haiku-${String(n).padStart(2, "0")}`, "classify", model, batch.length - todo.length, usage, start, now());
  }), () => claudeRoom(db), { first: opts.cold });
}

const JEV = JEV_PROMPTS["classify.jev"];

export async function runJev(db: DatabaseSync, runId: string, items: Item[], width = jevParallel(db)): Promise<void> {
  await pool(items.map((item) => async () => {
    const ref = refOf(item), start = now();
    let v: Verdict | null = null;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    for (let attempt = 0; attempt < JEV.limits.attempts && !v; attempt++) {
      const r = await askJev("classify.jev", item, db);
      try {
        const j = JSON.parse(r.stdout) as { answers?: JevAnswers; usage?: { input_tokens?: number; output_tokens?: number } };
        usage = add(usage, { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0, cost: null });
        v = j.answers ? jevVerdict(ref, j.answers) : null;
      } catch { /* retry once */ }
    }
    if (v) saveVerdict(db, "jev", runId, v);
    else console.error(`jev: no valid answer for ${ref}`);
    saveUsage(db, runId, `jev-${ref}`, "classify", JEV.models[0]!, v ? 1 : 0, usage, start, now());
  }), width);
}
