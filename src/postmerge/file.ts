// Filing: each post-merge defect with no duplicate becomes one GitHub issue, in repos approved for comments. The issue then
// goes through sync, classify and Fix like any other. The write is src/github/write.ts's `createIssue`.
import type { DatabaseSync } from "node:sqlite";
import { commentApprovalOf } from "../act/approval.ts";
import { exec, type Exec } from "../fixup/git.ts";
import { createIssue, type Writer } from "../github/write.ts";
import { issueBody, issueTitle } from "./template.ts";
import { pendingDefects } from "./select.ts";

export const ACTOR = "postmerge-file";

export type FileParams = { repo: string; limit?: number; onHandled?: (n: number) => void };
export type FileDeps = { exec: Exec; now: () => Date };
export type FileSummary = { repo: string; candidates: number; filed: { ref: string; issue: number }[]; limited: number; failed: { ref: string; reason: string }[]; note: string | null };

export const defaultFileDeps = (): FileDeps => ({ exec, now: () => new Date() });

const setFollowup = (db: DatabaseSync, d: { repo: string; number: number; review_at: string; finding: number; title: string }, state: "filed" | "skipped-limit", at: string, issue?: { number: number; url: string }): void => {
  db.prepare(`INSERT OR REPLACE INTO postmerge_followups (repo, number, review_at, finding, title, issue_number, url, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.repo, d.number, d.review_at, d.finding, d.title, issue?.number ?? null, issue?.url ?? null, state, at);
};

/**
 * Files up to `limit` pending defects of the repo, oldest review first. The defects beyond the limit are marked skipped-limit
 * and are filed by a later run. Nothing is filed in a repo without comment approval.
 */
export async function runPostmergeFile(db: DatabaseSync, params: FileParams, log: (line: string) => void = console.log, deps: FileDeps = defaultFileDeps()): Promise<FileSummary> {
  const { repo } = params;
  const s: FileSummary = { repo, candidates: 0, filed: [], limited: 0, failed: [], note: null };
  if (!commentApprovalOf(db, repo)) {
    s.note = `commenting in ${repo} is not approved`;
    log(`postmerge-file ${repo}: ${s.note}; nothing filed`);
    return s;
  }
  const todo = pendingDefects(db, repo);
  s.candidates = todo.length;
  const w: Writer = { db, login: ACTOR };
  let handled = 0;
  for (const d of todo) {
    const ref = `${repo}#${d.number}`;
    if (params.limit !== undefined && handled >= params.limit) {
      setFollowup(db, { ...d, title: d.f.title }, "skipped-limit", deps.now().toISOString());
      s.limited++;
      continue;
    }
    handled++;
    try {
      const made = await createIssue(w, deps.exec, { repo, target: ref, title: issueTitle(d.f.title), body: issueBody({ number: d.number, model: d.model, body: d.f.body, file: d.f.file, line: d.f.line }) },
        { finding: d.finding, severity: d.f.severity });
      setFollowup(db, { ...d, title: d.f.title }, "filed", deps.now().toISOString(), made);
      s.filed.push({ ref, issue: made.number });
      log(`  ${ref}: filed ${made.url}`);
      params.onHandled?.(handled);
    } catch (e) {
      const reason = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
      s.failed.push({ ref, reason });
      log(`  ${ref}: not filed: ${reason}`);
    }
  }
  log(`postmerge-file ${repo}: ${s.filed.length} filed, ${s.limited} over the limit, ${s.failed.length} failed`);
  return s;
}

