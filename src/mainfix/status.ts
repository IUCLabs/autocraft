// What AutoCraft is doing about a red default branch, in words for the Main CI page. Read-only.
import type { DatabaseSync } from "node:sqlite";
import { mainFixApprovalOf } from "./approval.ts";

/** Shown first when a head has rows in several states: what needs a person comes before what is running. */
const ORDER = ["fix-failed", "needs-fix", "linting", "asked", "pr-opened", "rerun-requested", "issue-opened", "declined", "nothing-to-do", "rerun-passed"] as const;

const TEXT: Record<(typeof ORDER)[number], string> = {
  "fix-failed": "needs a person",
  "pr-opened": "opened fix PR",
  "needs-fix": "needs a fix",
  linting: "checking a fix",
  asked: "asked an operator",
  "rerun-requested": "rerunning failed jobs",
  "issue-opened": "opened an issue",
  declined: "nothing to do: infra",
  "nothing-to-do": "nothing to do",
  "rerun-passed": "rerun passed",
};

type FixRow = { state: string; pr_number: number | null };

/** Null when the repo has no approval and nothing was done at this head. */
export function autocraftText(db: DatabaseSync, repo: string, headSha: string, state: string): string | null {
  return textOf(db.prepare("SELECT state, pr_number FROM main_fixes WHERE repo = ? AND head_sha = ?").all(repo, headSha) as FixRow[], () => !!mainFixApprovalOf(db, repo), state);
}

/** autocraftText() for many heads, with the main_fixes rows read once. */
export function autocraftTexts(db: DatabaseSync): (repo: string, headSha: string, state: string) => string | null {
  const rows = new Map<string, FixRow[]>();
  for (const r of db.prepare("SELECT repo, head_sha, state, pr_number FROM main_fixes").all() as (FixRow & { repo: string; head_sha: string })[]) {
    const k = `${r.repo}@${r.head_sha}`;
    (rows.get(k) ?? rows.set(k, []).get(k)!).push(r);
  }
  return (repo, headSha, state) => textOf(rows.get(`${repo}@${headSha}`) ?? [], () => !!mainFixApprovalOf(db, repo), state);
}

function textOf(rows: FixRow[], approved: () => boolean, state: string): string | null {
  const states = new Set(rows.map((r) => r.state));
  const first = ORDER.find((s) => states.has(s));
  if (first === "pr-opened") {
    const ns = rows.filter((r) => r.state === "pr-opened" && r.pr_number !== null).map((r) => r.pr_number!);
    const n = ns.length ? Math.min(...ns) : undefined;
    return n ? `${TEXT[first]} #${n}` : TEXT[first];
  }
  if (first) return TEXT[first];
  return state === "red" && approved() ? "reading the failure" : null;
}
