// The signed-in user's own settings (GET and PUT /api/me/settings); their Task Runners are listed by GET /api/runners (runners.ts).
// Maintainers and operators set their own settings; a viewer writes nothing.
import type { DatabaseSync } from "node:sqlite";
import { pipelineRepos } from "../../pilot.ts";
import { manualOnly, parseManualOnly, setManualOnly } from "../../remote/manual-only.ts";
import { parseMaxCalls, setUserMaxCalls, userMaxCalls } from "../../remote/max-calls.ts";
import { parseRepos, setUserRepos, userRepos } from "../../remote/my-repos.ts";
import { parseTasks, setUserTasks, TASK_CHOICES, userTasks, type TaskChoice } from "../../remote/my-tasks.ts";
import type { UserSettingsReply } from "../../remote/protocol.ts";
import { parseReserve, setUserReserve, userReserve } from "../../remote/reserve.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

/** Repos with the pipeline on where the user has write permission, the permission a claim requires. */
async function repoChoices(db: DatabaseSync, req: Req): Promise<string[]> {
  const repos = [...pipelineRepos(db)].sort();
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

/** The reply: the protocol's settings, `manualOnly` (manual-only.ts), and the ticked `tasks` of `taskChoices` (my-tasks.ts). */
type SettingsReply = UserSettingsReply & { manualOnly: boolean; tasks: string[]; taskChoices: readonly TaskChoice[] };

export const settings = async (db: DatabaseSync, req: Req): Promise<SettingsReply> =>
  ({ reserve: userReserve(db, req.user.login), repos: userRepos(db, req.user.login), maxCalls: userMaxCalls(db, req.user.login), manualOnly: manualOnly(db, req.user.login), tasks: userTasks(db, req.user.login), taskChoices: TASK_CHOICES, repoChoices: await repoChoices(db, req) });

export async function setSettings(db: DatabaseSync, req: Req): Promise<SettingsReply> {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers have no settings to change");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a UserSettings object");
  const body = b as Record<string, unknown>;
  const known = ["reserve", "repos", "maxCalls", "manualOnly", "tasks"];
  for (const k of Object.keys(body)) if (!known.includes(k)) throw new HttpError(400, `unknown setting ${k}`);
  if (known.every((k) => body[k] === undefined)) throw new HttpError(400, "send reserve, repos, maxCalls, manualOnly, tasks or several of them");
  let reserve, repos, tasks, maxCalls: number | null | undefined, manual: boolean | undefined;
  try {
    if (body.reserve !== undefined) reserve = parseReserve(body.reserve);
    if (body.repos !== undefined) repos = parseRepos(db, body.repos);
    if (body.maxCalls !== undefined) maxCalls = parseMaxCalls(body.maxCalls);
    if (body.manualOnly !== undefined) manual = parseManualOnly(body.manualOnly);
    if (body.tasks !== undefined) tasks = parseTasks(body.tasks);
  } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (reserve) setUserReserve(db, req.user.login, reserve);
  if (repos) setUserRepos(db, req.user.login, repos);
  if (maxCalls !== undefined) setUserMaxCalls(db, req.user.login, maxCalls);
  if (manual !== undefined) setManualOnly(db, req.user.login, manual);
  if (tasks) setUserTasks(db, req.user.login, tasks);
  return settings(db, req);
}
