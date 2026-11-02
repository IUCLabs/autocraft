// Mirror of every issue and PR of the storytold org into SQLite, via `gh api graphql`.
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { connect } from "./db.ts";
import { trackedNames } from "./repos.ts";

const ORG = "storytold";
const OVERLAP_MS = 10 * 60 * 1000;
const FULL_PAGE = 30;
const LIGHT_PAGE = 100;
const MIN_PAGE = 10;

const COLUMNS = [
  "repo", "number", "kind", "state", "title", "body", "url", "author", "author_association",
  "created_at", "updated_at", "closed_at", "merged_at", "merged_by", "state_reason", "is_draft",
  "labels", "assignees", "comments_count", "additions", "deletions", "changed_files",
  "head_ref", "head_oid", "head_repo", "base_ref", "maintainer_can_modify", "mergeable",
  "review_decision", "ci_state", "closing_issues", "detail_level",
];

type Kind = "issue" | "pr";
type Detail = "full" | "light";
// GraphQL nodes are untyped JSON; fields are read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const REPOS_QUERY = `
query($after: String) {
  rateLimit { cost remaining resetAt }
  organization(login: "${ORG}") {
    repositories(first: 100, after: $after, isArchived: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name visibility defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
        issues(states: OPEN) { totalCount }
      }
    }
  }
}`;

const COMMON = `number title body url author { login } authorAssociation createdAt updatedAt closedAt state
  labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } }
  commentCount: comments { totalCount }`;
const COMMENTS = "comments(last: 20) { nodes { id author { login } createdAt body } }";
const PR_EXTRA = `isDraft mergedAt mergedBy { login } additions deletions changedFiles
  headRefName headRefOid headRepository { nameWithOwner } baseRefName
  closingIssuesReferences(first: 10) { nodes { number } }`;
const PR_FULL = `maintainerCanModify mergeable reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(last: 10) { nodes { id author { login } createdAt body state commit { oid } } }`;

function itemsQuery(kind: Kind, detail: Detail): string {
  const [conn, stateType] = kind === "issue" ? ["issues", "IssueState"] : ["pullRequests", "PullRequestState"];
  let fields = `${COMMON} ${kind === "issue" ? "stateReason" : PR_EXTRA}`;
  if (detail === "full") fields += ` ${COMMENTS}${kind === "pr" ? ` ${PR_FULL}` : ""}`;
  return `
query($name: String!, $first: Int!, $after: String, $states: [${stateType}!]) {
  rateLimit { cost remaining resetAt }
  repository(owner: "${ORG}", name: $name) {
    ${conn}(first: $first, after: $after, states: $states,
            orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`;
}

class Transient extends Error {}

export class Client {
  reserve: number;
  remaining: number | null = null;
  resetAt: Date | null = null;
  spent = 0;

  constructor(reserve: number) {
    this.reserve = reserve;
  }

  private async sleepUntilReset(why: string): Promise<void> {
    const ms = this.resetAt ? Math.max(5_000, this.resetAt.getTime() - Date.now() + 5_000) : 60_000;
    console.log(`  ${why}: sleeping ${Math.round(ms / 1000)}s until rate limit reset`);
    await sleep(ms);
    this.remaining = null;
  }

  private run(query: string, variables: object): { data?: Node; errors: Node[]; text: string; failed: boolean; stderr: string } {
    const p = spawnSync("gh", ["api", "graphql", "--input", "-"], {
      input: JSON.stringify({ query, variables }), encoding: "utf8", timeout: 120_000, maxBuffer: 256 << 20,
    });
    if (p.error) throw new Transient("timeout");
    let json: Node = {};
    try {
      json = JSON.parse(p.stdout);
    } catch {
      // gh prints errors on stderr when there is no JSON body
    }
    const text = `${p.stdout.length < 5000 ? p.stdout : ""}${p.stderr}`.toLowerCase();
    return { data: json.data, errors: json.errors ?? [], text, failed: p.status !== 0, stderr: p.stderr };
  }

  async query(query: string, variables: object): Promise<Node> {
    if (this.remaining !== null && this.remaining < this.reserve) {
      await this.sleepUntilReset(`${this.remaining} points left, reserve ${this.reserve}`);
    }
    const r = this.run(query, variables);
    if (r.text.includes("secondary rate limit") || r.text.includes("abuse")) {
      console.log("  secondary rate limit: sleeping 90s");
      await sleep(90_000);
      throw new Transient("secondary");
    }
    if (r.errors.some((e: Node) => e.type === "RATE_LIMITED") || (r.failed && r.text.includes("rate limit"))) {
      await this.sleepUntilReset("rate limit exhausted");
      throw new Transient("rate limited");
    }
    if (r.errors.length && !r.data?.repository && !r.data?.organization) {
      if (/node_limit|resource_limits|timeout|something went wrong/.test(r.text)) throw new Transient("query too heavy");
      throw new Error(`graphql error: ${JSON.stringify(r.errors).slice(0, 500)}`);
    }
    if (r.failed) {
      if (/502|503|504|timeout|eof|connection|unexpected end of json/.test(r.text)) throw new Transient(r.stderr.trim().slice(0, 200));
      throw new Error(`gh failed: ${r.stderr.trim().slice(0, 500)}`);
    }
    const rl = r.data.rateLimit;
    this.remaining = rl.remaining;
    this.spent += rl.cost;
    this.resetAt = new Date(rl.resetAt);
    return r.data;
  }
}

// Newest first, lazily: stopping early saves requests. Halves the page size on transient errors.
async function* fetchPages(client: Client, kind: Kind, detail: Detail, name: string, states: string[]): AsyncGenerator<Node[]> {
  const query = itemsQuery(kind, detail);
  let size = detail === "full" ? FULL_PAGE : LIGHT_PAGE;
  let cursor: string | null = null;
  let failures = 0;
  for (;;) {
    let data: Node;
    try {
      data = await client.query(query, { name, first: size, after: cursor, states });
    } catch (e) {
      if (!(e instanceof Transient)) throw e;
      if (size > MIN_PAGE) {
        size = Math.max(MIN_PAGE, size >> 1);
        console.log(`  ${e.message}: page size ${size}`);
      } else if (++failures > 6) {
        throw e;
      } else {
        await sleep(Math.min(30_000 * failures, 300_000));
      }
      continue;
    }
    failures = 0;
    const conn: Node = data.repository[kind === "issue" ? "issues" : "pullRequests"];
    yield conn.nodes;
    if (!conn.pageInfo.hasNextPage) return;
    cursor = conn.pageInfo.endCursor;
  }
}

// Passes pages through, dropping items updated before cutoff and ending at the first such item.
export async function* untilCutoff(pages: AsyncIterable<Node[]>, cutoff: string | null): AsyncGenerator<Node[]> {
  for await (const page of pages) {
    const keep = page.filter((n) => cutoff === null || n.updatedAt >= cutoff);
    if (keep.length) yield keep;
    if (keep.length < page.length) return;
  }
}

const login = (n: Node): string | null => n?.login ?? null;

function toRow(repo: string, kind: Kind, n: Node, detail: Detail): Record<string, SQLInputValue> {
  const r: Record<string, SQLInputValue> = Object.fromEntries(COLUMNS.map((c) => [c, null]));
  Object.assign(r, {
    repo, number: n.number, kind, state: n.state, title: n.title, body: n.body, url: n.url,
    author: login(n.author), author_association: n.authorAssociation,
    created_at: n.createdAt, updated_at: n.updatedAt, closed_at: n.closedAt,
    labels: JSON.stringify(n.labels.nodes.map((x: Node) => x.name)),
    assignees: JSON.stringify(n.assignees.nodes.map((x: Node) => x.login)),
    comments_count: n.commentCount.totalCount, detail_level: detail,
  });
  if (kind === "issue") {
    r.state_reason = n.stateReason;
    return r;
  }
  Object.assign(r, {
    is_draft: Number(n.isDraft), merged_at: n.mergedAt, merged_by: login(n.mergedBy),
    additions: n.additions, deletions: n.deletions, changed_files: n.changedFiles,
    head_ref: n.headRefName, head_oid: n.headRefOid, head_repo: n.headRepository?.nameWithOwner ?? null,
    base_ref: n.baseRefName,
    closing_issues: JSON.stringify(n.closingIssuesReferences.nodes.map((x: Node) => x.number)),
  });
  if (detail === "full") {
    Object.assign(r, {
      maintainer_can_modify: Number(n.maintainerCanModify), mergeable: n.mergeable,
      review_decision: n.reviewDecision, ci_state: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    });
  }
  return r;
}

function commentRows(repo: string, kind: Kind, n: Node): SQLInputValue[][] {
  const rows = n.comments.nodes.map((c: Node) =>
    [repo, n.number, c.id, "comment", login(c.author), c.createdAt, c.body, null, null]);
  if (kind === "pr") {
    for (const c of n.reviews.nodes) {
      if (c.body) rows.push([repo, n.number, c.id, "review", login(c.author), c.createdAt, c.body, c.state, c.commit?.oid ?? null]);
    }
  }
  return rows;
}

function writePage(db: DatabaseSync, repo: string, kind: Kind, detail: Detail, nodes: Node[]): void {
  const insert = db.prepare(`INSERT OR REPLACE INTO items (${COLUMNS.join(",")}) VALUES (${COLUMNS.map((c) => `:${c}`).join(",")})`);
  const del = db.prepare("DELETE FROM comments WHERE repo=? AND number=?");
  const insComment = db.prepare("INSERT OR REPLACE INTO comments VALUES (?,?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    for (const n of nodes) {
      insert.run(toRow(repo, kind, n, detail));
      if (detail === "full") {
        del.run(repo, n.number);
        for (const row of commentRows(repo, kind, n)) insComment.run(...row);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

async function listRepos(client: Client): Promise<Node[]> {
  const repos: Node[] = [];
  let after: string | null = null;
  for (;;) {
    const conn: Node = (await client.query(REPOS_QUERY, { after })).organization.repositories;
    repos.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return repos;
    after = conn.pageInfo.endCursor;
  }
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

// high_water is written only when the whole repo finished, so a crash leaves the repo incomplete.
async function syncRepo(db: DatabaseSync, client: Client, name: string, full: boolean): Promise<number> {
  const row = db.prepare("SELECT high_water FROM repos WHERE name=?").get(name) as { high_water: string | null } | undefined;
  const high = row?.high_water ?? null;
  const cutoff = high && !full ? iso(new Date(new Date(high).getTime() - OVERLAP_MS)) : null;
  let newest = high ?? "";
  let count = 0;
  for (const kind of ["issue", "pr"] as const) {
    const passes: [Detail, string[]][] = [["full", ["OPEN"]], ["light", kind === "issue" ? ["CLOSED"] : ["CLOSED", "MERGED"]]];
    for (const [detail, states] of passes) {
      for await (const nodes of untilCutoff(fetchPages(client, kind, detail, name, states), cutoff)) {
        writePage(db, name, kind, detail, nodes);
        count += nodes.length;
        for (const n of nodes) if (n.updatedAt > newest) newest = n.updatedAt;
      }
    }
  }
  db.prepare("UPDATE repos SET synced_at=?, high_water=? WHERE name=?").run(iso(new Date()), newest || null, name);
  return count;
}

// Which repos get their items synced: --repo names (any repo), else every repo
// with --all, else the tracked ones. `listed` is every non-archived org repo.
export function selectSyncRepos(listed: string[], tracked: string[], opts: { only: string[]; all: boolean }): string[] {
  if (opts.only.length) {
    const missing = opts.only.filter((n) => !listed.includes(n));
    if (missing.length) throw new Error(`unknown or archived repos: ${missing.join(", ")}`);
    return listed.filter((n) => opts.only.includes(n));
  }
  return opts.all ? listed : listed.filter((n) => tracked.includes(n));
}

async function sync(args: string[]): Promise<void> {
  const only: string[] = [];
  let full = false;
  let all = false;
  let reserve = 1000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") only.push(args[++i]);
    else if (args[i] === "--full") full = true;
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--reserve") reserve = Number(args[++i]);
    else throw new Error(`unknown argument ${args[i]}\nusage: sync [--repo NAME ...] [--all] [--full] [--reserve N]`);
  }
  const db = connect();
  const client = new Client(reserve);
  const repos = await listRepos(client);
  const upsert = db.prepare(`INSERT INTO repos (name, visibility, default_branch, open_prs, open_issues) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET visibility=excluded.visibility, default_branch=excluded.default_branch,
    open_prs=excluded.open_prs, open_issues=excluded.open_issues`);
  for (const r of repos) {
    upsert.run(r.name, r.visibility.toLowerCase(), r.defaultBranchRef?.name ?? null, r.pullRequests.totalCount, r.issues.totalCount);
  }
  const tracked = trackedNames(db);
  const listed = repos.map((r: Node) => r.name as string);
  const names = selectSyncRepos(listed, tracked, { only, all });
  const gone = only.length || all ? [] : tracked.filter((n) => !listed.includes(n));
  if (gone.length) console.log(`tracked but not in the org (archived or renamed): ${gone.join(", ")}`);
  for (const name of names) {
    const before = client.spent;
    const count = await syncRepo(db, client, name, full);
    console.log(`${name}: ${count} items, ${client.spent - before} points used, ${client.remaining} left`);
  }
}

function syncStatus(): void {
  const rows = connect().prepare(`
    SELECT r.name, r.open_prs, r.open_issues, r.synced_at,
           EXISTS (SELECT 1 FROM tracked_repos t WHERE t.name = r.name) AS tracked,
           (SELECT COUNT(*) FROM items i WHERE i.repo = r.name) AS n
    FROM repos r ORDER BY r.name`).all() as Node[];
  console.log(`${"repo".padEnd(28)} ${"tracked".padEnd(7)} ${"open PRs".padStart(8)} ${"open iss".padStart(8)} ${"mirrored".padStart(8)}  synced_at`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} ${(r.tracked ? "yes" : "-").padEnd(7)} ${String(r.open_prs).padStart(8)} ${String(r.open_issues).padStart(8)} ${String(r.n).padStart(8)}  ${r.synced_at ?? "-"}`);
  }
}

export const commands = {
  sync: { summary: "mirror issues and PRs of the storytold org: [--repo NAME ...] [--all] [--full] [--reserve N]", run: sync },
  "sync-status": { summary: "per repo: open PRs, open issues, mirrored rows, synced_at", run: syncStatus },
};
