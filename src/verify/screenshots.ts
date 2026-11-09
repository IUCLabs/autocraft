// Before/after screenshots of UI pull requests (build feature "screenshots"). maybeScreenshot runs inside
// runVerify for a PR head: when the repo's switch is on, it has a screenshot config and the diff touches a UI
// path, a planning call chooses a script from the config's commands and two display tasks render it at the base
// and at the head. It never touches the `verifications` rows that gate merges; its own state is `screenshot_runs`.
import type { DatabaseSync } from "node:sqlite";
import { BuildError } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { runModelStep } from "../agents/step.ts";
import { VERIFY_SCREENSHOT } from "../agents/steps.ts";
import { cachedDiff, codeDiff, splitDiff } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { jobItem } from "../runner/job-items.ts";
import { matchesGlob } from "node:path";
import { getConfig, type ScreenshotConfig } from "./screenshot-config.ts";
import type { ScreenshotParsed } from "./plan.ts";
import type { VerifyCandidate } from "./candidates.ts";
import type { VerifyDeps } from "./index.ts";
import { queueScreenshotTasks } from "./tasks.ts";
import type { ScreenshotPlanInput } from "./types.ts";

/** Characters of diff the screenshot planner is shown. */
export const MAX_SHOT_DIFF_CHARS = 60_000;

/** Injectable parts, so tests need no model. `plan` returns the parsed reply, or null when the call gave no answer. */
export type ScreenshotDeps = {
  plan?: (input: ScreenshotPlanInput, ctx: { ref: string; config: ScreenshotConfig }) => Promise<ScreenshotParsed | null>;
};

type Env = Pick<VerifyDeps, "fetchDiff" | "baseOf" | "model" | "checkout"> & { screenshots?: ScreenshotDeps };
type Cand = Pick<VerifyCandidate, "repo" | "number" | "title" | "body" | "head_oid" | "label" | "review">;

const nowIso = (): string => new Date().toISOString();
const refOf = (c: { repo: string; number: number }): string => `${c.repo}#${c.number}`;

/** The state of a screenshot run for a head: its row is the record that the head was handled. */
export function insertRun(db: DatabaseSync, c: { repo: string; number: number; head_oid: string }, r: { state: string; reason: string | null; baseSha?: string | null; plan?: unknown; headTask?: number | null; baseTask?: number | null }): void {
  const at = nowIso();
  db.prepare(`INSERT OR IGNORE INTO screenshot_runs (repo, number, head_sha, base_sha, state, reason, plan, head_task_id, base_task_id, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.repo, c.number, c.head_oid, r.baseSha ?? null, r.state, r.reason, r.plan === undefined ? null : JSON.stringify(r.plan), r.headTask ?? null, r.baseTask ?? null, at,
      r.state === "planned" ? null : at);
}

function stage(db: DatabaseSync, c: Cand, name: "screenshot-planned" | "screenshot-skipped", note: string, log: (line: string) => void): void {
  db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)")
    .run(c.repo, c.number, name, nowIso(), "verify", `${note} at ${c.head_oid.slice(0, 7)}`.slice(0, 300));
  jobItem(db, c.repo, c.number, `${name}: ${note}`, log);
}

/** Whether any changed path of the diff matches one of the repo's UI globs. */
export const touchesUi = (paths: string[], globs: string[]): boolean => paths.some((p) => globs.some((g) => matchesGlob(p, g)));

/**
 * Plans and queues the screenshots of one PR head, when due. Returns whether tasks were queued. Throws nothing the
 * caller must handle except errors outside the step itself (runVerify catches and logs them).
 */
export async function maybeScreenshot(db: DatabaseSync, c: Cand, deps: Env, log: (line: string) => void, runId: string): Promise<boolean> {
  if (!featureOn(db, "screenshots", c.repo)) return false;
  const config = getConfig(db, c.repo);
  if (!config) return false;
  if (db.prepare("SELECT 1 FROM screenshot_runs WHERE repo = ? AND number = ? AND head_sha = ?").get(c.repo, c.number, c.head_oid)) return false;
  const ref = refOf(c);
  const d = await cachedDiff(c.repo, c.number, c.head_oid, deps.fetchDiff);
  if (!d.ok) { log(`  ${ref}: screenshots: no diff: ${d.error}`); return false; }
  if (!touchesUi(splitDiff(d.text).map((f) => f.path), config.ui_paths)) return false;
  const base = await deps.baseOf(c.repo, c.number);
  if (!base) { log(`  ${ref}: screenshots: no base commit`); return false; }

  const cd = codeDiff(d.text, true);
  const input: ScreenshotPlanInput = {
    ref, title: c.title, body: c.body, label: c.label, review: c.review, files: cd.files, diff: cd.text.slice(0, MAX_SHOT_DIFF_CHARS),
    commands: Object.entries(config.commands).map(([name, s]) => ({ name, doc: s.doc, params: s.params, capture: s.capture === true })),
    ...(config.size ? { size: config.size } : {}),
  };
  const plan = deps.screenshots?.plan ?? (async (i: ScreenshotPlanInput, x: { ref: string; config: ScreenshotConfig }): Promise<ScreenshotParsed | null> => {
    const checkout = (await deps.checkout?.(c.repo, c.number, c.head_oid)) ?? undefined;
    if (checkout) i.repo_dir = REPO_PATH;
    const r = await runModelStep(db, VERIFY_SCREENSHOT, i, {
      model: deps.model, checkout, ctx: x,
      usage: { run: runId, agent: `screenshot-${c.number}`, stage: "verify", items: (ok: boolean) => (ok ? 1 : 0) },
    });
    return r.ok ? r.value : null;
  });
  const result = await plan(input, { ref, config });
  if (!result) { log(`  ${ref}: screenshots: no answer from the planner`); return false; }
  if (!result.ok) {
    log(`  ${ref}: screenshots: invalid plan: ${result.error}`);
    insertRun(db, c, { state: "error", reason: `invalid plan: ${result.error}`.slice(0, 300), baseSha: base });
    return false;
  }
  const p = result.plan;
  if (!p.screenshot) {
    insertRun(db, c, { state: "skipped", reason: p.reason, baseSha: base });
    stage(db, c, "screenshot-skipped", p.reason, log);
    return false;
  }
  try {
    const ids = queueScreenshotTasks(db, p.steps, config, { repo: c.repo, number: c.number, head: c.head_oid, base });
    if (!ids.length) return false;   // the switch went off since the check above
    insertRun(db, c, { state: "planned", reason: p.reason, baseSha: base, plan: { steps: p.steps }, headTask: ids[0] ?? null, baseTask: ids[1] ?? null });
    stage(db, c, "screenshot-planned", `${p.steps.length} steps: ${p.reason}`, log);
    return true;
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    log(`  ${ref}: screenshots: tasks not queued: ${e.message}`);
    insertRun(db, c, { state: "error", reason: `tasks not queued: ${e.message}`.slice(0, 300), baseSha: base });
    return false;
  }
}
