// What our pushes did to the required checks of their PRs, and the circuit breaker built on it (pure rules: core/push-outcome.ts).
// Recording happens where the push is audited (github/write.ts); the outcome is computed where the checks are stored (review/checks.ts).
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";
import { optionalChecks } from "./optional-checks.ts";
import {
  breakerTripped, classifyPush, PUSH_STAGE, requiredResult, STEP_STAGE, TRIP_STAGES,
  type Outcome, type Required, type TripStage,
} from "./core/push-outcome.ts";

/** Unresolved pushes older than this get the outcome `unknown` (the head moved on, or the checks never ran). */
const EXPIRE_MS = 3 * 24 * 3_600_000;

type CheckRow = { name: string; state: string }[];
const parse = (s: string | null | undefined): CheckRow => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as CheckRow) : []; } catch { return []; } };

/**
 * Records a push that succeeded: the required-check result at the head before it (from the stored checks, when they are for that head).
 * A branch the push created has no earlier head and counts as green. Pushes of other kinds (batches, main fixes) are not recorded.
 */
export function recordPush(db: DatabaseSync, action: string, o: { repo: string; number: number | null; from: string | null; to: string }, at = new Date().toISOString()): void {
  const stage = PUSH_STAGE[action];
  if (!stage) return;
  let before: Required | "unknown" = "unknown";
  if (!o.from) before = "green";
  else if (o.number !== null) {
    const row = db.prepare("SELECT head_oid, checks FROM pr_checks WHERE repo = ? AND number = ?").get(o.repo, o.number) as { head_oid: string; checks: string } | undefined;
    if (row && row.head_oid === o.from) before = requiredResult(parse(row.checks), optionalChecks(db, o.repo));
  }
  db.prepare("INSERT INTO push_outcomes (at, stage, action, repo, number, from_oid, to_oid, before_res) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(at, stage, action, o.repo, o.number, o.from, o.to, before);
}

/**
 * Called with freshly stored checks: settles the pushes whose resulting commit is the PR's head and whose checks are final,
 * expires old unsettled ones, and lets the breaker look at every stage that got a `broke`.
 */
export function resolvePushes(db: DatabaseSync, rows: { repo: string; number: number; head_oid: string; checks: CheckRow }[], at = new Date().toISOString()): void {
  const find = db.prepare("SELECT id, stage, before_res FROM push_outcomes WHERE repo = ? AND to_oid = ? AND outcome IS NULL AND (number = ? OR number IS NULL)");
  const set = db.prepare("UPDATE push_outcomes SET number = ?, after_res = ?, outcome = ?, resolved_at = ? WHERE id = ?");
  const broke = new Set<string>();
  for (const r of rows) {
    const open = find.all(r.repo, r.head_oid, r.number) as { id: number; stage: string; before_res: string }[];
    if (!open.length) continue;
    const after = requiredResult(r.checks, optionalChecks(db, r.repo));
    for (const p of open) {
      const outcome = classifyPush(p.before_res as Required | "unknown", after);
      if (outcome === null) continue;
      set.run(r.number, after, outcome, at, p.id);
      if (outcome === "broke") broke.add(p.stage);
    }
  }
  const old = new Date(Date.parse(at) - EXPIRE_MS).toISOString();
  if (db.prepare("SELECT 1 FROM push_outcomes WHERE outcome IS NULL AND at < ? LIMIT 1").get(old))
    db.prepare("UPDATE push_outcomes SET outcome = 'unknown', resolved_at = ? WHERE outcome IS NULL AND at < ?").run(at, old);
  for (const s of broke) evaluatePushBreaker(db, s as TripStage, at);
}

/** The head the PR is at when our push to it broke a required check and nothing was pushed since, or null. */
export function brokeHeads(db: DatabaseSync, repo?: string): Map<string, string> {
  const rows = db.prepare(`SELECT repo, number, to_oid FROM push_outcomes WHERE outcome = 'broke' AND number IS NOT NULL ${repo ? "AND repo = ?" : ""} ORDER BY id`).all(...(repo ? [repo] : [])) as { repo: string; number: number; to_oid: string }[];
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r.to_oid]));
}

// ---- circuit breaker --------------------------------------------------------------------------------------

type TripRow = { stage: string; active: number; reason: string; evidence: string; tripped_at: string; cleared_at: string | null; cleared_by: string | null };
const tripRow = (db: DatabaseSync, stage: string): TripRow | undefined => db.prepare("SELECT * FROM stage_trips WHERE stage = ?").get(stage) as TripRow | undefined;

/** Stages that are tripped now, with the reason. */
export function activeTrips(db: DatabaseSync): Partial<Record<TripStage, string>> {
  const out: Partial<Record<TripStage, string>> = {};
  for (const r of db.prepare("SELECT stage, reason FROM stage_trips WHERE active = 1").all() as { stage: string; reason: string }[]) out[r.stage as TripStage] = r.reason;
  return out;
}

/** Why the runner step cannot start because its stage tripped, or null. */
export function tripReasonOfStep(db: DatabaseSync, step: string): string | null {
  const stage = STEP_STAGE[step];
  const r = stage ? tripRow(db, stage) : undefined;
  return r?.active ? `tripped: ${r.reason}; an operator resumes it` : null;
}

/** Evidence of a trip, for the Pipeline page and the audit log. */
export function tripEvidence(db: DatabaseSync, stage: string): string[] {
  const r = tripRow(db, stage);
  try { return r ? (JSON.parse(r.evidence) as string[]) : []; } catch { return []; }
}

function trip(db: DatabaseSync, stage: TripStage, reason: string, evidence: string[], at: string): void {
  const r = tripRow(db, stage);
  if (r?.active) return;
  db.prepare(`INSERT INTO stage_trips (stage, active, reason, evidence, tripped_at) VALUES (?, 1, ?, ?, ?)
    ON CONFLICT (stage) DO UPDATE SET active = 1, reason = excluded.reason, evidence = excluded.evidence, tripped_at = excluded.tripped_at`)
    .run(stage, reason, JSON.stringify(evidence), at);
  audit(db, "pipeline", "stage-trip", stage, { reason, evidence });
}

const sinceOf = (db: DatabaseSync, stage: string): string => tripRow(db, stage)?.cleared_at ?? "";

/** Trips a push stage when BREAKER_BROKE of its last BREAKER_WINDOW pushes since the last resume broke a required check. */
export function evaluatePushBreaker(db: DatabaseSync, stage: TripStage, at = new Date().toISOString()): void {
  if (tripRow(db, stage)?.active) return;
  const rows = db.prepare("SELECT outcome, repo, number, to_oid FROM push_outcomes WHERE stage = ? AND at > ? ORDER BY id DESC LIMIT 10").all(stage, sinceOf(db, stage)) as { outcome: Outcome | null; repo: string; number: number | null; to_oid: string }[];
  if (!breakerTripped(rows.map((r) => r.outcome))) return;
  const bad = rows.filter((r) => r.outcome === "broke");
  trip(db, stage, `${bad.length} of the last ${rows.length} ${stage} pushes broke a required check`, bad.map((r) => `${r.repo}#${r.number}@${r.to_oid.slice(0, 8)}`), at);
}

const weMerged = (db: DatabaseSync, repo: string, number: number): { at: string } | undefined =>
  db.prepare("SELECT at FROM merges WHERE repo = ? AND number = ? AND outcome = 'merged' ORDER BY at DESC LIMIT 1").get(repo, number) as { at: string } | undefined;

/** The default branch of `repo` is red and its culprit is PR `number` (main CI): trips the merge path when we merged that PR after the last resume. */
export function mainRedAfterMerge(db: DatabaseSync, repo: string, number: number, sha: string, at = new Date().toISOString()): void {
  const m = weMerged(db, repo, number);
  if (!m || m.at <= sinceOf(db, "merge")) return;
  trip(db, "merge", `main CI of ${repo} is red after our merge of #${number}`, [`${repo}#${number}`, `${repo}@${sha.slice(0, 8)}`], at);
}

/** A post-merge review of a PR we merged found defects. */
export function mergeDefect(db: DatabaseSync, repo: string, number: number, defects: number, at = new Date().toISOString()): void {
  if (defects < 1) return;
  const m = weMerged(db, repo, number);
  if (!m || m.at <= sinceOf(db, "merge")) return;
  trip(db, "merge", `the post-merge review of ${repo}#${number} found ${defects} defect${defects === 1 ? "" : "s"}`, [`${repo}#${number}`], at);
}

export class TripError extends Error {
  status = 400;
}

/** An operator clears a trip. Pushes and merges before this moment no longer count. */
export function resumeStage(db: DatabaseSync, stage: string, by: string): void {
  if (!(TRIP_STAGES as readonly string[]).includes(stage)) throw new TripError(`no such stage: ${stage}; stages: ${TRIP_STAGES.join(", ")}`);
  const r = tripRow(db, stage);
  if (!r?.active) throw new TripError(`${stage} is not paused by the circuit breaker`);
  const at = new Date().toISOString();
  db.prepare("UPDATE stage_trips SET active = 0, cleared_at = ?, cleared_by = ? WHERE stage = ?").run(at, by, stage);
  audit(db, by, "stage-resume", stage, { reason: r.reason });
}
