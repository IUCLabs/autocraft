// The Now page: what is wrong, what is running and what just happened, in one read.
// Every query leaves out repos the viewer cannot see, as the pipeline, agents and build endpoints do.
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef, ItemShown, Now, NowEvent, NowHealth, NowProblem, NowRunning } from "../../../web/src/api/types.ts";
import { listAccounts } from "../../agents/accounts.ts";
import { jevEnabled, jevOutage } from "../../agents/jev.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { mainCiRepos } from "../../mainci/index.ts";
import { pipelineRepos } from "../../pilot.ts";
import { pipelineState } from "../../runner/autopilot.ts";
import { trackedNames } from "../../repos.ts";
import type { Req } from "../types.ts";
import { clip, stepTitle, writeEvent } from "./trace.ts";
import { shownLookup } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";

const RECENT = 30;
const PER_KIND = 5;
const SYNC_FAILS = 3;
const SYNC_STALE_MS = 15 * 60_000;
const RUNNER_STALE_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;

type Item = ItemRef & ItemShown;
type Args = (string | number)[];
const all = <T>(db: DatabaseSync, sql: string, ...args: Args): T[] => db.prepare(sql).all(...args) as T[];
const minutes = (ms: number): string => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / HOUR_MS)} h`);
const marks = (xs: unknown[]): string => xs.map(() => "?").join(",");
/** ` AND <col> NOT IN (...)`, or nothing when no repo is hidden. */
const notHidden = (col: string, hidden: string[], nullOk = false): string =>
  hidden.length ? ` AND (${nullOk ? `${col} IS NULL OR ` : ""}${col} NOT IN (${marks(hidden)}))` : "";

// ---- health ------------------------------------------------------------------

function syncProblem(db: DatabaseSync, nowMs: number): NowProblem | null {
  const runs = all<{ started_at: string; ended_at: string | null; error: string | null }>(db, "SELECT started_at, ended_at, error FROM sync_runs ORDER BY started_at DESC LIMIT 20")
    .filter((r) => r.ended_at !== null || r.error !== null);
  const failing = runs.slice(0, SYNC_FAILS);
  if (failing.length === SYNC_FAILS && failing.every((r) => r.error !== null)) {
    const streak = runs.findIndex((r) => r.error === null);
    const first = runs[(streak === -1 ? runs.length : streak) - 1]!;
    return { id: "sync", area: "sync", tone: "bad", text: `Sync is failing: ${clip(failing[0]!.error, 140)}`, to: "/pipeline", since: first.started_at };
  }
  const ok = runs.find((r) => r.error === null);
  const last = ok?.ended_at ? Date.parse(ok.ended_at) : NaN;
  if (Number.isNaN(last)) return trackedNames(db).length ? { id: "sync", area: "sync", tone: "bad", text: "Sync has not succeeded yet", to: "/pipeline", since: null } : null;
  if (nowMs - last > SYNC_STALE_MS) return { id: "sync", area: "sync", tone: "bad", text: `No successful sync in ${minutes(nowMs - last)}`, to: "/pipeline", since: ok!.ended_at };
  return null;
}

async function healthOf(db: DatabaseSync, visible: string[], hidden: string[], nowMs: number): Promise<NowHealth> {
  const state = await pipelineState(db);
  const out: NowProblem[] = [];
  const add = (p: NowProblem) => void out.push(p);

  if (!state.enabled) add({ id: "pipeline", area: "pipeline", tone: "warn", text: `Pipeline is off${state.changedBy ? `, switched off by ${state.changedBy}` : ""}`, to: "/pipeline", since: state.changedAt });
  const beat = state.heartbeat ? Date.parse(state.heartbeat) : NaN;
  if (Number.isNaN(beat) || nowMs - beat > RUNNER_STALE_MS) {
    add({ id: "runner", area: "runner", tone: "bad", text: Number.isNaN(beat) ? "The runner has not reported" : `The runner has not reported for ${minutes(nowMs - beat)}`, to: "/pipeline", since: state.heartbeat });
  }
  const sync = syncProblem(db, nowMs);
  if (sync) add(sync);

  for (const t of all<{ stage: string; reason: string; tripped_at: string }>(db, "SELECT stage, reason, tripped_at FROM stage_trips WHERE active = 1 ORDER BY tripped_at")) {
    add({ id: `breaker:${t.stage}`, area: "breaker", tone: "bad", text: `${stepTitle(t.stage)} is stopped by its breaker: ${clip(t.reason, 120)}`, to: "/pipeline", since: t.tripped_at });
  }
  for (const l of state.limits) {
    if (l.perDay === 0 && !l.tripped) add({ id: `limit:${l.step}`, area: "limit", tone: "warn", text: `${l.title} is paused (limit 0 a day)`, to: "/pipeline", since: null });
  }

  for (const a of listAccounts(db).filter((x) => x.enabled)) {
    if (a.auth.loggedIn === false) add({ id: `account:${a.id}`, area: "account", tone: "bad", text: `Account ${a.label} is signed out`, to: "/accounts", since: null });
    else if (a.pausedReason) add({ id: `account:${a.id}`, area: "account", tone: "warn", text: `Account ${a.label} is paused: ${clip(a.pausedReason, 100)}`, to: "/accounts", since: null });
  }
  const outage = jevEnabled(db) ? jevOutage(db) : null;
  if (outage) add({ id: "jev", area: "jev", tone: "warn", text: `Jev is unavailable: ${clip(outage.reason, 100)}`, to: "/accounts", since: outage.since });

  for (const r of mainCiRepos(db, hidden).filter((x) => x.state === "red")) {
    const names = r.failing.map((f) => f.name).slice(0, 2).join(", ");
    add({ id: `main-ci:${r.repo}`, area: "main-ci", tone: "bad", text: `Main is red in ${r.repo}${names ? `: ${names}` : ""}`, to: "/main-ci", since: r.redSince });
  }

  const since = new Date(nowMs - HOUR_MS).toISOString();
  const failed = all<{ step: string; n: number }>(db, `SELECT step, COUNT(*) AS n FROM jobs WHERE state = 'failed' AND ended_at > ?${notHidden("repo", hidden, true)} GROUP BY step ORDER BY n DESC`, since, ...hidden);
  const nFailed = failed.reduce((a, f) => a + f.n, 0);
  if (nFailed) {
    const steps = failed.slice(0, 3).map((f) => stepTitle(f.step)).join(", ");
    add({ id: "jobs", area: "jobs", tone: "warn", text: `${nFailed} job${nFailed === 1 ? "" : "s"} failed in the last hour: ${steps}${failed.length > 3 ? " and more" : ""}`, to: "/pipeline", since: null });
  }

  if (state.enabled) {
    const on = pipelineRepos(db);
    const off = visible.filter((r) => !on.has(r));
    if (off.length) add({ id: "repos", area: "repos", tone: "info", text: `Pipeline is off for ${off.slice(0, 3).join(", ")}${off.length > 3 ? ` and ${off.length - 3} more` : ""}`, to: "/repos", since: null });
  }
  return { pipeline: { enabled: state.enabled, by: state.changedBy, at: state.changedAt }, problems: out };
}

// ---- running -----------------------------------------------------------------

function running(db: DatabaseSync, hidden: string[]): NowRunning[] {
  const shown = shownLookup(db);
  const show = (repo: string, number: number): Item => ({ repo, number, ...shown(repo, number) });
  const out: NowRunning[] = [];
  const jobRows = new Map<number, NowRunning>();
  // A call or task of a running job nests under the job's row; the rest stay top-level.
  const place = (jobId: number | null, row: NowRunning) => {
    const parent = jobId === null ? undefined : jobRows.get(jobId);
    if (parent) parent.children.push(row);
    else out.push(row);
  };

  for (const j of all<{ id: number; step: string; started_at: string | null; requested_at: string; progress: string | null; repo: string | null }>(db,
    `SELECT id, step, started_at, requested_at, progress, repo FROM jobs WHERE state = 'running'${notHidden("repo", hidden, true)} ORDER BY id DESC`, ...hidden)) {
    const its = all<{ id: number; repo: string; number: number }>(db, `SELECT id, repo, number FROM job_items WHERE job_id = ?${notHidden("repo", hidden)} ORDER BY id`, j.id, ...hidden);
    const row: NowRunning = {
      key: `job:${j.id}`, kind: "job", step: stepTitle(j.step), what: null, state: "running", startedAt: j.started_at ?? j.requested_at, progress: j.progress, repo: j.repo,
      items: its.slice(0, PER_KIND).map((i) => show(i.repo, i.number)), itemCount: its.length, event: its[0] ? `job:${its[0].id}` : null, detail: `/pipeline/${j.id}`, children: [],
    };
    jobRows.set(j.id, row);
    out.push(row);
  }

  const hiddenRuns = hidden.length ? ` AND NOT EXISTS (SELECT 1 FROM agent_run_items x WHERE x.run_id = r.id AND x.repo IN (${marks(hidden)}))` : "";
  for (const r of all<{ id: number; job_id: number | null; step: string; model: string; provider: string; label: string | null; started_at: string; progress: string | null; item_count: number }>(db,
    `SELECT r.id, r.job_id, r.step, r.model, r.provider, COALESCE(a.label, r.account_id) AS label, r.started_at, r.progress, r.item_count
     FROM agent_runs r LEFT JOIN claude_accounts a ON a.id = r.account_id WHERE r.state = 'running'${hiddenRuns} ORDER BY r.id DESC`, ...hidden)) {
    const its = all<{ repo: string; number: number }>(db, "SELECT repo, number FROM agent_run_items WHERE run_id = ? ORDER BY repo, number LIMIT ?", r.id, PER_KIND);
    place(r.job_id, {
      key: `run:${r.id}`, kind: "model-call", step: stepTitle(r.step), what: r.provider === "jev" ? "Jev" : `${r.model} on ${r.label ?? "an unknown account"}`, state: "running", startedAt: r.started_at,
      progress: r.progress, repo: its[0]?.repo ?? null, items: its.map((i) => show(i.repo, i.number)), itemCount: Math.max(r.item_count, its.length), event: its[0] ? `run:${r.id}` : null, detail: `/agents/${r.id}`, children: [],
    });
  }

  for (const t of all<{ id: number; job_id: number | null; step: string; repo: string; number: number | null; state: string; queued_at: string; started_at: string | null; summary: string | null; label: string | null }>(db,
    `SELECT t.id, t.job_id, t.step, t.repo, t.number, t.state, t.queued_at, t.started_at, t.summary, e.label FROM build_tasks t LEFT JOIN build_envs e ON e.id = t.env_id
     WHERE t.state IN ('queued', 'claimed', 'running')${notHidden("t.repo", hidden)} ORDER BY t.id DESC`, ...hidden)) {
    place(t.job_id, {
      key: `task:${t.id}`, kind: "task", step: `Build task, ${stepTitle(t.step)}`, what: t.label, state: t.state === "queued" ? "queued" : "running", startedAt: t.started_at ?? t.queued_at, progress: t.summary, repo: t.repo,
      items: t.number === null ? [] : [show(t.repo, t.number)], itemCount: t.number === null ? 0 : 1, event: t.number === null ? null : `task:${t.id}`, detail: `/envs/${t.id}`, children: [],
    });
  }

  for (const b of all<{ id: number; repo: string; branch: string; state: string; created_at: string; summary: string | null }>(db,
    `SELECT id, repo, branch, state, created_at, summary FROM merge_batches WHERE state IN ('checking', 'open')${notHidden("repo", hidden)} ORDER BY id DESC`, ...hidden)) {
    const prs = all<{ number: number }>(db, "SELECT number FROM merge_batch_prs WHERE batch_id = ? ORDER BY position", b.id);
    out.push({
      key: `batch:${b.id}`, kind: "batch", step: "Integration batch", what: b.branch, state: b.state === "checking" ? "running" : "open", startedAt: b.created_at, progress: b.summary,
      repo: b.repo, items: prs.slice(0, PER_KIND).map((p) => show(b.repo, p.number)), itemCount: prs.length, event: null, detail: "/queue/merge", children: [],
    });
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

// ---- just happened -----------------------------------------------------------

const refOf = (target: string | null): { repo: string; number: number } | null => {
  const m = /^(.+)#(\d+)$/.exec(target ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
};

function recent(db: DatabaseSync, hidden: string[], staff: boolean): NowEvent[] {
  const shown = shownLookup(db);
  const item = (repo: string, number: number): Item => ({ repo, number, ...shown(repo, number) });
  const out: NowEvent[] = [];
  const hide = new Set(hidden);

  // Merges have their own rows below; the audit row of the same merge would list it twice.
  const actions = Object.keys(GITHUB_ACTIONS).filter((a) => a !== "merge");
  for (const a of all<{ rowid: number; at: string; login: string; action: string; target: string | null; details: string | null }>(db,
    `SELECT rowid, at, login, action, target, details FROM audit WHERE action IN (${marks(actions)}) ORDER BY at DESC LIMIT ?`, ...actions, RECENT * 3)) {
    const ref = refOf(a.target);
    if (!ref || hide.has(ref.repo)) continue;
    const e = writeEvent(a, staff);
    out.push({ key: e.id, kind: "write", at: a.at, summary: e.summary, actor: e.actor.name, item: item(ref.repo, ref.number), event: e.id, detail: null });
  }

  for (const m of all<{ rowid: number; repo: string; number: number; at: string; path: string; method: string | null }>(db,
    `SELECT rowid, repo, number, at, path, method FROM merges WHERE outcome = 'merged'${notHidden("repo", hidden)} ORDER BY at DESC LIMIT ?`, ...hidden, PER_KIND * 3)) {
    out.push({
      key: `merge:${m.rowid}`, kind: "merge", at: m.at, actor: "AutoCraft", item: item(m.repo, m.number), event: `merge:${m.rowid}`, detail: null,
      summary: `Merged${m.method ? ` (${m.method})` : ""}${m.path === "operator" ? " after an answered decision" : " by rule"}`,
    });
  }

  for (const d of all<{ id: string; repo: string | null; number: number | null; items: string | null; question: string; answer: string | null; answered_at: string; answered_by: string | null }>(db,
    "SELECT id, repo, number, items, question, answer, answered_at, answered_by FROM decisions WHERE answered_at IS NOT NULL ORDER BY answered_at DESC LIMIT ?", RECENT)) {
    let ref: { repo: string; number: number } | null = d.repo && d.number !== null ? { repo: d.repo, number: d.number } : null;
    let repos = d.repo ? [d.repo] : [];
    if (!ref) {
      try {
        const list = (JSON.parse(d.items ?? "[]") as { repo?: unknown; number?: unknown }[]).filter((i): i is { repo: string; number: number } => typeof i.repo === "string" && typeof i.number === "number");
        repos = [...repos, ...list.map((i) => i.repo)];
        ref = list[0] ?? null;
      } catch { /* malformed: no item */ }
    }
    if (repos.some((r) => hide.has(r))) continue;
    out.push({
      key: `decision:${d.id}`, kind: "decision", at: d.answered_at, actor: d.answered_by || "unknown", item: ref && item(ref.repo, ref.number), event: d.number !== null && d.repo ? `decision:${d.id}:answered` : null,
      summary: `Answered "${clip(d.question, 80)}": ${d.answer ?? ""}`, detail: `/decisions/${encodeURIComponent(d.id)}`,
    });
  }

  for (const j of all<{ id: number; step: string; ended_at: string; error: string | null; repo: string | null }>(db,
    `SELECT id, step, ended_at, error, repo FROM jobs WHERE state = 'failed' AND ended_at IS NOT NULL${notHidden("repo", hidden, true)} ORDER BY ended_at DESC LIMIT ?`, ...hidden, PER_KIND * 2)) {
    const i = db.prepare(`SELECT id, repo, number FROM job_items WHERE job_id = ?${notHidden("repo", hidden)} ORDER BY id LIMIT 1`).get(j.id, ...hidden) as { id: number; repo: string; number: number } | undefined;
    out.push({ key: `failed-job:${j.id}`, kind: "failure", at: j.ended_at, actor: "AutoCraft", item: i ? item(i.repo, i.number) : null, event: i ? `job:${i.id}` : null, detail: `/pipeline/${j.id}`,
      summary: `${stepTitle(j.step)} failed${j.error ? `: ${clip(j.error, 100)}` : ""}` });
  }

  const hiddenRuns = hidden.length ? ` AND NOT EXISTS (SELECT 1 FROM agent_run_items x WHERE x.run_id = r.id AND x.repo IN (${marks(hidden)}))` : "";
  for (const r of all<{ id: number; step: string; model: string; ended_at: string | null; started_at: string; error: string | null }>(db,
    `SELECT r.id, r.step, r.model, r.ended_at, r.started_at, r.error FROM agent_runs r WHERE r.state = 'failed'${hiddenRuns} ORDER BY r.id DESC LIMIT ?`, ...hidden, PER_KIND * 2)) {
    const i = db.prepare("SELECT repo, number FROM agent_run_items WHERE run_id = ? ORDER BY repo, number LIMIT 1").get(r.id) as { repo: string; number: number } | undefined;
    out.push({ key: `failed-run:${r.id}`, kind: "failure", at: r.ended_at ?? r.started_at, actor: r.model, item: i ? item(i.repo, i.number) : null, event: i ? `run:${r.id}` : null, detail: `/agents/${r.id}`,
      summary: `${stepTitle(r.step)}: model call failed${r.error ? `, ${clip(r.error, 100)}` : ""}` });
  }

  for (const t of all<{ id: number; step: string; repo: string; number: number | null; state: string; ended_at: string | null; queued_at: string; summary: string | null }>(db,
    `SELECT id, step, repo, number, state, ended_at, queued_at, summary FROM build_tasks WHERE state IN ('failed', 'lost')${notHidden("repo", hidden)} ORDER BY id DESC LIMIT ?`, ...hidden, PER_KIND * 2)) {
    out.push({ key: `failed-task:${t.id}`, kind: "failure", at: t.ended_at ?? t.queued_at, actor: "AutoCraft", item: t.number === null ? null : item(t.repo, t.number), event: t.number === null ? null : `task:${t.id}`, detail: `/envs/${t.id}`,
      summary: `Build task (${stepTitle(t.step)}) ${t.state}${t.summary ? `: ${clip(t.summary, 100)}` : ""}` });
  }

  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1)).slice(0, RECENT);
}

export async function now(db: DatabaseSync, req: Req): Promise<Now> {
  const hidden = await hiddenRepos(db, req);
  const visible = await visibleRepos(db, req);
  return { health: await healthOf(db, visible, hidden, Date.now()), running: running(db, hidden), recent: recent(db, hidden, canSeeInternals(req)) };
}
