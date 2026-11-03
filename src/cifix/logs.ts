// Reads why a head's CI failed. Read-only: two `gh` calls per failed run, no write wrapper. The text is the
// PR's own CI output, so it is untrusted data wherever it goes next (a prompt frames it as such).
import { ORG } from "../act/templates.ts";
import type { Gh } from "../merge/safe-merge.ts";
import type { CiFailure, FailedCheck, FailedStep } from "./types.ts";

/** Characters kept from the end of one failed step's log, per check, and in all. */
export const STEP_TAIL = 4000;
export const CHECK_CAP = 8000;
export const TOTAL_CAP = 16_000;
/** Failed steps kept per check. */
const MAX_STEPS = 3;

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "stale"]);
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const GATE = /gate/i;

type CheckRuns = { check_runs?: { name?: string; status?: string; conclusion?: string | null; details_url?: string | null }[] };

/**
 * The failed check runs of a head. The repos' CI calls the suite's gate workflow, so its checks carry "gate" in their
 * name; when some failed check does, only those count (a failing optional check next to a passing gate is not the
 * gate's failure). With no such name every failed check counts.
 */
export function failedRuns(reply: CheckRuns): { name: string; conclusion: string; runId: number | null }[] {
  const failed = (reply.check_runs ?? []).filter((c) => c.status === "completed" && FAILED.has(c.conclusion ?? ""))
    .map((c) => ({ name: c.name ?? "?", conclusion: c.conclusion ?? "failure", runId: Number(/\/actions\/runs\/(\d+)/.exec(c.details_url ?? "")?.[1]) || null }));
  const gate = failed.filter((c) => GATE.test(c.name));
  return gate.length ? gate : failed;
}

/** `gh run view --log-failed` lines are `job<TAB>step<TAB>text`; groups them per job and step, in order. */
export function parseFailedLog(text: string): FailedStep[] {
  const groups = new Map<string, FailedStep>();
  for (const line of text.replace(ANSI, "").split("\n")) {
    const [job, step, ...rest] = line.split("\t");
    if (job === undefined || step === undefined || !rest.length) continue;
    const key = `${job}\t${step}`;
    const g = groups.get(key) ?? { job, step, tail: "" };
    g.tail += `${rest.join("\t").replace(STAMP, "")}\n`;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, tail: g.tail.length > STEP_TAIL ? g.tail.slice(-STEP_TAIL) : g.tail }));
}

/** Reads the failed checks of `head` and the failed steps' log tails; null when GitHub lists no failed check run at it. */
export async function readFailure(gh: Gh, repo: string, head: string): Promise<CiFailure | null> {
  const runs = failedRuns(JSON.parse(await gh(["api", `repos/${ORG}/${repo}/commits/${head}/check-runs?per_page=100`])) as CheckRuns);
  if (!runs.length) return null;
  const logs = new Map<number, FailedStep[]>();
  const checks: FailedCheck[] = [];
  let total = 0;
  for (const r of runs) {
    let steps: FailedStep[] = [];
    if (r.runId !== null && r.conclusion === "failure") {
      if (!logs.has(r.runId)) {
        try { logs.set(r.runId, parseFailedLog(await gh(["run", "view", String(r.runId), "--repo", `${ORG}/${repo}`, "--log-failed"]))); }
        catch { logs.set(r.runId, []); }
      }
      // A run holds several checks (jobs); a step belongs to the check whose name ends with its job's name.
      const all = logs.get(r.runId)!;
      steps = all.filter((s) => r.name === s.job || r.name.endsWith(` / ${s.job}`));
      if (!steps.length && runs.filter((x) => x.runId === r.runId).length === 1) steps = all;
    }
    const kept: FailedStep[] = [];
    let size = 0;
    for (const s of steps.slice(-MAX_STEPS)) {
      const room = Math.min(CHECK_CAP - size, TOTAL_CAP - total);
      if (room <= 0) break;
      const tail = s.tail.length > room ? s.tail.slice(-room) : s.tail;
      kept.push({ ...s, tail });
      size += tail.length;
      total += tail.length;
    }
    checks.push({ name: r.name, conclusion: r.conclusion, runId: r.runId, steps: kept });
  }
  return { head, checks };
}
