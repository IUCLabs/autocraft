// The security deep scan API. Operators and maintainers read; operators act. Everyone else gets 404, so the
// endpoints do not show that findings exist.
import type { DatabaseSync } from "node:sqlite";
import type { FindingAction, FindingView, ScanView, SecurityOverview } from "../../../web/src/api/types.ts";
import { audit } from "../audit.ts";
import { enqueue, JobError, requestCancel } from "../../runner/jobs.ts";
import { SECURITY_REPO, SECURITY_STEP, REASON_MAX } from "../../security/rules.ts";
import { activeScan, ACTIVE_STATES, finishScan, findingKey, findingRow, moveFinding, overview, reconcileScans, scanRow, toFinding, toScan } from "../../security/store.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { needVisible } from "./visible.ts";

const NOT_FOUND = "not found";
/** The most a spend cap may be, in dollars. */
const CAP_MAX = 100_000;
/** Actions of the finding endpoint that later work builds. */
const UNBUILT: FindingAction[] = ["fix", "land", "advisory", "publish"];

function needStaff(req: Req): void {
  if (!canSeeInternals(req)) throw new HttpError(404, NOT_FOUND);
}

function needOperator(req: Req): void {
  needStaff(req);
  if (req.user.role !== "operator") throw new HttpError(403, "only operators start or stop scans and decide findings");
}

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

function number(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `not a ${what} number`);
  return n;
}

export async function security(db: DatabaseSync, req: Req): Promise<SecurityOverview> {
  needStaff(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  return overview(db, repo);
}

export async function startScan(db: DatabaseSync, req: Req): Promise<ScanView> {
  needOperator(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  const b = body(req);
  const cap = b.capUsd === undefined || b.capUsd === null ? null : b.capUsd;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX)) throw new HttpError(400, `capUsd must be a dollar amount above 0 and up to ${CAP_MAX}, or null for no cap`);
  reconcileScans(db, repo);
  if (activeScan(db, repo)) throw new HttpError(409, `${repo} already has a scan running`);
  const at = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO security_scans (repo, state, cap_usd, started_by, started_at) VALUES (?, 'modeling', ?, ?, ?)").run(repo, cap, req.user.login, at).lastInsertRowid);
  try {
    const job = await enqueue(db, SECURITY_STEP, { repo, scan: id }, req.user.login);
    // The job is recorded under the scan's pseudo repo, so every job listing that leaves out hidden repos leaves it out for viewers.
    db.prepare("UPDATE jobs SET repo = ? WHERE id = ?").run(SECURITY_REPO, job.id);
    db.prepare("UPDATE security_scans SET job_id = ? WHERE id = ?").run(job.id, id);
  } catch (e) {
    db.prepare("DELETE FROM security_scans WHERE id = ?").run(id);
    if (e instanceof JobError) throw new HttpError(e.status, e.message);
    throw e;
  }
  audit(db, req.user.login, "security-scan-start", `scan:${id}`, { repo, capUsd: cap });
  return toScan(db, scanRow(db, id)!);
}

export function stopScan(db: DatabaseSync, req: Req): ScanView {
  needOperator(req);
  const id = number(req.params.id, "scan");
  const scan = scanRow(db, id);
  if (!scan) throw new HttpError(404, NOT_FOUND);
  if (!ACTIVE_STATES.includes(scan.state)) throw new HttpError(409, `the scan already ended (${scan.state})`);
  // A running job sees the state or the cancel flag before its next call and ends the scan itself.
  if (scan.job_id !== null) {
    try { requestCancel(db, scan.job_id, req.user.login); } catch (e) { if (!(e instanceof JobError)) throw e; }
  }
  finishScan(db, id, "stopped");
  audit(db, req.user.login, "security-scan-stop", `scan:${id}`, { repo: scan.repo, was: scan.state });
  return toScan(db, scanRow(db, id)!);
}

export async function finding(db: DatabaseSync, req: Req): Promise<FindingView> {
  needStaff(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  const row = findingRow(db, repo, number(req.params.n, "finding"));
  if (!row) throw new HttpError(404, NOT_FOUND);
  return toFinding(db, row);
}

export async function actOnFinding(db: DatabaseSync, req: Req): Promise<FindingView> {
  needOperator(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  const n = number(req.params.n, "finding");
  const b = body(req);
  const action = b.action as FindingAction;
  if (UNBUILT.includes(action)) throw new HttpError(501, "not built yet");
  if (action !== "dismiss" && action !== "backlog" && action !== "reopen") throw new HttpError(400, "unknown action");
  const row = findingRow(db, repo, n);
  if (!row) throw new HttpError(404, NOT_FOUND);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, REASON_MAX) : "";
  if (action === "dismiss" && !reason) throw new HttpError(400, "dismissing needs a reason");
  const to = moveFinding(db, repo, n, action, req.user.login, reason || null);
  if (!to) throw new HttpError(409, `a finding that is ${row.state} cannot be ${action === "reopen" ? "reopened" : action === "dismiss" ? "dismissed" : "moved to the backlog"}`);
  audit(db, req.user.login, `security-finding-${action}`, findingKey(repo, n), { from: row.state, to, ...(reason && { reason }) });
  return toFinding(db, findingRow(db, repo, n)!);
}

