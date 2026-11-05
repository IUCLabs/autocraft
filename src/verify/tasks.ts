// Build tasks for a validated plan, and the warm build of the default branch.
import type { DatabaseSync } from "node:sqlite";
import { createTask, warmKeyOf, type NewTask } from "../build/tasks.ts";
import { rustPlan } from "../worker/rust.ts";
import type { TaskStep } from "../worker/types.ts";
import type { VerifyPlan } from "./plan.ts";

const REQUIRES = { os: "linux", toolchains: ["rust-stable"] } as const;
export const WARM_EVERY_MS = 24 * 3600_000;
/** Warm builds wait behind verification tasks. */
export const WARM_PRIORITY = -10;

type Planned = Exclude<VerifyPlan, { kind: "ci-enough" }>;

/** The tasks that run `plan` at `head` (and, for a regression, at `base`). Order: head first. */
export function tasksFor(plan: Planned, c: { repo: string; number: number; head: string; base: string }): NewTask[] {
  const common = { step: "verify", repo: c.repo, number: c.number, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, warm: { key: warmKeyOf(c.repo), role: "use" as const } };
  if (plan.kind === "tests") {
    const steps = rustPlan({ cargoArgs: plan.crates.flatMap((n) => ["-p", n]) }).map((s): TaskStep =>
      s.name === "test" && plan.tests.length ? { ...s, cmd: [...s.cmd, "--", ...plan.tests] } : s);
    return [{ ...common, headSha: c.head, baseSha: c.base, plan: steps }];
  }
  const steps = rustPlan({ cargoArgs: ["-p", plan.crate] }).map((s): TaskStep =>
    s.name === "test" ? { ...s, cmd: [...s.cmd, "--test", plan.test] } : s);
  return [
    { ...common, headSha: c.head, baseSha: c.base, plan: steps, patch: plan.patch },
    { ...common, headSha: c.base, baseSha: c.base, plan: steps, patch: plan.patch },
  ];
}

/** Queues the tasks; returns their ids, head task first. */
export function queueTasks(db: DatabaseSync, plan: Planned, c: { repo: string; number: number; head: string; base: string }): number[] {
  return tasksFor(plan, c).map((t) => createTask(db, t));
}

/**
 * Queues a build-only task for the default branch head when the repo has no warm build for it yet and
 * none in the last 24 hours. Returns the task id, or null when nothing was queued.
 */
export function queueWarmBuild(db: DatabaseSync, repo: string, mainSha: string, nowMs: number = Date.now()): number | null {
  const same = db.prepare("SELECT 1 FROM build_tasks WHERE repo = ? AND head_sha = ? AND warm_role = 'build'").get(repo, mainSha);
  if (same) return null;
  const since = new Date(nowMs - WARM_EVERY_MS).toISOString();
  if (db.prepare("SELECT 1 FROM build_tasks WHERE repo = ? AND warm_role = 'build' AND queued_at > ?").get(repo, since)) return null;
  return createTask(db, {
    step: "verify", repo, headSha: mainSha, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, priority: WARM_PRIORITY,
    plan: rustPlan({ cargoArgs: ["--workspace"], test: false }), warm: { key: warmKeyOf(repo), role: "build" },
  });
}

type CloneRow = { step: string; repo: string; number: number | null; head_sha: string; base_sha: string | null; requires: string; priority: number; plan: string; patch: string | null; warm_key: string | null; warm_role: "use" | "build" | null };

/** Queues a new task with the same step, commits, requirements, plan, patch and warm role as task `id`. */
export function cloneTask(db: DatabaseSync, id: number): number {
  const r = db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(id) as CloneRow | undefined;
  if (!r) throw new Error(`no task ${id}`);
  return createTask(db, {
    step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, requires: JSON.parse(r.requires), priority: r.priority,
    plan: JSON.parse(r.plan), ...(r.patch === null ? {} : { patch: r.patch }), ...(r.warm_key && r.warm_role ? { warm: { key: r.warm_key, role: r.warm_role } } : {}),
  });
}
