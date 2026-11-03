// Approves the Actions runs that GitHub holds for approval (`action_required`) on pull requests from outside
// contributors, once the current head has a final take or take-fix review: the review read that code, and the
// runs use GitHub's runners. The checks sync records the waiting runs per PR head (detectRuns); the ci-approve
// step approves them (approveRuns) for repos an operator approved. Set only from the dashboard (src/dash/api/admin.ts).
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import type { Exec } from "../fixup/git.ts";
import { ghApproveRun, type Writer } from "../github/write.ts";
import { pilotSql } from "../pilot.ts";
import { trackedNames } from "../repos.ts";
import { ghExec, type Gh } from "./safe-merge.ts";

export type CiApproval = { by: string; at: string };
const key = (repo: string) => `ci_approved:${repo}`;

export function ciApprovalOf(db: DatabaseSync, repo: string): CiApproval | null {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key(repo)) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CiApproval;
  } catch {
    return null;
  }
}

// Returns false when nothing changed.
export function setCiApproval(db: DatabaseSync, by: string, repo: string, approved: boolean): boolean {
  if (!db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  if ((ciApprovalOf(db, repo) !== null) === approved) return false;
  if (approved) db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?)").run(key(repo), JSON.stringify({ by, at: new Date().toISOString() }));
  else db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  audit(db, by, approved ? "ci-approve" : "ci-revoke", repo);
  return true;
}

export type WaitingRun = { id: number; name: string };
type Candidate = { number: number; head: string; runs: WaitingRun[] | null };

/**
 * Open, non-draft PRs of the repo whose latest review is a final take or take-fix at the head the checks describe,
 * with the waiting runs recorded for that head (null when none were read yet). Our own integration PRs are left out.
 */
export function reviewedHeads(db: DatabaseSync, repo: string): Candidate[] {
  const rows = db.prepare(`SELECT i.number, l.head_oid AS head, a.runs FROM items i
    JOIN final_reviews l ON l.repo = i.repo AND l.number = i.number AND l.head_oid = (
      SELECT r.head_oid FROM reviews r WHERE r.repo = i.repo AND r.number = i.number ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number AND c.head_oid = l.head_oid AND c.state = 'OPEN' AND c.is_draft = 0
    LEFT JOIN ci_run_approvals a ON a.repo = i.repo AND a.number = i.number AND a.head_oid = l.head_oid
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND l.verdict IN ('take', 'take-fix') AND l.final = 1
      AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} ORDER BY i.number`).all(repo) as { number: number; head: string; runs: string | null }[];
  return rows.map((r) => ({ number: r.number, head: r.head, runs: r.runs === null ? null : (JSON.parse(r.runs) as WaitingRun[]) }));
}

/** Reviewed heads whose runs were not read yet or were waiting at the last read: the ones the sync (or the step) must read. */
export const needsRead = (db: DatabaseSync, repo: string): Candidate[] => reviewedHeads(db, repo).filter((c) => c.runs === null || c.runs.length > 0);

type RunsReply = { workflow_runs?: { id: number; name?: string | null; head_sha?: string }[] };

/** Reads the runs waiting for approval at each reviewed head that needs it (one request per PR) and records them. Returns the PRs read. */
export async function detectRuns(db: DatabaseSync, repo: string, gh: Gh = ghExec, log: (line: string) => void = () => {}): Promise<number> {
  let n = 0;
  for (const c of needsRead(db, repo)) {
    let runs: WaitingRun[];
    try {
      const r = JSON.parse(await gh(["api", `repos/${ORG}/${repo}/actions/runs?head_sha=${c.head}&status=action_required&per_page=100`])) as RunsReply;
      runs = (r.workflow_runs ?? []).filter((w) => w.head_sha === c.head).map((w) => ({ id: w.id, name: w.name ?? "" }));
    } catch (e) {
      log(`ci-approval: ${repo}#${c.number}: ${(e as Error).message}`);
      continue;
    }
    n++;
    db.prepare(`INSERT INTO ci_run_approvals (repo, number, head_oid, runs, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (repo, number) DO UPDATE SET head_oid = excluded.head_oid, runs = excluded.runs, checked_at = excluded.checked_at, approved_at = NULL`)
      .run(repo, c.number, c.head, JSON.stringify(runs), new Date().toISOString());
  }
  return n;
}

export type ApproveDeps = {
  /** Reads from GitHub (`gh api` arguments). */
  gh: Gh;
  /** Runs the approving write. */
  exec: Exec;
  /** Most PRs to approve runs for. */
  limit: number;
  log?: (line: string) => void;
};
export type ApproveResult = { approved: string[]; skipped: string[]; failed: string[] };

/** Approves the waiting runs of every reviewed head whose PR is still open, not a draft and at that head. The caller checks the repo's approval. */
export async function approveRuns(db: DatabaseSync, repo: string, d: ApproveDeps): Promise<ApproveResult> {
  const log = d.log ?? (() => {});
  const w: Writer = { db, login: "ci-approve" };
  await detectRuns(db, repo, d.gh, log);
  const out: ApproveResult = { approved: [], skipped: [], failed: [] };
  for (const c of reviewedHeads(db, repo).filter((x) => x.runs?.length)) {
    if (out.approved.length + out.failed.length >= d.limit) break;
    const ref = `${repo}#${c.number}`;
    let pr: { state?: string; draft?: boolean; head?: { sha?: string } };
    try {
      pr = JSON.parse(await d.gh(["api", `repos/${ORG}/${repo}/pulls/${c.number}`]));
    } catch (e) {
      log(`${ref}: ${(e as Error).message}`);
      out.failed.push(ref);
      continue;
    }
    if (pr.state !== "open" || pr.draft !== false || pr.head?.sha !== c.head) {
      log(`${ref}: no longer open, a draft, or at another head; skipped`);
      out.skipped.push(ref);
      continue;
    }
    const left: WaitingRun[] = [];
    for (const run of c.runs!) {
      const r = await ghApproveRun(w, d.exec, { repo, number: c.number, runId: run.id }, { head: c.head, workflow: run.name });
      if (r.code !== 0) left.push(run);
    }
    db.prepare("UPDATE ci_run_approvals SET runs = ?, approved_at = ? WHERE repo = ? AND number = ? AND head_oid = ?")
      .run(JSON.stringify(left), left.length ? null : new Date().toISOString(), repo, c.number, c.head);
    (left.length ? out.failed : out.approved).push(ref);
    log(`${ref}: ${left.length ? `${left.length} of ${c.runs!.length} runs not approved` : `approved ${c.runs!.length} runs`}`);
  }
  return out;
}

export const commands = {
  "ci-approval": {
    summary: "ci-approval [--repo R]: whether the pipeline may approve waiting CI runs of reviewed outside PRs, per tracked repo",
    run(args: string[]): void {
      const db = connect();
      const i = args.indexOf("--repo");
      for (const repo of i >= 0 ? [args[i + 1] ?? ""] : trackedNames(db)) {
        const a = ciApprovalOf(db, repo);
        console.log(`${repo}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
