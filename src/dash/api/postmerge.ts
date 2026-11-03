// The post-merge review of a merged PR as the item page shows it.
import type { DatabaseSync } from "node:sqlite";
import type { ItemPostmerge, PostmergeFiling, PostmergeFinding } from "../../../web/src/api/types.ts";
import { followupsOf, reviewOf } from "../../postmerge/select.ts";
import { itemState } from "./decisions.ts";

/** `staff`: operators and maintainers, who also read which stage missed a finding and why. */
export function postmergeOf(db: DatabaseSync, repo: string, n: number, staff: boolean): ItemPostmerge | null {
  const r = reviewOf(db, repo, n);
  if (!r) return null;
  const follow = followupsOf(db, repo, n).filter((f) => f.review_at === r.at);
  const issueOf = db.prepare("SELECT state, title FROM items WHERE repo = ? AND number = ?");
  const findings = r.findings.map((f, i): PostmergeFinding => {
    const row = follow.find((x) => x.finding === i);
    let filing: PostmergeFiling;
    if (row?.state === "filed" && row.issue_number !== null) {
      const it = issueOf.get(repo, row.issue_number) as { state: string; title: string | null } | undefined;
      filing = { state: "filed", issue: { number: row.issue_number, url: row.url, state: it ? itemState(it.state) : null, title: it?.title ?? row.title } };
    } else if (f.severity === "minor") filing = { state: "minor" };
    else if (f.duplicate_of !== null) filing = { state: "duplicate", duplicateOf: f.duplicate_of };
    else filing = row?.state === "skipped-limit" ? { state: "limit" } : { state: "pending" };
    return {
      severity: f.severity, title: f.title, body: f.body, file: f.file, line: f.line, filing,
      ...(staff ? { missedBy: f.missed_by || null, missedWhy: f.missed_why || null } : {}),
    };
  });
  return { at: r.at, model: r.model, mergeSha: r.merge_sha, error: r.error ? r.error.replace(/^(retry|held):\s*/, "") : null, findings };
}
