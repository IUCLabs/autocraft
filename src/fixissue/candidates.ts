// Which open issues the Fix stage works on, from the local tables only.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { notHeldSql } from "../dupes/held.ts";
import { levelWith, type Level } from "../priority/score.ts";
import { fixIssueApprovalOf } from "./approval.ts";

export const ATTEMPT_STATES = ["retry", "testing", "passed", "pr-opened", "skipped", "failed"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export type IssueCandidate = { repo: string; number: number; title: string; body: string; hash: string; score: number | null };

/** Setting that marks a repo without a Rust workspace at its root, set by the step when it finds out. */
export const notRustKey = (repo: string): string => `fixissue_not_rust:${repo}`;

export const textHash = (title: string, body: string): string => createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 16);

type Row = { number: number; title: string | null; body: string | null; score: number | null; level: Level | null };

/** Whether an open PR in the repo closes issue `n` or mentions it by number. */
function hasOpenPr(db: DatabaseSync, repo: string, n: number): boolean {
  const prs = db.prepare("SELECT body, title, closing_issues FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN'").all(repo) as { body: string | null; title: string | null; closing_issues: string | null }[];
  const ref = new RegExp(`(^|[^\\w/])#${n}(?!\\d)`);
  for (const p of prs) {
    try {
      if ((JSON.parse(p.closing_issues ?? "[]") as unknown[]).includes(n)) return true;
    } catch { /* fall through to the text */ }
    if (ref.test(`${p.title ?? ""}\n${p.body ?? ""}`)) return true;
  }
  return false;
}

/**
 * Open issues with a settled bugfix label, no pending scope decision (or one answered `take` by an operator),
 * no open PR that mentions or closes them and no attempt (a skipped one returns when its text changed), in a
 * repo with fix-issue approval, and not at level P4 (backlog). Highest work rank first.
 */
export function selectIssues(db: DatabaseSync, repo: string, run: string | null = latestRun(db)): IssueCandidate[] {
  if (!fixIssueApprovalOf(db, repo)) return [];
  if (!db.prepare("SELECT 1 FROM repos WHERE name = ? AND visibility = 'public'").get(repo)) return [];
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(notRustKey(repo))) return [];
  const rows = db.prepare(`SELECT i.number, i.title, i.body, p.score, q.impact AS level FROM items i LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    LEFT JOIN item_priority q ON q.repo = i.repo AND q.number = i.number
    WHERE i.repo = ? AND i.kind = 'issue' AND i.state = 'OPEN' AND ${notHeldSql("i")} ORDER BY p.score IS NULL, p.score DESC, i.number`).all(repo) as Row[];
  const settled = settledLookup(db, run);
  const attempt = db.prepare("SELECT state, text_hash FROM fix_attempts WHERE repo = ? AND number = ?");
  const scope = db.prepare(`SELECT answer, answered_by FROM decisions WHERE kind = 'scope' AND repo = ? AND number = ? ORDER BY asked_at DESC LIMIT 1`);
  const isOperator = db.prepare("SELECT 1 FROM access WHERE login = ? AND role = 'operator'");
  const out: IssueCandidate[] = [];
  for (const r of rows) {
    const s = settled(repo, r.number);
    if (s.status !== "settled" || s.label !== "bugfix") continue;
    if (r.level && levelWith(r.level, s.flags.includes("security")) === "P4") continue; // backlog: no code is written for it
    const hash = textHash(r.title ?? "", r.body ?? "");
    const a = attempt.get(repo, r.number) as { state: string; text_hash: string } | undefined;
    if (a && (a.state !== "skipped" || a.text_hash === hash)) continue;
    const d = scope.get(repo, r.number) as { answer: string | null; answered_by: string | null } | undefined;
    const take = !!d && d.answer === "take" && !!d.answered_by && !!isOperator.get(d.answered_by);
    if (d && !take) continue;
    if (!d && s.flags.includes("needs decision")) continue;
    if (hasOpenPr(db, repo, r.number)) continue;
    out.push({ repo, number: r.number, title: r.title ?? "", body: r.body ?? "", hash, score: r.score });
  }
  return out;
}
