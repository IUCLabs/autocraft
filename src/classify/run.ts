// Runs the classifiers: Jev (one `jev ask` per item) and Haiku (batches through `claude -p`).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_PROMPTS, JEV_ARGS, JEV_PROMPTS, claudeArgs, renderClaude, renderJev, type ClaudeInput, type ClaudePromptId, type JevPromptId } from "../prompts/index.ts";
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
export type Runner = (cmd: string, args: string[], input: string, cwd?: string, timeoutMs?: number) => Promise<Proc>;

export function exec(cmd: string, args: string[], input: string, cwd?: string, timeoutMs = 600_000): Promise<Proc> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

export async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]!();
    }
  }));
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

/**
 * Sends a registered prompt (src/prompts) to `claude -p`. Callers pass a prompt
 * id and the prompt's input, never prompt text: that keeps every prompt on the
 * Prompts page. A new stage registers its prompt there first.
 */
export async function askClaude<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K]): Promise<{ text: string; usage: Usage } | null> {
  const args = claudeArgs(id, model);
  const cwd = mkdtempSync(join(tmpdir(), "classify-"));
  const r = await runner("claude", args, renderClaude(id, input), cwd, CLAUDE_PROMPTS[id].limits.timeoutSeconds * 1000);
  try {
    // Some CLI versions print the event list, others only the final result object.
    const parsed = JSON.parse(r.stdout) as { type?: string }[] | { type?: string };
    const j = (Array.isArray(parsed) ? parsed.find((e) => e.type === "result") : parsed) as { result?: string; is_error?: boolean; total_cost_usd?: number; usage?: Record<string, number> } | undefined;
    if (!j) return null;
    if (j.is_error || typeof j.result !== "string") return null;
    const u = j.usage ?? {};
    return {
      text: j.result,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: j.total_cost_usd ?? null },
    };
  } catch {
    return null;
  }
}

/** Sends a registered Jev request (src/prompts) for one item to `jev ask`; the same rule as `askClaude`. */
export function askJev(id: JevPromptId, item: Item): Promise<Proc> {
  return runner("jev", JEV_ARGS, renderJev(id, item), undefined, JEV_PROMPTS[id].limits.timeoutSeconds * 1000);
}

export const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0) });

const HAIKU = CLAUDE_PROMPTS["classify.haiku"];

export async function runHaiku(db: DatabaseSync, runId: string, items: Item[], batchSize = HAIKU.limits.perCall, width = HAIKU.limits.parallel, model = HAIKU.models[0]!): Promise<void> {
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  await pool(batches.map((batch, n) => async () => {
    const start = now();
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let todo = batch;
    for (let attempt = 0; attempt < HAIKU.limits.attempts && todo.length; attempt++) {
      const reply = await askClaude("classify.haiku", model, todo);
      if (!reply) continue;
      usage = add(usage, reply.usage);
      const { verdicts, missing } = parseHaikuReply(reply.text, todo.map(refOf));
      for (const v of verdicts) saveVerdict(db, "haiku", runId, v);
      todo = todo.filter((i) => missing.includes(refOf(i)));
    }
    if (todo.length) console.error(`haiku batch ${n}: no valid answer for ${todo.map(refOf).join(", ")}`);
    saveUsage(db, runId, `haiku-${String(n).padStart(2, "0")}`, "classify", model, batch.length - todo.length, usage, start, now());
  }), width);
}

const JEV = JEV_PROMPTS["classify.jev"];

export async function runJev(db: DatabaseSync, runId: string, items: Item[], width = JEV.limits.parallel): Promise<void> {
  await pool(items.map((item) => async () => {
    const ref = refOf(item), start = now();
    let v: Verdict | null = null;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    for (let attempt = 0; attempt < JEV.limits.attempts && !v; attempt++) {
      const r = await askJev("classify.jev", item);
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
