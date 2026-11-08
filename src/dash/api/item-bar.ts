// The status bar at the top of the item page: one headline for what is happening to the item now, and the item's path through the
// pipeline stages as a stepper. Everything is read from rows the item already has (jobs, model calls, fix-ups, reviews, decisions,
// pre-approvals); no step is shown that no row backs, except the core stages still ahead of an open item.
import type { DatabaseSync } from "node:sqlite";
import type { ItemBar, ItemBarStep, ItemKind, ItemState, ItemStatus } from "../../../web/src/api/types.ts";
import { stagesInOrder, stageOfStep, type StageId } from "../../stages/registry.ts";
import { clip, stepTitle, type Ctx } from "./trace.ts";

/** core: shown while it is still ahead of an open item. seen: shown only once the item has been through it. */
type Role = "core" | "seen" | null;
const ROLE: Record<StageId, { pr: Role; issue: Role }> = {
  synced: { pr: null, issue: null }, labels: { pr: null, issue: null },
  dupes: { pr: "seen", issue: "seen" }, classify: { pr: "seen", issue: "seen" }, priority: { pr: "seen", issue: "seen" }, decide: { pr: "seen", issue: "seen" },
  review: { pr: "core", issue: null }, fix: { pr: null, issue: "seen" }, fixup: { pr: "seen", issue: null }, verify: { pr: "core", issue: null },
  merge: { pr: "core", issue: null }, act: { pr: null, issue: "seen" }, postmerge: { pr: "core", issue: null },
};

/** The stage an item's phase is in when no job says otherwise. */
const PHASE_STAGE: Partial<Record<ItemStatus["phase"], StageId>> = { Review: "review", Fixing: "fixup", Verifying: "verify", "In queue": "merge", "Waiting for a person": "decide" };

/** A failure outside the stage the item is in still heads the bar for this long. */
const RECENT_MS = 2 * 3600_000;

export interface Evidence { stage: StageId; state: "done" | "failed"; at: string; jobId: number | null; label: string; reason: string | null }

/** Steps of the stepper, in pipeline order. Pure: the rows are read by `evidenceOf`. */
export function deriveSteps(i: { kind: ItemKind; state: ItemState; current: StageId | null; running: boolean; evidence: Evidence[]; costs: Map<StageId, number> }): ItemBarStep[] {
  const latest = new Map<StageId, Evidence>();
  for (const e of i.evidence) {
    const had = latest.get(e.stage);
    if (!had || e.at >= had.at) latest.set(e.stage, e);
  }
  const roles = stagesInOrder().flatMap((s) => { const r = ROLE[s.id][i.kind === "pr" ? "pr" : "issue"]; return r ? [{ s, r }] : []; });
  const state = (id: StageId): ItemBarStep["state"] => (id === i.current ? "current" : latest.get(id)?.state ?? "next");
  const last = roles.reduce((m, { s }, idx) => (state(s.id) !== "next" ? idx : m), -1);
  const out: ItemBarStep[] = [];
  roles.forEach(({ s, r }, idx) => {
    const st = state(s.id);
    const ev = latest.get(s.id);
    if (st === "next") {
      // Ahead of the item: core stages of an open item, and the post-merge review of a merged one.
      if (r !== "core" || idx < last || i.state === "closed" || (i.state === "merged" && s.id !== "postmerge")) return;
    }
    out.push({ stage: s.id, title: s.title, state: st, running: st === "current" && i.running, at: st === "next" ? null : ev?.at ?? null, costUsd: i.costs.get(s.id) ?? null, jobId: ev?.jobId ?? null });
  });
  return out;
}

type Q = <T>(sql: string, ...args: (string | number)[]) => T[];

function evidenceOf(c: Ctx, q: Q, mergedAt: string | null): Evidence[] {
  const { repo, n } = c;
  const out: Evidence[] = [];
  const reasonOf = (s: string | null) => (c.staff && s ? clip(s, 160) : null);
  for (const j of q<{ id: number; step: string; state: string; ended_at: string | null; error: string | null }>(
    "SELECT j.id, j.step, j.state, j.ended_at, j.error FROM job_items ji JOIN jobs j ON j.id = ji.job_id WHERE ji.repo = ? AND ji.number = ? AND j.state IN ('done', 'failed') AND j.ended_at IS NOT NULL", repo, n)) {
    const stage = stageOfStep(j.step)?.id;
    if (stage) out.push({ stage, state: j.state === "failed" ? "failed" : "done", at: j.ended_at!, jobId: j.id, label: stepTitle(j.step), reason: j.state === "failed" ? reasonOf(j.error) : null });
  }
  for (const f of q<{ state: string; reason: string | null; created_at: string }>("SELECT state, reason, created_at FROM fixups WHERE repo = ? AND number = ? ORDER BY created_at DESC LIMIT 1", repo, n)) {
    if (f.state === "pushed") out.push({ stage: "fixup", state: "done", at: f.created_at, jobId: null, label: "Fix-up", reason: null });
    else if (/^(failed|refused|rejected)$/.test(f.state)) out.push({ stage: "fixup", state: "failed", at: f.created_at, jobId: null, label: "Fix-up", reason: reasonOf(f.reason) });
  }
  for (const r of q<{ at: string }>("SELECT MAX(at) AS at FROM opus_review_history WHERE repo = ? AND number = ? AND verdict IS NOT NULL HAVING at IS NOT NULL", repo, n)) out.push({ stage: "review", state: "done", at: r.at, jobId: null, label: "Review", reason: null });
  for (const r of q<{ at: string }>("SELECT MAX(answered_at) AS at FROM decisions WHERE repo = ? AND number = ? AND answer IS NOT NULL HAVING at IS NOT NULL", repo, n)) out.push({ stage: "decide", state: "done", at: r.at, jobId: null, label: "Decision", reason: null });
  for (const r of q<{ at: string }>("SELECT MAX(at) AS at FROM postmerge_reviews WHERE repo = ? AND number = ? HAVING at IS NOT NULL", repo, n)) out.push({ stage: "postmerge", state: "done", at: r.at, jobId: null, label: "Post-merge review", reason: null });
  if (mergedAt) out.push({ stage: "merge", state: "done", at: mergedAt, jobId: null, label: "Merge", reason: null });
  for (const p of q<{ state: string; reason: string | null; updated_at: string }>("SELECT state, reason, updated_at FROM preapprovals WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 1", repo, n))
    if (p.state === "failed" && !mergedAt) out.push({ stage: "merge", state: "failed", at: p.updated_at, jobId: null, label: "Pre-approved merge", reason: reasonOf(p.reason) });
  return out;
}

export function barOf(c: Ctx, it: { kind: ItemKind; state: ItemState; mergedAt: string | null }, status: ItemStatus): ItemBar {
  const { db, repo, n } = c;
  const q: Q = (sql, ...args) => db.prepare(sql).all(...args) as never;
  if (c.veiled) return { headline: { tone: "idle", text: status.phase, next: null, model: null, startedAt: null, jobId: null }, steps: [] };

  const active = q<{ id: number; step: string; state: string; started_at: string | null }>(
    `SELECT id, step, state, started_at FROM jobs WHERE state IN ('running', 'queued') AND ((repo = ?1 AND json_extract(params, '$.number') = ?2)
       OR id IN (SELECT job_id FROM job_items WHERE repo = ?1 AND number = ?2)) ORDER BY id`, repo, n);
  const runs = q<{ step: string; model: string; job_id: number | null; started_at: string }>(
    "SELECT r.step, r.model, r.job_id, r.started_at FROM agent_run_items i JOIN agent_runs r ON r.id = i.run_id WHERE i.repo = ? AND i.number = ? AND r.state = 'running' ORDER BY r.id", repo, n);
  const job = active.find((j) => j.state === "running");
  const run = runs.find((r) => job && r.job_id === job.id) ?? runs[0];
  const queued = active.find((j) => j.state === "queued");

  const evidence = evidenceOf(c, q, it.mergedAt);
  const costs = new Map<StageId, number>();
  for (const r of q<{ step: string; cost: number | null }>("SELECT r.step, r.cost_usd AS cost FROM agent_run_items i JOIN agent_runs r ON r.id = i.run_id WHERE i.repo = ? AND i.number = ? AND r.cost_usd IS NOT NULL", repo, n)) {
    const id = stageOfStep(r.step)?.id;
    if (id) costs.set(id, (costs.get(id) ?? 0) + r.cost!);
  }

  const runningStep = job?.step ?? run?.step ?? null;
  const open = it.state === "open";
  const latestFail = [...evidence].filter((e) => e.state === "failed").sort((a, b) => (a.at < b.at ? 1 : -1))
    .find((f) => !evidence.some((e) => e.stage === f.stage && e.state === "done" && e.at > f.at) && (f.stage === PHASE_STAGE[status.phase] || Date.now() - Date.parse(f.at) < RECENT_MS));
  const current: StageId | null = runningStep ? stageOfStep(runningStep)?.id ?? null : queued ? stageOfStep(queued.step)?.id ?? null : open ? PHASE_STAGE[status.phase] ?? null : null;

  let headline: ItemBar["headline"];
  const base = { next: status.next, model: null, startedAt: null, jobId: null };
  if (open && runningStep) headline = { tone: "running", text: `${stepTitle(runningStep)} running`, next: status.next, model: run?.model ?? null, startedAt: job?.started_at ?? run?.started_at ?? null, jobId: job?.id ?? run?.job_id ?? null };
  else if (open && queued) {
    const pos = (db.prepare("SELECT COUNT(*) AS k FROM jobs WHERE state = 'queued' AND step = ? AND id < ?").get(queued.step, queued.id) as { k: number }).k + 1;
    headline = { ...base, tone: "queued", text: `Queued for ${stepTitle(queued.step)} · #${pos} in line`, jobId: queued.id };
  } else if (open && status.phase === "Waiting for a person") headline = { ...base, tone: "waiting", text: status.waiting ? `Waiting for ${status.waiting}` : "Waiting for a person" };
  else if (open && latestFail) headline = { ...base, tone: "failed", text: `${latestFail.label} failed${latestFail.reason ? `: ${latestFail.reason}` : ""}`, jobId: latestFail.jobId };
  else if (!open) headline = { ...base, tone: "done", text: it.state === "merged" ? "Merged" : "Closed", next: it.state === "merged" ? status.next : null };
  else headline = { ...base, tone: "idle", text: status.waiting ? `${status.phase} · waiting for ${status.waiting}` : status.phase };

  const stepsRunning = headline.tone === "running";
  return { headline, steps: deriveSteps({ kind: it.kind, state: it.state, current, running: stepsRunning, evidence, costs }) };
}
