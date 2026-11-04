// Build environments and tasks over JSON. Everyone signed in reads (tasks of repos
// the viewer cannot see are left out); only operators register or change an
// environment, rotate its key or cancel a task, all audited. A worker key is
// returned once, on creation and rotation. Whatever a worker reported is data:
// viewers get neither logs, patches nor artifact downloads; the page shows it as text and artifacts download with `attachment` (PNG inline),
// `nosniff` and `Content-Security-Policy: sandbox`.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { BuildEnv, BuildSummary, BuildTask, BuildTaskDetail, TaskFilter, TaskPage, TaskState } from "../../../web/src/api/types.ts";
import { absolute } from "../../build/artifacts.ts";
import { BuildError, createEnv, listEnvs, rotateKey, updateEnv } from "../../build/envs.ts";
import { cancelTask, getTaskDetail, listTasks, summary } from "../../build/tasks.ts";
import { HttpError } from "../server/util.ts";
import type { Req, Res } from "../types.ts";
import { hiddenRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";

const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof BuildError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

/** Operators see every environment; others only the enabled ones. */
export const envs = (db: DatabaseSync, req: Req): BuildEnv[] => listEnvs(db).filter((e) => e.enabled || canSeeInternals(req));

export const postEnv = (db: DatabaseSync, req: Req) => wrap(() => createEnv(db, req.json, req.user.login));
export const putEnv = (db: DatabaseSync, req: Req) => wrap(() => updateEnv(db, req.params.id, req.json, req.user.login));
export const postRotate = (db: DatabaseSync, req: Req) => wrap(() => rotateKey(db, req.params.id, req.user.login));

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,4}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const tasks = (db: DatabaseSync, req: Req): Promise<TaskPage> => wrap(async () => {
  const q = (k: string) => req.query.get(k) || undefined;
  const repo = q("repo");
  const hidden = await hiddenRepos(db, req);
  if (repo && hidden.includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  const f: TaskFilter = { state: q("state") as TaskState | "active" | undefined, env: q("env"), repo, cursor: q("cursor"), limit: intParam(req, "limit") };
  return listTasks(db, f, hidden);
});

async function visibleTask(db: DatabaseSync, req: Req): Promise<BuildTaskDetail> {
  if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new HttpError(400, "not a task id");
  const t = getTaskDetail(db, Number(req.params.id));
  // The same answer for a task that does not exist and one of a repo the viewer cannot see.
  if (!t || (await hiddenRepos(db, req)).includes(t.repo)) throw new HttpError(404, "no such task");
  return t;
}

/** Viewers get the task without its log and patch. */
export const task = (db: DatabaseSync, req: Req) => wrap(async (): Promise<BuildTaskDetail> => {
  const t = await visibleTask(db, req);
  return canSeeInternals(req) ? t : { ...t, logTail: null, logBytes: 0, logTruncated: false, patch: null };
});

export const cancel = (db: DatabaseSync, req: Req): Promise<BuildTask> => wrap(async () => {
  await visibleTask(db, req);
  return cancelTask(db, req.params.id, req.user.login);
});

export const buildSummary = async (db: DatabaseSync, req: Req): Promise<BuildSummary> => summary(db, await hiddenRepos(db, req));

export async function artifact(db: DatabaseSync, req: Req): Promise<Res> {
  try {
    if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers download artifacts");
    const t = await visibleTask(db, req);
    const a = t.artifacts.find((x) => x.name === req.params.name);
    const row = a && (db.prepare("SELECT file FROM build_artifacts WHERE task_id = ? AND name = ?").get(t.id, a.name) as { file: string } | undefined);
    const path = row && absolute(row.file);
    if (!a || !path) throw new HttpError(404, "no such artifact");
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      throw new HttpError(404, "the artifact file is gone");
    }
    return {
      body: data,
      headers: {
        "content-type": a.contentType === "image/png" ? "image/png" : `${a.contentType}; charset=utf-8`,
        "content-disposition": `${a.contentType === "image/png" ? "inline" : "attachment"}; filename="${a.name}"`,
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=300",
      },
    };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}
