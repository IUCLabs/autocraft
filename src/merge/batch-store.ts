// Tables and pure rules of the merge queue's integration batches (see batch.ts).
import type { DatabaseSync } from "node:sqlite";
import { mergeApprovalOf as mergeApprovalOfSafe } from "./approval.ts";

export const BATCH_STATES = ["checking", "open", "merged", "failed", "split", "superseded"] as const;
export type BatchState = (typeof BATCH_STATES)[number];
/** States of a batch that is still being worked on. */
export const ACTIVE_BATCH: BatchState[] = ["checking", "open"];

/** Summary of a batch whose PR a person closed: its PRs stay out of batches until they change. */
export const CLOSED_BY_PERSON = "the batch PR was closed by a person";

export const MAX_BATCH = 10;
/** Changed lines (additions plus deletions) a batch may carry, beyond its first PR. */
export const MAX_BATCH_LINES = 2000;

export type BatchRow = {
  id: number; repo: string; branch: string; state: BatchState; base_sha: string; commit_sha: string; parent_id: number | null;
  task_id: number | null; retries: number; pr_number: number | null; pr_url: string | null; summary: string | null; created_at: string; updated_at: string;
};
export type BatchMember = { number: number; head_oid: string };

const sizeKey = (repo: string) => `batch_size:${repo}`;

/** Most PRs the repo's next batch takes: grows by one after a passing batch, halves after a failed one. */
export function batchSizeOf(db: DatabaseSync, repo: string): number {
  const v = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(sizeKey(repo)) as { value: string } | undefined)?.value;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_BATCH ? n : MAX_BATCH;
}
export function setBatchSize(db: DatabaseSync, repo: string, n: number): number {
  const size = Math.max(1, Math.min(MAX_BATCH, n));
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(sizeKey(repo), String(size));
  return size;
}
export const growBatchSize = (db: DatabaseSync, repo: string): number => setBatchSize(db, repo, batchSizeOf(db, repo) + 1);
export const shrinkBatchSize = (db: DatabaseSync, repo: string): number => setBatchSize(db, repo, Math.floor(batchSizeOf(db, repo) / 2));

export function membersOf(db: DatabaseSync, batchId: number): BatchMember[] {
  return db.prepare("SELECT number, head_oid FROM main.merge_batch_prs WHERE batch_id = ? ORDER BY position").all(batchId) as BatchMember[];
}

export function activeBatches(db: DatabaseSync, repo: string): BatchRow[] {
  return db.prepare(`SELECT * FROM main.merge_batches WHERE repo = ? AND state IN ('checking', 'open') ORDER BY id`).all(repo) as BatchRow[];
}

export function getBatch(db: DatabaseSync, id: number): BatchRow {
  return db.prepare("SELECT * FROM main.merge_batches WHERE id = ?").get(id) as BatchRow;
}

export function updateBatch(db: DatabaseSync, id: number, at: string, set: Partial<Pick<BatchRow, "state" | "task_id" | "retries" | "pr_number" | "pr_url" | "summary">>): void {
  const cols = Object.keys(set);
  db.prepare(`UPDATE main.merge_batches SET ${cols.map((c) => `${c} = ?`).join(", ")}${cols.length ? ", " : ""}updated_at = ? WHERE id = ?`)
    .run(...(Object.values(set) as (string | number | null)[]), at, id);
}

/** Points a checking batch at a new sandbox task. The summary of the earlier task is dropped: the batch line shows the current task's state. */
export function restartCheck(db: DatabaseSync, b: BatchRow, at: string, taskId: number): void {
  updateBatch(db, b.id, at, { task_id: taskId, retries: b.retries + 1, summary: null });
}

/** `integration-<repo>-<yyyymmdd>-<n>`, n counting the repo's batches of that day. */
export function nextBranch(db: DatabaseSync, repo: string, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `integration-${repo}-${day}-`;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM main.merge_batches WHERE repo = ? AND branch LIKE ?").get(repo, `${prefix}%`) as { n: number }).n;
  return `${prefix}${n + 1}`;
}

export function insertBatch(db: DatabaseSync, b: { repo: string; branch: string; baseSha: string; commitSha: string; parentId: number | null; taskId: number | null; members: BatchMember[]; at: string }): number {
  const r = db.prepare("INSERT INTO main.merge_batches (repo, branch, state, base_sha, commit_sha, parent_id, task_id, created_at, updated_at) VALUES (?, ?, 'checking', ?, ?, ?, ?, ?, ?)")
    .run(b.repo, b.branch, b.baseSha, b.commitSha, b.parentId, b.taskId, b.at, b.at);
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare("INSERT INTO main.merge_batch_prs (batch_id, number, head_oid, position) VALUES (?, ?, ?, ?)");
  b.members.forEach((m, i) => ins.run(id, m.number, m.head_oid, i));
  return id;
}

/** Whether the next candidate may join the PRs taken so far: up to `max` PRs and MAX_BATCH_LINES changed lines; an L-size PR goes alone. */
export function admits(taken: { size: string; lines: number }[], c: { size: string; lines: number }, max: number): boolean {
  if (taken.length === 0) return true;
  if (taken[0]!.size === "L" || taken.length >= max || c.size === "L") return false;
  return taken.reduce((a, t) => a + t.lines, 0) + c.lines <= MAX_BATCH_LINES;
}

/** Queue state each PR head in an active or failed batch is in: `repo#number@head` → batch-checking | in-batch | batch-failed. */
export function batchStates(db: DatabaseSync, repo?: string): Map<string, "batch-checking" | "in-batch" | "batch-failed"> {
  const rows = db.prepare(`SELECT b.repo, p.number, p.head_oid, b.state, b.summary, (SELECT COUNT(*) FROM main.merge_batch_prs q WHERE q.batch_id = b.id) AS n
    FROM main.merge_batch_prs p JOIN main.merge_batches b ON b.id = p.batch_id
    WHERE b.state IN ('checking', 'open', 'failed') ${repo ? "AND b.repo = ?" : ""} ORDER BY b.id`).all(...(repo ? [repo] : [])) as { repo: string; number: number; head_oid: string; state: string; summary: string | null; n: number }[];
  const out = new Map<string, "batch-checking" | "in-batch" | "batch-failed">();
  for (const r of rows) {
    if (r.state === "failed" && r.n !== 1 && r.summary !== CLOSED_BY_PERSON) continue;
    out.set(`${r.repo}#${r.number}@${r.head_oid}`, r.state === "checking" ? "batch-checking" : r.state === "open" ? "in-batch" : "batch-failed");
  }
  return out;
}

/** Repos with a batch that has something to do: a batch PR to watch, or a finished sandbox task to read. */
export function batchesDue(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT DISTINCT b.repo FROM main.merge_batches b LEFT JOIN main.build_tasks t ON t.id = b.task_id
    WHERE b.state = 'open' OR (b.state = 'checking' AND (t.id IS NULL OR t.state IN ('done', 'failed', 'cancelled', 'lost')))`).all() as { repo: string }[];
  return rows.filter((r) => mergeApprovalOfSafe(db, r.repo)).map((r) => r.repo);
}

/** Batches in flight plus the newest finished ones, newest first, with their PRs. */
export function listBatches(db: DatabaseSync, o: { repo?: string; exclude?: string[]; finished?: number } = {}): (BatchRow & { prs: BatchMember[] })[] {
  const rows = db.prepare(`SELECT * FROM main.merge_batches ${o.repo ? "WHERE repo = ?" : ""} ORDER BY id DESC`).all(...(o.repo ? [o.repo] : [])) as BatchRow[];
  let finished = 0;
  const out: (BatchRow & { prs: BatchMember[] })[] = [];
  for (const b of rows) {
    if (o.exclude?.includes(b.repo)) continue;
    if (!ACTIVE_BATCH.includes(b.state) && finished++ >= (o.finished ?? 20)) continue;
    out.push({ ...b, prs: membersOf(db, b.id) });
  }
  return out;
}
