// What AutoCraft is doing about a red default branch, in words for the Main CI page. Read-only.
import type { DatabaseSync } from "node:sqlite";
import { mainFixApprovalOf } from "./approval.ts";

/** Shown first when a head has rows in several states: what needs a person comes before what is running. */
const ORDER = ["needs-fix", "asked", "rerun-requested", "issue-opened", "declined", "nothing-to-do", "rerun-passed"] as const;

const TEXT: Record<(typeof ORDER)[number], string> = {
  "needs-fix": "needs a fix",
  asked: "asked an operator",
  "rerun-requested": "rerunning failed jobs",
  "issue-opened": "opened an issue",
  declined: "nothing to do: infra",
  "nothing-to-do": "nothing to do",
  "rerun-passed": "rerun passed",
};

/** Null when the repo has no approval and nothing was done at this head. */
export function autocraftText(db: DatabaseSync, repo: string, headSha: string, state: string): string | null {
  const states = new Set((db.prepare("SELECT state FROM main_fixes WHERE repo = ? AND head_sha = ?").all(repo, headSha) as { state: string }[]).map((r) => r.state));
  const first = ORDER.find((s) => states.has(s));
  if (first) return TEXT[first];
  return state === "red" && mainFixApprovalOf(db, repo) ? "reading the failure" : null;
}
