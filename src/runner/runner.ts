// `craft-auto runner serve`: the only process that runs pipeline steps. It
// polls the jobs table, runs each job in its own child process (`craft-auto
// runner exec <id>`, its own process group, output to a per-job log file),
// stops jobs whose cancel was requested, enqueues scheduled jobs and marks
// jobs left running by an earlier runner as failed.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dbPath } from "../db.ts";
import { enqueue, JobError, jobRow, now, scheduleRows } from "./jobs.ts";
import { loadSteps } from "./steps.ts";

export const logsDir = (): string => process.env.CRAFT_AUTO_RUNNER_LOGS ?? join(homedir(), ".cache/craft-automation-logs/jobs");

export function runnerLockPath(): string {
  const dir = process.env.CRAFT_AUTO_LOCK_DIR ?? join(homedir(), ".cache/craft-automation-logs");
  return join(dir, `runner-${basename(dbPath())}.lock`);
}

export const HEARTBEAT_KEY = "runner_heartbeat";
const CLI = new URL("../cli.ts", import.meta.url).pathname;

export type RunnerOptions = {
  db: DatabaseSync;
  /** Database file the children open; default CRAFT_AUTO_DB or the default path. */
  dbFile?: string;
  logs?: string;
  /** Most jobs running at once (each group still runs one at a time). */
  maxJobs?: number;
  /** Time a job gets to stop after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  lockFile?: string;
  log?: (line: string) => void;
};

type Running = { child: ChildProcess; group: string; termAt: number | null; exited: Promise<void> };

/** True when `pid` is alive and is the child of job `id`. */
function isJobProcess(pid: number, id: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").includes(`runner exec ${id}`);
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export class Runner {
  readonly db: DatabaseSync;
  readonly running = new Map<number, Running>();
  private stopping = false;
  private readonly o: Required<Omit<RunnerOptions, "db" | "lockFile">> & { lockFile: string | null };

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.o = {
      dbFile: opts.dbFile ?? dbPath(), logs: opts.logs ?? logsDir(), maxJobs: opts.maxJobs ?? 2, killAfterMs: opts.killAfterMs ?? 10_000,
      lockFile: opts.lockFile ?? null, log: opts.log ?? ((l) => console.log(l)),
    };
    mkdirSync(this.o.logs, { recursive: true });
  }

  /** Jobs left `running` belong to a runner that is gone: stop what is left of them and mark them failed. */
  recover(): number {
    const rows = this.db.prepare("SELECT id, pid, cancel_requested_at FROM jobs WHERE state = 'running'").all() as { id: number; pid: number | null; cancel_requested_at: string | null }[];
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      if (r.pid && isJobProcess(r.pid, r.id)) killGroup(r.pid, "SIGKILL");
      const cancelled = r.cancel_requested_at !== null;
      this.db.prepare("UPDATE jobs SET state = ?, ended_at = ?, pid = NULL, error = COALESCE(error, ?) WHERE id = ? AND state = 'running'")
        .run(cancelled ? "cancelled" : "failed", now(), cancelled ? null : "The runner stopped while this job ran; start it again if needed.", r.id);
      this.o.log(`job ${r.id}: left running by an earlier runner, marked ${cancelled ? "cancelled" : "failed"}`);
    }
    return rows.length;
  }

  /** One pass: heartbeat, cancels, schedules, new jobs. */
  async tick(): Promise<void> {
    const t = now();
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(HEARTBEAT_KEY, t);
    if (this.o.lockFile) {
      try {
        utimesSync(this.o.lockFile, new Date(), new Date());
      } catch {
        // removed under us; the next start notices
      }
    }
    this.cancels();
    if (this.stopping) return;
    await this.schedules();
    await this.startJobs();
  }

  private cancels(): void {
    for (const [id, r] of this.running) {
      const row = this.db.prepare("SELECT cancel_requested_at FROM jobs WHERE id = ?").get(id) as { cancel_requested_at: string | null } | undefined;
      if (!row?.cancel_requested_at && !this.stopping) continue;
      const pid = r.child.pid;
      if (!pid) continue;
      if (r.termAt === null) {
        r.termAt = Date.now();
        killGroup(pid, "SIGTERM");
        this.o.log(`job ${id}: stopping (${this.stopping ? "runner stopping" : "cancel requested"})`);
      } else if (Date.now() - r.termAt >= this.o.killAfterMs) {
        killGroup(pid, "SIGKILL");
      }
    }
  }

  private busy(step: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE step = ? AND state IN ('queued', 'running')").get(step);
  }

  private async schedules(): Promise<void> {
    const steps = await loadSteps();
    const sync = (this.db.prepare("SELECT value FROM settings WHERE key = 'org_high_water'").get() as { value: string } | undefined)?.value ?? null;
    for (const s of scheduleRows(this.db)) {
      if (!s.enabled || !steps.has(s.step) || this.busy(s.step)) continue;
      const due = s.trigger === "after-sync"
        ? sync !== null && sync !== s.last_sync_seen
        : !s.last_enqueued_at || Date.now() - Date.parse(s.last_enqueued_at) >= (s.interval_minutes ?? 60) * 60_000;
      if (!due) continue;
      const t = now();
      this.db.prepare("UPDATE job_schedules SET last_enqueued_at = ?, last_sync_seen = ? WHERE step = ?").run(t, sync, s.step);
      try {
        const job = await enqueue(this.db, s.step, JSON.parse(s.params), "schedule", s.step);
        this.o.log(`job ${job.id}: ${s.step} queued by its schedule`);
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
        this.o.log(`schedule ${s.step}: not queued: ${e.message}`);
      }
    }
  }

  private async startJobs(): Promise<void> {
    const steps = await loadSteps();
    const queued = this.db.prepare("SELECT id, step FROM jobs WHERE state = 'queued' ORDER BY id").all() as { id: number; step: string }[];
    for (const q of queued) {
      if (this.running.size >= this.o.maxJobs) return;
      const step = steps.get(q.step);
      if (!step) {
        this.db.prepare("UPDATE jobs SET state = 'failed', ended_at = ?, error = ? WHERE id = ? AND state = 'queued'").run(now(), "This step does not exist in this build.", q.id);
        continue;
      }
      if ([...this.running.values()].some((r) => r.group === step.group)) continue;
      this.start(q.id, step.group);
    }
  }

  private start(id: number, group: string): void {
    const logPath = join(this.o.logs, `job-${id}.log`);
    const claimed = this.db.prepare("UPDATE jobs SET state = 'running', started_at = ?, log_path = ? WHERE id = ? AND state = 'queued'").run(now(), logPath, id).changes;
    if (!claimed) return;
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [CLI, "runner", "exec", String(id)], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, CRAFT_AUTO_DB: this.o.dbFile },
      });
    } finally {
      closeSync(fd);
    }
    this.db.prepare("UPDATE jobs SET pid = ? WHERE id = ?").run(child.pid ?? null, id);
    this.o.log(`job ${id}: started (pid ${child.pid})`);
    let spawnError: string | null = null;
    child.on("error", (e) => (spawnError = e.message));
    const exited = new Promise<void>((resolve) => {
      child.on("close", (code, signal) => {
        this.finish(id, code, signal, spawnError);
        this.running.delete(id);
        resolve();
      });
    });
    this.running.set(id, { child, group, termAt: null, exited });
  }

  private finish(id: number, code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): void {
    const row = jobRow(this.db, id);
    if (!row || row.state !== "running") return;
    let state: "done" | "failed" | "cancelled";
    let error: string | null = row.error;
    if (row.cancel_requested_at) state = "cancelled";
    else if (code === 0) state = "done";
    else {
      state = "failed";
      if (this.stopping) error = "The runner stopped while this job ran; start it again if needed.";
      error ??= spawnError ?? (signal ? `The job's process ended on ${signal}.` : `The job's process exited with code ${code}.`);
    }
    this.db.prepare("UPDATE jobs SET state = ?, ended_at = ?, pid = NULL, error = ?, progress = CASE WHEN ? = 'done' THEN NULL ELSE progress END WHERE id = ?")
      .run(state, now(), state === "failed" ? error : null, state, id);
    this.o.log(`job ${id}: ${state}${state === "failed" && error ? `: ${error}` : ""}`);
  }

  /** Resolves when every running job has ended. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.exited));
  }

  /** Stops every running job (SIGTERM, then SIGKILL after the grace time) and waits for them. */
  async stop(): Promise<void> {
    this.stopping = true;
    const timer = setInterval(() => this.cancels(), 500);
    this.cancels();
    await this.idle();
    clearInterval(timer);
  }

  /** Polls until `signal` aborts, then stops running jobs. */
  async serve(signal: AbortSignal, pollMs = 2000): Promise<void> {
    this.recover();
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        this.o.log(`runner: ${(e as Error).stack ?? e}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    await this.stop();
  }
}
