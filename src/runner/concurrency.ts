// Which jobs may run together: one queued or running job per (step, repo), at most `step_parallel` repos per step,
// and the named mutexes of StepDef.exclusive. The planner, the command-line gate and the runner use the same rules.
// In the user-local mode a queued job that no Task Runner may take (untakenTest) holds no repo of the step.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { inferenceMode } from "../remote/mode.ts";
import { taskOfStep, TASK_CHOICES } from "../remote/my-tasks.ts";
import { takerTest } from "../remote/takers.ts";
import { knownStep, modelsOf, usesClaude, type Params, type StepDef } from "./steps.ts";
import { setting } from "../settings-read.ts";

export const STEP_PARALLEL_KEY = "step_parallel";
export const STEP_PARALLEL_DEFAULT = 1;
export const STEP_PARALLEL_MAX = 1000;

export class ParallelError extends Error {
  status = 400;
}

/** The setting as shown and stored: a positive integer or "none". */
export function stepParallelSetting(db: DatabaseSync): string {
  const v = setting(db, STEP_PARALLEL_KEY);
  if (v === "none") return v;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= STEP_PARALLEL_MAX ? String(n) : String(STEP_PARALLEL_DEFAULT);
}

/** The most repos one step may have running at once (Infinity for "none"). */
export const stepParallel = (db: DatabaseSync): number => { const s = stepParallelSetting(db); return s === "none" ? Infinity : Number(s); };

export function setStepParallel(db: DatabaseSync, input: unknown, by: string): string {
  const v = typeof input === "number" ? String(input) : input;
  if (v !== "none" && !(typeof v === "string" && /^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= STEP_PARALLEL_MAX)) {
    throw new ParallelError(`repos at once per step must be a whole number from 1 to ${STEP_PARALLEL_MAX}, or none`);
  }
  const was = stepParallelSetting(db);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(STEP_PARALLEL_KEY, v);
  if (v !== was) audit(db, by, "step-parallel", "pipeline", { stepParallel: v, was });
  return v as string;
}

/** A job that holds or waits for its (step, repo). `number` is the finding of a security-fix job; `params` (JSON) is read for jobs in the table. */
export type Active = { id: number; step: string; state: string; repo: string | null; number: number | null; params?: string };

export function activeJobs(db: DatabaseSync, states: ("queued" | "running")[] = ["queued", "running"]): Active[] {
  return db.prepare(`SELECT id, step, state, repo, json_extract(params, '$.number') AS number, params FROM jobs WHERE state IN (${states.map(() => "?").join(",")})`)
    .all(...states) as Active[];
}

/** A job or proposal as untakenTest reads it: `params` as an object or the stored JSON. */
export type JobOfRepo = { step: string; repo: string | null; params?: Params | string | null };

/** Why a job waits for a Task Runner, or null when it does not: see untakenTest. */
export type UntakenTest = (j: JobOfRepo) => string | null;

/** The reason a job of `repo` waits: shown for the step, the lane's items and the queued job. */
export const noRunnerFor = (repo: string): string => `No Task Runner takes ${repo}`;
/** The reason a job of `step` on `repo` waits when Task Runners take the repo but none takes the step's task (My tasks). */
export const noRunnerForTask = (repo: string, step: string): string => {
  const task = taskOfStep(step);
  return `No Task Runner takes ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} tasks on ${repo}`;
};

/**
 * Why a job waits for a Task Runner, or null: in the user-local mode, a job of a step that calls Claude, for a repo no Task
 * Runner may take now or whose step's task none of those takes (src/remote/takers.ts, the rule the runner's job starts and the
 * pools use). The runners are read once, on the first such job, so one test serves a whole pass. Never in the server-account
 * mode, nor for a job with no repo. A job names no item (a `number` param is a security finding), so a runner that takes only some
 * items counts on the repos with such an item (src/remote/task-items.ts); the job's pools then ask about each unit's items.
 */
export function untakenTest(db: DatabaseSync, steps?: Map<string, StepDef>, nowMs: number = Date.now()): UntakenTest {
  if (inferenceMode(db) !== "user-local") return () => null;
  const takes = takerTest(db, nowMs);
  const claude = (j: JobOfRepo): boolean => {
    let params: Params = {};
    if (typeof j.params === "string") { try { params = JSON.parse(j.params) as Params; } catch { /* the step's defaults */ } }
    else if (j.params) params = j.params;
    return usesClaude(modelsOf(steps?.get(j.step) ?? knownStep(j.step), params));
  };
  return (j) => {
    if (j.repo === null || !claude(j) || takes({ prompt_id: "", repos: [j.repo], step: j.step })) return null;
    return takes({ prompt_id: "", repos: [j.repo] }) ? noRunnerForTask(j.repo, j.step) : noRunnerFor(j.repo);
  };
}

/** Two jobs of one step do the same work: the same repo (and finding), or one of them is not about a single repo. */
function sameWork(step: string, a: { repo: string | null; number: number | null }, b: { repo: string | null; number: number | null }): boolean {
  if (a.repo === null || b.repo === null) return true;
  return a.repo === b.repo && (step !== "security-fix" || a.number === b.number);
}

export type Want = { step: string; repo: string | null; number?: number | null };

/**
 * Why the job cannot be queued or started now, or null. `states` are the jobs that count: queued and running for
 * queueing, running alone for starting. `extra` are proposals of the same pass: they only count as the same work (a duplicate), so a fallback proposal for another repo can still be made. `reserved` are jobs this pass already queued or gated: they count for the same work and for the repo capacity. `mutex` also checks StepDef.exclusive
 * against running jobs. With `precheck` (a planner check before any repo is known) only the repo capacity is checked.
 * A queued job that `untaken` says waits for a Task Runner counts as the same work but takes no repo of the capacity; a
 * pass that asks many times passes one test.
 */
export function jobBlock(db: DatabaseSync, steps: Map<string, StepDef>, want: Want, o: { states?: ("queued" | "running")[]; extra?: Active[]; reserved?: Active[]; mutex?: boolean; precheck?: boolean; untaken?: UntakenTest; active?: Active[] } = {}): string | null {
  // `active`: the queued and running jobs, read once by a caller that asks many times while no job changes.
  const jobsIn = (states: ("queued" | "running")[] = ["queued", "running"]): Active[] => (o.active ? o.active.filter((j) => (states as string[]).includes(j.state)) : activeJobs(db, states));
  const held = [...jobsIn(o.states), ...(o.reserved ?? [])].filter((j) => j.step === want.step);
  const same = [...held, ...(o.extra ?? []).filter((j) => j.step === want.step)];
  if (!o.precheck) {
    const clash = same.find((j) => sameWork(want.step, j, { repo: want.repo, number: want.number ?? null }));
    if (clash) return `job ${clash.id} of ${want.step} is ${clash.state}`;
  }
  const cap = stepParallel(db);
  if (cap !== Infinity) {
    let untaken = o.untaken;
    const holds = (j: Active): boolean => j.state !== "queued" || j.params === undefined || !(untaken ??= untakenTest(db, steps))(j);
    const repos = new Set(held.filter(holds).map((j) => j.repo ?? ""));
    if (repos.size >= cap && (o.precheck || !repos.has(want.repo ?? ""))) return `${want.step} is working ${repos.size} repo${repos.size === 1 ? "" : "s"}, the most at once (step_parallel)`;
  }
  const mutex = steps.get(want.step)?.exclusive;
  if (o.mutex && mutex) {
    const other = jobsIn(["running"]).find((j) => steps.get(j.step)?.exclusive === mutex);
    if (other) return `job ${other.id} (${other.step}) is running with the same mutex (${mutex})`;
  }
  return null;
}
