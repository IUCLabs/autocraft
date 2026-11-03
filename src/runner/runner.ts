// `craft-auto runner serve`: the only process that runs pipeline steps. It
// polls the jobs table, runs each job in its own child process (`craft-auto
// runner exec <id>`, its own process group, output to a per-job log file),
// stops jobs whose cancel was requested, runs the autopilot (queues jobs while the
// pipeline switch is on) and marks
// jobs left running by an earlier runner as failed.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dbPath } from "../db.ts";
import { applyProposals, AUTOPILOT_USER, isEnabled, planDue, type Detected } from "./autopilot.ts";
import { recordUsageSamples } from "../agents/accounts.ts";
import { AccountWatcher } from "../agents/manage.ts";
import { failRunning, pruneRuns } from "../agents/runs.ts";
import { pruneTasks, reapLost } from "../build/tasks.ts";
import { checkPendingUpdate } from "../build/worker-update.ts";
import { jobRow, now, pruneJobs, RUNNER_STOPPED } from "./jobs.ts";
import { OffThread } from "./offthread.ts";
import { loadSteps } from "./steps.ts";

export const logsDir = (): string => process.env.CRAFT_AUTO_RUNNER_LOGS ?? join(homedir(), ".cache/craft-automation-logs/jobs");

export function runnerLockPath(): string {
  const dir = process.env.CRAFT_AUTO_LOCK_DIR ?? join(homedir(), ".cache/craft-automation-logs");
  return join(dir, `runner-${basename(dbPath())}.lock`);
}

export const HEARTBEAT_KEY = "runner_heartbeat";
/** How often the runner brings the flowchart summary up to date (src/flow/summary.ts). */
export const FLOW_EVERY_MS = 20_000;
const CLI = new URL("../cli.ts", import.meta.url).pathname;

/** Enough for every concurrency group to have a job running. */
export const DEFAULT_MAX_JOBS = 11;

export type RunnerOptions = {
  db: DatabaseSync;
  /** Database file the children open; default CRAFT_AUTO_DB or the default path. */
  dbFile?: string;
  logs?: string;
  /** Most jobs running at once (each concurrency group still runs one at a time). */
  maxJobs?: number;
  /** Time a job gets to stop after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  lockFile?: string;
  log?: (line: string) => void;
  /** The planner's detection pass (default: a worker thread on its own connection to `dbFile`). Tests pass a fake. */
  detect?: (nowMs: number) => Promise<Detected>;
  /** The flowchart summary refresh (default: a worker thread). */
  refreshFlow?: () => Promise<unknown>;
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
  private flowAt = 0;
  private planning: Promise<void> | null = null;
  private detected: Detected | null = null;
  private flowing: Promise<void> | null = null;
  private readonly planThread: OffThread;
  private readonly flowThread: OffThread;
  private readonly o: Required<Omit<RunnerOptions, "db" | "lockFile" | "detect" | "refreshFlow">> & { lockFile: string | null };
  private readonly detect: (nowMs: number) => Promise<Detected>;
  private readonly refreshFlow: () => Promise<unknown>;

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.o = {
      dbFile: opts.dbFile ?? dbPath(), logs: opts.logs ?? logsDir(), maxJobs: opts.maxJobs ?? DEFAULT_MAX_JOBS, killAfterMs: opts.killAfterMs ?? 10_000,
      lockFile: opts.lockFile ?? null, log: opts.log ?? ((l) => console.log(l)),
    };
    mkdirSync(this.o.logs, { recursive: true });
    this.planThread = new OffThread(this.o.dbFile);
    this.flowThread = new OffThread(this.o.dbFile);
    this.detect = opts.detect ?? ((t) => this.planThread.plan(t));
    this.refreshFlow = opts.refreshFlow ?? (() => this.flowThread.flow());
  }

  /** Jobs left `running` belong to a runner that is gone: stop what is left of them and mark them failed. */
  recover(): number {
    // Model calls of a runner that is gone no longer hold an account slot.
    const orphans = failRunning(this.db, "The runner stopped during this call.");
    if (orphans) this.o.log(`${orphans} agent runs left running by an earlier runner, marked failed`);
    const rows = this.db.prepare("SELECT id, pid, cancel_requested_at FROM jobs WHERE state = 'running'").all() as { id: number; pid: number | null; cancel_requested_at: string | null }[];
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      if (r.pid && isJobProcess(r.pid, r.id)) killGroup(r.pid, "SIGKILL");
      const cancelled = r.cancel_requested_at !== null;
      this.db.prepare("UPDATE jobs SET state = ?, ended_at = ?, pid = NULL, error = COALESCE(error, ?) WHERE id = ? AND state = 'running'")
        .run(cancelled ? "cancelled" : "failed", now(), cancelled ? null : RUNNER_STOPPED, r.id);
      this.o.log(`job ${r.id}: left running by an earlier runner, marked ${cancelled ? "cancelled" : "failed"}`);
    }
    return rows.length;
  }

  /** One pass: heartbeat, cancels, autopilot, new jobs. */
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
    try {
      const lost = reapLost(this.db);
      if (lost) this.o.log(`${lost} build tasks lost their worker`);
    } catch (e) {
      this.o.log(`build tasks: ${(e as Error).message}`);
    }
    this.usageTick();
    this.workerUpdateTick();
    await this.autopilot();
    await this.startJobs();
    if (!this.flowing && Date.now() - this.flowAt >= FLOW_EVERY_MS) {
      this.flowAt = Date.now();
      this.flowing = this.refreshFlow().then(() => undefined, (e) => this.o.log(`flowchart summary: ${(e as Error).message}`)).finally(() => (this.flowing = null));
    }
  }

  /**
   * The planner. Detection reads a lot and runs off the loop, at most one pass at a time; the
   * tick queues what it found, so a slow detection never delays the heartbeat or cancels.
   */
  private async autopilot(): Promise<void> {
    const found = this.detected;
    this.detected = null;
    if (found) {
      for (const l of found.logs) this.o.log(l);
      try {
        // Detection read the database a moment ago; the switch may have been turned off since.
        if (isEnabled(this.db)) await applyProposals(this.db, found.proposals, { log: this.o.log });
      } catch (e) {
        this.o.log(`autopilot: ${(e as Error).message}`);
      }
    }
    if (this.planning || !planDue(this.db)) return;
    this.planning = this.detect(Date.now())
      .then((d) => { this.detected = d; }, (e) => this.o.log(`autopilot: detection failed: ${(e as Error).message}`))
      .finally(() => (this.planning = null));
  }

  private updateAt = 0;
  private updating = false;

  /** About once a minute, runs the sandbox worker update that a deploy left pending once its tasks have finished. */
  private workerUpdateTick(): void {
    if (this.updating || Date.now() - this.updateAt < 60_000) return;
    this.updateAt = Date.now();
    this.updating = true;
    checkPendingUpdate(this.db, undefined, this.o.log)
      .catch((e) => this.o.log(`worker update: ${(e as Error).message}`))
      .finally(() => (this.updating = false));
  }

  private usageAt = 0;
  private refreshAt = 0;
  private pruneAt = 0;
  private watcher: AccountWatcher | undefined;

  /** Records usage readings that changed (at most every 15 s), reads sign-in state (every 15 minutes) and plan usage (every 5) of accounts through the claude command, and prunes old agent data hourly. */
  private usageTick(): void {
    const t = Date.now();
    if (t - this.usageAt >= 15_000) {
      this.usageAt = t;
      try {
        recordUsageSamples(this.db, t);
      } catch (e) {
        this.o.log(`usage samples: ${(e as Error).message}`);
      }
    }
    if (t - this.refreshAt >= 60_000) {
      this.refreshAt = t;
      void (this.watcher ??= new AccountWatcher(this.db, (m) => this.o.log(m))).tick(t);
    }
    if (t - this.pruneAt >= 3600_000) {
      this.pruneAt = t;
      try {
        pruneJobs(this.db, t);
      } catch (e) {
        this.o.log(`prune jobs: ${(e as Error).message}`);
      }
      try {
        pruneTasks(this.db, t);
      } catch (e) {
        this.o.log(`prune build tasks: ${(e as Error).message}`);
      }
      try {
        pruneRuns(this.db, t);
      } catch (e) {
        this.o.log(`prune agent runs: ${(e as Error).message}`);
      }
    }
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

  private async startJobs(): Promise<void> {
    const steps = await loadSteps();
    const queued = this.db.prepare("SELECT id, step, requested_by FROM jobs WHERE state = 'queued' ORDER BY id").all() as { id: number; step: string; requested_by: string }[];
    // Automatic jobs wait while the pipeline is off; they are cancelled when it is switched off.
    const on = isEnabled(this.db);
    for (const q of queued) {
      if (q.requested_by === AUTOPILOT_USER && !on) continue;
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
      if (this.stopping) error = RUNNER_STOPPED;
      error ??= spawnError ?? (signal ? `The job's process ended on ${signal}.` : `The job's process exited with code ${code}.`);
    }
    failRunning(this.db, "The job ended during this call.", id);
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
    await Promise.all([this.planThread.close(), this.flowThread.close()]);
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
