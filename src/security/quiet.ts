// The quiet pull request of a security fix: opened by the Land step, in the pipeline's name, and kept free of anything that
// names the problem from the moment it opens until the advisory is published. One definition for every place that asks.
import type { DatabaseSync } from "node:sqlite";

/** SQL condition: the findings whose pull request is quiet (the quiet route has no fork). */
export const QUIET_FINDING_SQL = "state IN ('landing', 'landed') AND fork IS NULL AND fix_pr IS NOT NULL";

/** SQL condition on item expressions `repo` and `number`: the item is a quiet pull request. */
export const quietSqlFor = (repo: string, number: string): string =>
  `EXISTS (SELECT 1 FROM main.security_findings qf WHERE qf.repo = ${repo} AND qf.fix_pr = ${number} AND qf.state IN ('landing', 'landed') AND qf.fork IS NULL)`;

/** Quiet pull requests as `repo#number`. */
export function quietFixPrs(db: DatabaseSync, repo?: string): Set<string> {
  const rows = db.prepare(`SELECT repo, fix_pr AS n FROM main.security_findings WHERE ${QUIET_FINDING_SQL}${repo ? " AND repo = ?" : ""}`).all(...(repo ? [repo] : [])) as { repo: string; n: number }[];
  return new Set(rows.map((r) => `${r.repo}#${r.n}`));
}

/** True when `repo#number` is a quiet pull request. */
export const isQuiet = (db: DatabaseSync, repo: string, number: number): boolean =>
  !!db.prepare(`SELECT 1 FROM main.security_findings WHERE repo = ? AND fix_pr = ? AND ${QUIET_FINDING_SQL} LIMIT 1`).get(repo, number);
