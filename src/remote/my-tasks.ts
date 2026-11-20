// Each user's task picks for their Task Runners: which kinds of work (pipeline stages) the runners take from the queue. Stored
// in `user_settings` under `skip_tasks` as a JSON list of the tasks the user unticked, so no row means every task, and a task
// added later starts ticked. Picks ("Run on my Task Runner") and follow-ups of the user's own sessions do not go by it, as with
// My repos (my-repos.ts).
import type { DatabaseSync } from "node:sqlite";
import { prep } from "../sql-cache.ts";
import { audit } from "../dash/audit.ts";
import { STAGES, stageOfStep } from "../stages/registry.ts";

export const SKIP_TASKS_KEY = "skip_tasks";
/** The task of a call whose step belongs to no stage that makes model calls (security scans, Discord and the like). */
export const OTHER_TASK = "other";

export type TaskChoice = { id: string; title: string };

/** The tasks a user can tick, in pipeline order: each stage that makes model calls, then Other. */
export const TASK_CHOICES: readonly TaskChoice[] = [
  ...[...STAGES].filter((s) => s.promptIds.length > 0).sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, title: s.title })),
  { id: OTHER_TASK, title: "Other (security, Discord)" },
];
const TASK_IDS = new Set(TASK_CHOICES.map((t) => t.id));

/** The task a call of `step` belongs to. */
export function taskOfStep(step: string): string {
  const id = stageOfStep(step)?.id;
  return id !== undefined && TASK_IDS.has(id) ? id : OTHER_TASK;
}

/** The tasks the user unticked; empty when they take every task. Ids no longer offered are dropped. */
export function userSkips(db: DatabaseSync, login: string): Set<string> {
  const row = prep(db, "SELECT value FROM main.user_settings WHERE login = ? AND key = ?").get(login, SKIP_TASKS_KEY) as { value: string } | undefined;
  if (!row) return new Set();
  try {
    const v = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && TASK_IDS.has(x)) : []);
  } catch {
    return new Set();
  }
}

/** The tasks the user takes, in TASK_CHOICES order. */
export const userTasks = (db: DatabaseSync, login: string): string[] => {
  const skip = userSkips(db, login);
  return TASK_CHOICES.map((t) => t.id).filter((id) => !skip.has(id));
};

/** Ticked tasks from a request body, checked against TASK_CHOICES; throws with the reason for a bad list. */
export function parseTasks(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > TASK_CHOICES.length * 2 || !raw.every((x) => typeof x === "string")) throw new Error("tasks must be a list of task ids");
  const unknown = (raw as string[]).filter((x) => !TASK_IDS.has(x));
  if (unknown.length) throw new Error(`unknown task: ${unknown.slice(0, 5).join(", ")}; tasks are ${[...TASK_IDS].join(", ")}`);
  return [...new Set(raw as string[])];
}

/** Stores the ticked tasks as the unticked rest (every task ticked removes the row); a change is audited. */
export function setUserTasks(db: DatabaseSync, login: string, tasks: readonly string[]): string[] {
  const was = userTasks(db, login);
  const on = new Set(tasks);
  const skip = TASK_CHOICES.map((t) => t.id).filter((id) => !on.has(id));
  if (!skip.length) prep(db, "DELETE FROM main.user_settings WHERE login = ? AND key = ?").run(login, SKIP_TASKS_KEY);
  else prep(db, "INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(login, SKIP_TASKS_KEY, JSON.stringify(skip), new Date().toISOString());
  const now = userTasks(db, login);
  if (was.join("\n") !== now.join("\n")) audit(db, login, "my-tasks", login, { tasks: now, was });
  return now;
}
