// CI and merge state of PR heads: one GraphQL query per chunk of PRs, stored in pr_checks.
import type { DatabaseSync } from "node:sqlite";
import type { Querier } from "../mirror.ts";

const ORG = "storytold";
/** PRs per query: 100 check contexts each keeps a query well under GitHub's node limit. */
export const CHECKS_PER_QUERY = 40;

export type CheckState = "success" | "failure" | "pending" | "skipped";
export type Overall = "success" | "failure" | "pending" | "none";

export type PrChecks = {
  repo: string; number: number; head_oid: string; state: string; is_draft: boolean;
  overall: Overall; checks: { name: string; state: CheckState }[];
  mergeable: string | null; maintainer_can_modify: boolean;
};

export function checksQuery(numbers: number[]): string {
  const prs = numbers.map((n) => `
    pr${n}: pullRequest(number: ${n}) {
      number state isDraft headRefOid mergeable maintainerCanModify
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } } } } } }
    }`).join("");
  return `query($name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: "${ORG}", name: $name) {${prs}
  }
}`;
}

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string };

export function contextState(c: Ctx): CheckState {
  if (c.__typename === "StatusContext") {
    const s = c.state ?? "";
    return s === "SUCCESS" ? "success" : s === "FAILURE" || s === "ERROR" ? "failure" : "pending";
  }
  if (c.status !== "COMPLETED") return "pending";
  switch (c.conclusion) {
    case "SUCCESS": return "success";
    case "NEUTRAL": case "SKIPPED": return "skipped";
    default: return "failure"; // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
}

export function overallOf(states: CheckState[]): Overall {
  if (!states.length) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return states.includes("success") ? "success" : "none";
}

type PrNode = {
  number: number; state: string; isDraft: boolean; headRefOid: string; mergeable: string | null; maintainerCanModify: boolean;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: Ctx[] } } | null } }[] };
};

/** Parses the repository object of a checks query; PRs that GitHub returned as null are left out. */
export function parseChecks(repo: string, repository: Record<string, PrNode | null>): PrChecks[] {
  const out: PrChecks[] = [];
  for (const node of Object.values(repository ?? {})) {
    if (!node || typeof node.number !== "number") continue;
    const ctx = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = ctx.filter(Boolean).map((c) => ({ name: c.name ?? c.context ?? "?", state: contextState(c) }));
    out.push({
      repo, number: node.number, head_oid: node.headRefOid, state: node.state, is_draft: !!node.isDraft,
      overall: overallOf(checks.map((c) => c.state)), checks,
      mergeable: node.mergeable ?? null, maintainer_can_modify: !!node.maintainerCanModify,
    });
  }
  return out;
}

export function saveChecks(db: DatabaseSync, rows: PrChecks[], at = new Date().toISOString()): void {
  const ins = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET head_oid = excluded.head_oid, state = excluded.state, is_draft = excluded.is_draft, overall = excluded.overall,
      checks = excluded.checks, mergeable = excluded.mergeable, maintainer_can_modify = excluded.maintainer_can_modify, fetched_at = excluded.fetched_at`);
  for (const r of rows)
    ins.run(r.repo, r.number, r.head_oid, r.state, r.is_draft ? 1 : 0, r.overall, JSON.stringify(r.checks), r.mergeable, r.maintainer_can_modify ? 1 : 0, at);
}

/** Fetches and stores the checks of the given PRs (all open PRs of the repo when none are given). */
export async function refreshChecks(db: DatabaseSync, client: Querier, repo: string, numbers?: number[], log: (line: string) => void = () => {}): Promise<PrChecks[]> {
  const list = numbers ?? (db.prepare("SELECT number FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN' ORDER BY number").all(repo) as { number: number }[]).map((r) => r.number);
  const all: PrChecks[] = [];
  for (let i = 0; i < list.length; i += CHECKS_PER_QUERY) {
    const chunk = list.slice(i, i + CHECKS_PER_QUERY);
    const data = await client.query(checksQuery(chunk), { name: repo });
    const rows = parseChecks(repo, (data as { repository: Record<string, PrNode | null> }).repository);
    saveChecks(db, rows);
    all.push(...rows);
  }
  log(`checks: ${repo}: ${all.length} PRs (${(["success", "failure", "pending", "none"] as const).map((o) => `${all.filter((r) => r.overall === o).length} ${o}`).join(", ")})`);
  return all;
}

export function checksOf(db: DatabaseSync, repo: string, number: number): { head_oid: string; overall: Overall; mergeable: string | null; maintainer_can_modify: number } | undefined {
  return db.prepare("SELECT head_oid, overall, mergeable, maintainer_can_modify FROM pr_checks WHERE repo = ? AND number = ?").get(repo, number) as never;
}
