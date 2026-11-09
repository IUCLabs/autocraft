// Our own build of PR heads (pr-builds feature): a second opinion beside upstream CI. It never holds a PR or changes a
// merge decision. One no-model job step queues the builds and collects the finished ones; the task runs in a worker.
// A build that fails where CI passed is noted on the item (stage row `pr-build-disagree`) and nothing more: our build
// lacks CI's gate inputs and toolchain targets, so such failures are often false.
import type { DatabaseSync } from "node:sqlite";
import { BuildError } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { TERMINAL, cancelTask, createTask, getTask, warmKeyOf } from "../build/tasks.ts";
import { leaseItem } from "../runner/leases.ts";
import { jobItem } from "../runner/job-items.ts";
import { outcomeOf, CURRENT_HEAD_SQL } from "../verify/results.ts";
import { cloneTask } from "../verify/tasks.ts";
import { cachedCrates, ghCrates, type CratesFetcher } from "../verify/crates.ts";
import { planFor } from "./plans.ts";
import { scopeOf, selectPrBuilds } from "./select.ts";

export const STEP = "pr-build";
/** Below Verify's tasks (0), above the warm build (-10). */
export const PR_BUILD_PRIORITY = -5;
const ACTOR = "pr-build";
const SUMMARY_LIMIT = 200;

const now = (): string => new Date().toISOString();

export type PrBuildDeps = { fetchCrates: CratesFetcher };

/** Queues the build task of one PR head and records it. Returns the task id. */
export function queuePrBuild(db: DatabaseSync, c: { repo: string; number: number; head: string }): number | null {
  const plan = planFor("rust", c.repo, c.head);
  if (!plan) return null;
  const id = createTask(db, {
    step: STEP, repo: c.repo, number: c.number, headSha: c.head, priority: PR_BUILD_PRIORITY, plan,
    requires: { os: "linux", toolchains: ["rust-stable"] }, warm: { key: warmKeyOf(c.repo), role: "use" },
  });
  db.prepare("INSERT OR IGNORE INTO main.pr_builds (repo, number, head_sha, scope, task_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
    .run(c.repo, c.number, c.head, scopeOf(db, c.repo), id, now());
  return id;
}

type Pending = { repo: string; number: number; head_sha: string; task_id: number | null; retried: number; item_state: string | null; item_head: string | null };

const pendingSql = (where: string): string => `SELECT b.repo, b.number, b.head_sha, b.task_id, b.retried, i.state AS item_state, ${CURRENT_HEAD_SQL} AS item_head FROM main.pr_builds b
  LEFT JOIN items i ON i.repo = b.repo AND i.number = b.number LEFT JOIN pr_checks c ON c.repo = b.repo AND c.number = b.number WHERE b.state = 'queued' ${where}`;

/** Whether the repo has work for a pr-build job: a PR to build or a queued build whose task ended or whose PR moved on. Reads only. */
export function prBuildDue(db: DatabaseSync, repo: string): boolean {
  if (!featureOn(db, "pr-builds", repo)) return false;
  if (selectPrBuilds(db, repo).some((c) => c.rust !== false)) return true;
  const term = TERMINAL.map((s) => `'${s}'`).join(", ");
  return (db.prepare(pendingSql("AND b.repo = ?")).all(repo) as Pending[]).some((p) => {
    if (p.item_state !== "OPEN" || p.item_head !== p.head_sha || p.task_id === null) return true;
    const t = db.prepare(`SELECT 1 FROM build_tasks WHERE id = ? AND state IN (${term})`).get(p.task_id);
    return !!t;
  });
}

export type PrBuildSummary = { queued: number; passed: number; failed: number; errors: number; stale: number; retried: number; disagreements: number };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);

/** Reads the finished tasks of the repo's queued builds and records their state. */
export function collectPrBuilds(db: DatabaseSync, repo: string, log: (line: string) => void = console.log): Omit<PrBuildSummary, "queued"> {
  const s = { passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  for (const p of db.prepare(pendingSql("AND b.repo = ? ORDER BY b.created_at, b.number")).all(repo) as Pending[]) {
    const release = leaseItem(db, `pr:${p.repo}#${p.number}`, log);
    if (!release) continue;
    try {
      const finish = (state: string, summary: string | null, extra: { ci?: string | null; disagree?: boolean } = {}): boolean =>
        Number(db.prepare("UPDATE main.pr_builds SET state = ?, summary = ?, ci_overall = ?, disagree = ?, finished_at = ? WHERE repo = ? AND number = ? AND head_sha = ? AND state = 'queued'")
          .run(state, summary, extra.ci ?? null, extra.disagree ? 1 : 0, now(), p.repo, p.number, p.head_sha).changes) > 0;
      const task = p.task_id === null ? null : getTask(db, p.task_id);
      if (p.item_state !== "OPEN" || p.item_head !== p.head_sha) {
        if (task && !TERMINAL.includes(task.state)) cancelTask(db, task.id, ACTOR);
        if (finish("stale", null)) s.stale++;
        continue;
      }
      if (!task) { if (finish("error", "the build task is gone")) s.errors++; continue; }
      if (!TERMINAL.includes(task.state)) continue;
      const out = outcomeOf(task);
      if (out.kind === "error" && p.retried < 1) {
        try {
          const id = cloneTask(db, task.id);
          db.prepare("UPDATE main.pr_builds SET task_id = ?, retried = retried + 1 WHERE repo = ? AND number = ? AND head_sha = ?").run(id, p.repo, p.number, p.head_sha);
          s.retried++;
          jobItem(db, p.repo, p.number, `pr-build: ${out.reason}; queued again`, log);
          continue;
        } catch (e) {
          if (!(e instanceof BuildError)) throw e;
        }
      }
      const sha7 = p.head_sha.slice(0, 7);
      if (out.kind === "pass") {
        if (finish("passed", null)) { s.passed++; jobItem(db, p.repo, p.number, `pr-build at ${sha7}: passed`, log); }
      } else if (out.kind === "error") {
        if (finish("error", oneLine(out.reason))) { s.errors++; jobItem(db, p.repo, p.number, `pr-build at ${sha7}: error: ${oneLine(out.reason)}`, log); }
      } else {
        const why = `${out.step} ${out.timedOut ? "timed out" : `failed with exit code ${out.exitCode ?? "none"}`}`;
        // CI at the same head: the checks row counts only while it was read at this head.
        const ci = (db.prepare("SELECT overall FROM pr_checks WHERE repo = ? AND number = ? AND head_oid = ?").get(p.repo, p.number, p.head_sha) as { overall: string } | undefined)?.overall ?? null;
        const disagree = ci === "success";
        if (finish("failed", why, { ci, disagree })) {
          s.failed++;
          jobItem(db, p.repo, p.number, `pr-build at ${sha7}: failed: ${why}`, log);
          if (disagree) {
            s.disagreements++;
            db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)")
              .run(p.repo, p.number, "pr-build-disagree", now(), ACTOR, `our build failed at ${sha7} (${why}) while upstream CI passed`.slice(0, 300));
          }
        }
      }
    } finally { release(); }
  }
  return s;
}

/** The job step: collect finished builds, then queue the builds of new heads. Does nothing while the repo's switch is off. */
export async function runPrBuilds(db: DatabaseSync, repo: string, log: (line: string) => void = console.log, deps: PrBuildDeps = { fetchCrates: ghCrates }): Promise<PrBuildSummary> {
  const zero: PrBuildSummary = { queued: 0, passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  if (!featureOn(db, "pr-builds", repo)) return zero;
  const out: PrBuildSummary = { ...zero, ...collectPrBuilds(db, repo, log) };
  for (const c of selectPrBuilds(db, repo)) {
    if (c.rust === null) {
      const r = await cachedCrates(repo, c.head, deps.fetchCrates);
      if (!r.ok) { log(`  ${repo}#${c.number}: no crate list: ${r.error}`); continue; }
      if (!r.rust) continue;
    }
    const release = leaseItem(db, `pr:${repo}#${c.number}`, log);
    if (!release) continue;
    try {
      if (!featureOn(db, "pr-builds", repo)) break;
      if (queuePrBuild(db, c) !== null) { out.queued++; jobItem(db, repo, c.number, `pr-build queued at ${c.head.slice(0, 7)}`, log); }
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      log(`  ${repo}#${c.number}: not queued: ${e.message}`);
      break;
    } finally { release(); }
  }
  return out;
}
