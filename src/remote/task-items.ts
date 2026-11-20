// Each user's item choice for their Task Runners: which items the runners take work on, next to My tasks (my-tasks.ts). "all"
// takes every item; "fast" only fast-tracked items (src/fasttrack.ts: Queue items, the @<app> queue command, the fast-track
// list); "mine" only items the user fast-tracked. Stored in `user_settings` under `task_items`; no row means "all". Picks
// ("Run on my Task Runner") and follow-ups of the user's own sessions do not go by it, as with My tasks and My repos.
//
// A call matches when any item it names matches. A question asked before the items are known (a job about to start, a pool's
// room, a repo's takers) counts a filtered runner only for the repos that have an open matching item.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { prep } from "../sql-cache.ts";

export const TASK_ITEMS_KEY = "task_items";
export const TASK_ITEMS = ["all", "fast", "mine"] as const;
export type TaskItems = (typeof TASK_ITEMS)[number];

const isTaskItems = (v: unknown): v is TaskItems => typeof v === "string" && (TASK_ITEMS as readonly string[]).includes(v);

/** The user's item choice; "all" with no row or a value no longer offered. */
export function userTaskItems(db: DatabaseSync, login: string): TaskItems {
  const v = (prep(db, "SELECT value FROM main.user_settings WHERE login = ? AND key = ?").get(login, TASK_ITEMS_KEY) as { value: string } | undefined)?.value;
  return isTaskItems(v) ? v : "all";
}

/** The item choice from a request body; throws with the reason for a bad one. */
export function parseTaskItems(raw: unknown): TaskItems {
  if (!isTaskItems(raw)) throw new Error(`taskItems must be one of ${TASK_ITEMS.join(", ")}`);
  return raw;
}

/** Stores the item choice ("all" removes the row); a change is audited. */
export function setUserTaskItems(db: DatabaseSync, login: string, v: TaskItems): TaskItems {
  const was = userTaskItems(db, login);
  if (v === "all") prep(db, "DELETE FROM main.user_settings WHERE login = ? AND key = ?").run(login, TASK_ITEMS_KEY);
  else prep(db, "INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(login, TASK_ITEMS_KEY, v, new Date().toISOString());
  if (v !== was) audit(db, login, "task-items", login, { items: v, was });
  return v;
}

/** The open items a filtered user takes (`refs`, as `repo#number`) and their repos; null for a user who takes every item. */
export type ItemFilter = { refs: ReadonlySet<string>; repos: ReadonlySet<string> } | null;

/** The user's ItemFilter, read now. */
export function itemFilter(db: DatabaseSync, login: string): ItemFilter {
  const choice = userTaskItems(db, login);
  if (choice === "all") return null;
  const rows = prep(db, `SELECT f.repo, f.number FROM main.fast_track f JOIN main.items i ON i.repo = f.repo AND i.number = f.number AND i.state = 'OPEN'
    WHERE ? = 'fast' OR f.added_by = ? COLLATE NOCASE`).all(choice, login) as { repo: string; number: number }[];
  return { refs: new Set(rows.map((r) => `${r.repo}#${r.number}`)), repos: new Set(rows.map((r) => r.repo)) };
}

/**
 * Whether a filter lets a runner take work: `refs` known (a queued call), when any of them matches, so a call about no item never
 * does; `refs` unknown (a job or room question), when any of `repos` has a matching item.
 */
export function itemsFit(f: ItemFilter, c: { repos: readonly string[]; refs?: readonly { repo: string; number: number }[] }): boolean {
  if (!f) return true;
  if (c.refs) return c.refs.some((r) => f.refs.has(`${r.repo}#${r.number}`));
  return c.repos.some((x) => f.repos.has(x));
}
