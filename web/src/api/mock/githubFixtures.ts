import type { GithubActivityFilter, GithubActivityPage, GithubActivityRow } from "../types";
import { NOW } from "./fixtures";

const ACTIONS = [
  { action: "labels-apply", label: "Labelled" }, { action: "act-comment", label: "Commented" }, { action: "act-close", label: "Closed" },
  { action: "merge", label: "Merged" }, { action: "fixup-push", label: "Pushed" }, { action: "assign", label: "Assigned" },
];

const ROWS: GithubActivityRow[] = Array.from({ length: 120 }, (_, i) => {
  const a = ACTIONS[i % ACTIONS.length]!;
  const repo = i % 3 === 0 ? "designcraft" : "craft-libs";
  const number = 100 + i;
  return {
    id: String(1000 - i), at: new Date(NOW - i * 37 * 60_000).toISOString(), action: a.action, label: a.label, repo, number, branch: null,
    title: `Fix the thing in module ${number}`,
    detail: a.action === "labels-apply" ? "bugfix, size-S" : a.action === "act-comment" ? "Closing as a duplicate of an earlier report." : a.action === "merge" ? "squash 3f9a2c1" : "",
    url: `https://github.com/storytold/${repo}/pull/${number}`, source: a.action === "labels-apply" ? "kiri-n" : `act act-${repo}-20261102`, error: i === 5 ? "gh failed: HTTP 502" : null,
  };
});

export function githubActivityPage(f: GithubActivityFilter): GithubActivityPage {
  const match = ROWS.filter((r) => (!f.repo || r.repo === f.repo) && (!f.action || r.action === f.action) && (!f.after || Number(r.id) < Number(f.after)));
  const limit = f.limit ?? 50;
  const rows = match.slice(0, limit);
  return { rows, total: ROWS.filter((r) => (!f.repo || r.repo === f.repo) && (!f.action || r.action === f.action)).length, next: match.length > limit ? rows[rows.length - 1]!.id : null, actions: ACTIONS };
}
