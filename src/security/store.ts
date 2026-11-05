// Rows of the security deep scan and their views for the API (web/src/api/types.ts).
import type { DatabaseSync } from "node:sqlite";
import type { FindingCall, FindingRef, FindingSeverity, FindingState, FindingSummary, FindingVerification, FindingView, ScanState, ScanView, SecurityOverview } from "../../web/src/api/types.ts";

export const ACTIVE_STATES: ScanState[] = ["modeling", "scanning", "verifying"];
/** Findings in these states are the scan's own bookkeeping, never listed. */
export const INTERNAL_FINDING_STATES = ["unverified", "disproved", "duplicate"] as const;
const HIDDEN = INTERNAL_FINDING_STATES.map((s) => `'${s}'`).join(", ");
const now = (): string => new Date().toISOString();

type ScanRow = {
  id: number; repo: string; commit_sha: string | null; state: ScanState; cap_usd: number | null; cost_usd: number; estimate_usd: number | null;
  areas_total: number; areas_done: number; started_by: string; started_at: string; ended_at: string | null; error: string | null; job_id: number | null; threat_model: string | null;
};

export const scanRow = (db: DatabaseSync, id: number): ScanRow | undefined => db.prepare("SELECT * FROM security_scans WHERE id = ?").get(id) as ScanRow | undefined;

export function toScan(db: DatabaseSync, r: ScanRow): ScanView {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM security_findings WHERE scan_id = ? AND state NOT IN (${HIDDEN})`).get(r.id) as { n: number }).n;
  return {
    id: r.id, repo: r.repo, commit: r.commit_sha, state: r.state, capUsd: r.cap_usd, costUsd: r.cost_usd, estimateUsd: r.estimate_usd,
    areasTotal: r.areas_total, areasDone: r.areas_done, findingCount: n, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, error: r.error,
  };
}

/** The active scan of a repo, if any. Scans of one repo never overlap. */
export function activeScan(db: DatabaseSync, repo: string): ScanRow | undefined {
  return db.prepare(`SELECT * FROM security_scans WHERE repo = ? AND state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")}) ORDER BY id DESC LIMIT 1`).get(repo) as ScanRow | undefined;
}

/** An active scan whose job has ended without the scan finishing (a killed runner, a cancelled job) is closed: stopped when the job was cancelled, else failed. */
export function reconcileScans(db: DatabaseSync, repo?: string): void {
  const rows = db.prepare(`SELECT s.id, j.state AS job_state FROM security_scans s JOIN jobs j ON j.id = s.job_id
    WHERE s.state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")}) AND j.state IN ('done', 'failed', 'cancelled')${repo ? " AND s.repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { id: number; job_state: string }[];
  // A scan whose job was never recorded (the request died between the insert and the enqueue) would block its repo for good.
  const orphans = db.prepare(`SELECT id FROM security_scans WHERE job_id IS NULL AND started_at < ? AND state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")})${repo ? " AND repo = ?" : ""}`)
    .all(new Date(Date.now() - 60_000).toISOString(), ...(repo ? [repo] : [])) as { id: number }[];
  for (const o of orphans) finishScan(db, o.id, "failed", "The scan was never queued.");
  for (const r of rows) {
    const cancelled = r.job_state === "cancelled";
    finishScan(db, r.id, cancelled ? "stopped" : "failed", cancelled ? null : "The scan's job ended before the scan finished.");
  }
}

/** Ends an active scan; a scan that already ended keeps its state. Leftover unverified findings become listed findings that say so. */
export function finishScan(db: DatabaseSync, id: number, state: ScanState, error: string | null = null): void {
  db.prepare(`UPDATE security_scans SET state = ?, ended_at = ?, error = ? WHERE id = ? AND state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")})`).run(state, now(), error, id);
  const unchecked = JSON.stringify({ kind: "reasoning", result: "Not verified: the scan ended before this finding was checked.", notes: "", score: null, proposedTest: null } satisfies FindingVerification);
  db.prepare("UPDATE security_findings SET state = 'new', verification = ?, updated_at = ? WHERE scan_id = ? AND state = 'unverified'").run(unchecked, now(), id);
}

const parse = <T>(s: string | null, fallback: T): T => {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
};

type FindingRow = {
  repo: string; number: number; scan_id: number; area: string; title: string; severity: FindingSeverity; urgent: number; state: FindingState; refs: string;
  reach: string; impact: string; verification: string | null; fix_commit: string | null; fix_pr: number | null; ghsa_id: string | null; reason: string | null; decided_by: string | null; created_at: string; updated_at: string;
};

export const findingKey = (repo: string, n: number): string => `${repo}:finding:${n}`;

const summary = (r: FindingRow): FindingSummary => ({
  repo: r.repo, number: r.number, key: findingKey(r.repo, r.number), scanId: r.scan_id, title: r.title, severity: r.severity, urgent: r.urgent === 1, area: r.area,
  state: r.state, createdAt: r.created_at, updatedAt: r.updated_at,
});

const SEVERITY_ORDER = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

export function overview(db: DatabaseSync, repo: string): SecurityOverview {
  reconcileScans(db, repo);
  const scans = (db.prepare("SELECT * FROM security_scans WHERE repo = ? ORDER BY id DESC LIMIT 20").all(repo) as ScanRow[]).map((r) => toScan(db, r));
  const findings = (db.prepare(`SELECT * FROM security_findings WHERE repo = ? AND state NOT IN (${HIDDEN}) ORDER BY ${SEVERITY_ORDER}, number LIMIT 500`).all(repo) as FindingRow[]).map(summary);
  return { scans, findings };
}

export const findingRow = (db: DatabaseSync, repo: string, n: number): FindingRow | undefined =>
  db.prepare(`SELECT * FROM security_findings WHERE repo = ? AND number = ? AND state NOT IN (${HIDDEN})`).get(repo, n) as FindingRow | undefined;

export function toFinding(db: DatabaseSync, r: FindingRow): FindingView {
  const area = db.prepare("SELECT idx FROM security_areas WHERE scan_id = ? AND name = ?").get(r.scan_id, r.area) as { idx: number } | undefined;
  const calls = db.prepare(`SELECT kind, started_at, ended_at, ok, cost_usd FROM security_calls
    WHERE scan_id = ? AND (kind = 'model' OR (kind = 'area' AND area_idx = ?) OR (kind = 'verify' AND finding_number = ?)) ORDER BY id`).all(r.scan_id, area?.idx ?? -1, r.number) as
    { kind: FindingCall["kind"]; started_at: string; ended_at: string | null; ok: number; cost_usd: number | null }[];
  const repeats = db.prepare("SELECT created_at FROM security_findings WHERE repo = ? AND duplicate_of = ? ORDER BY created_at").all(r.repo, r.number) as { created_at: string }[];
  const timeline: FindingCall[] = [
    ...calls.map((c) => ({ kind: c.kind, at: c.started_at, endedAt: c.ended_at, ok: c.ok === 1, costUsd: c.cost_usd })),
    ...repeats.map((d): FindingCall => ({ kind: "duplicate", at: d.created_at, endedAt: null, ok: true, costUsd: null })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    ...summary(r), refs: parse<FindingRef[]>(r.refs, []), reach: r.reach, impact: r.impact, verification: parse<FindingVerification | null>(r.verification, null),
    fixDiff: null, fixPr: r.fix_pr, ghsaId: r.ghsa_id, reason: r.reason, decidedBy: r.decided_by,
    timeline,
  };
}

/** The states a finding moves to by each operator action, and from which states. */
export const TRANSITIONS: Record<"dismiss" | "backlog" | "reopen", { from: FindingState[]; to: FindingState }> = {
  dismiss: { from: ["new", "backlog"], to: "dismissed" },
  backlog: { from: ["new", "dismissed"], to: "backlog" },
  reopen: { from: ["dismissed", "backlog"], to: "new" },
};

export function moveFinding(db: DatabaseSync, repo: string, n: number, action: keyof typeof TRANSITIONS, by: string, reason: string | null): FindingState | null {
  const t = TRANSITIONS[action];
  const marks = t.from.map(() => "?").join(", ");
  const r = db.prepare(`UPDATE security_findings SET state = ?, reason = ?, decided_by = ?, updated_at = ? WHERE repo = ? AND number = ? AND state IN (${marks})`)
    .run(t.to, action === "dismiss" ? reason : null, by, now(), repo, n, ...t.from);
  return r.changes ? t.to : null;
}
