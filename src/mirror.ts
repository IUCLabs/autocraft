// Mirror of every issue and PR of the storytold org into SQLite, via `gh api graphql`.
import { refreshSnapshot } from "./itemtools/snapshot.ts";
import { isCounted } from "./review/discussion.ts";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { connect, dbPath } from "./db.ts";
import { trackedNames } from "./repos.ts";
import { audit } from "./dash/audit.ts";
import { hashColumns } from "./itemhash.ts";

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
  "review_decision", "ci_state", "closing_issues", "detail_level", "embed_hash", "class_hash", "class_scheme",
];

type Kind = "issue" | "pr";
type Detail = "full" | "light";
// GraphQL nodes are untyped JSON; fields are read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const REPOS_QUERY = `
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

export const COMMON = `number title body url author { login } authorAssociation createdAt updatedAt closedAt state
  labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } }
  commentCount: comments { totalCount }`;
export const COMMENTS = "comments(last: 20) { nodes { id author { login __typename } authorAssociation createdAt body } }";
export const PR_EXTRA = `isDraft mergedAt mergedBy { login } additions deletions changedFiles
  headRefName headRefOid headRepository { nameWithOwner } baseRefName
  closingIssuesReferences(first: 10) { nodes { number } }`;
export const PR_FULL = `maintainerCanModify mergeable reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(last: 10) { nodes { id author { login __typename } authorAssociation createdAt body state commit { oid } comments { totalCount } } }`;

export function itemsQuery(kind: Kind, detail: Detail): string {
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

export class Transient extends Error {}

export class Client {
  reserve: number;
  remaining: number | null = null;
  resetAt: Date | null = null;
  spent = 0;

  constructor(reserve: number) {
    this.reserve = reserve;
  }

  async sleepUntilReset(why: string): Promise<void> {
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
    if (r.errors.length && !r.data?.repository && !r.data?.organization && !r.data?.search) {
      if (/node_limit|resource_limits|timeout|something went wrong/.test(r.text)) throw new Transient("query too heavy");
      throw new Error(`graphql error: ${JSON.stringify(r.errors).slice(0, 500)}`);
    }
    if (r.failed) {
      if (/502|503|504|timeout|eof|connection|unexpected end of json/.test(r.text)) throw new Transient(r.stderr.trim().slice(0, 200));
      throw new Error(`gh failed: ${r.stderr.trim().slice(0, 500)}`);
    }
    const rl = r.data.rateLimit; // absent in mutation responses
    if (rl) {
      this.remaining = rl.remaining;
      this.spent += rl.cost;
      this.resetAt = new Date(rl.resetAt);
    }
    return r.data;
  }
}

// Newest first, lazily: stopping early saves requests. Halves the page size on transient errors.
async function* fetchPages(client: Querier, kind: Kind, detail: Detail, name: string, states: string[]): AsyncGenerator<Node[]> {
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
  const r = baseRow(repo, kind, n, detail);
  return Object.assign(r, hashColumns(r as Parameters<typeof hashColumns>[0]));
}

function baseRow(repo: string, kind: Kind, n: Node, detail: Detail): Record<string, SQLInputValue> {
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
  // `counted`: whether the entry counts as new discussion for the review stage (src/review/discussion.ts).
  const counted = (c: Node) => Number(isCounted({ author: login(c.author), association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor: login(n.author), state: c.state, body: c.body, inline: c.comments?.totalCount }));
  const rows = n.comments.nodes.map((c: Node) =>
    [repo, n.number, c.id, "comment", login(c.author), c.createdAt, c.body, null, null, counted(c)]);
  if (kind === "pr") {
    for (const c of n.reviews.nodes) {
      // A review without a body still counts: its inline threads are the discussion, and it makes earlier reviews stale.
      rows.push([repo, n.number, c.id, "review", login(c.author), c.createdAt, c.body, c.state, c.commit?.oid ?? null, counted(c)]);
    }
  }
  return rows;
}

function writePage(db: DatabaseSync, repo: string, kind: Kind, detail: Detail, nodes: Node[]): void {
  // Upserts keep each row's rowid, which the full-text index (schema.sql) is keyed on.
  const insert = db.prepare(`INSERT INTO items (${COLUMNS.join(",")}) VALUES (${COLUMNS.map((c) => `:${c}`).join(",")})
    ON CONFLICT (repo, number) DO UPDATE SET ${COLUMNS.filter((c) => c !== "repo" && c !== "number").map((c) => `${c}=excluded.${c}`).join(",")}`);
  const stored = db.prepare(`SELECT ${COLUMNS.join(",")} FROM items WHERE repo=? AND number=?`);
  const del = db.prepare("DELETE FROM comments WHERE repo=? AND number=?");
  const insComment = db.prepare(`INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET
    repo=excluded.repo, number=excluded.number, kind=excluded.kind, author=excluded.author, created_at=excluded.created_at,
    body=excluded.body, review_state=excluded.review_state, commit_oid=excluded.commit_oid, counted=excluded.counted`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const n of nodes) {
      const row = toRow(repo, kind, n, detail);
      // A row identical to the stored one (overlapping reads re-fetch many) writes nothing.
      const old = stored.get(repo, n.number) as Record<string, SQLInputValue> | undefined;
      if (old && COLUMNS.every((c) => old[c] === row[c])) continue;
      insert.run(row);
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

async function listRepos(client: Querier): Promise<Node[]> {
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

// Reads a repo's items, newest first, down to `cutoff` (everything when null). Moves no high water.
async function readRepoSince(db: DatabaseSync, client: Querier, name: string, cutoff: string | null): Promise<{ count: number; newest: string }> {
  let newest = "";
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
  return { count, newest };
}

// high_water is written only when the whole repo finished, so a crash leaves the repo incomplete.
async function syncRepo(db: DatabaseSync, client: Querier, name: string, full: boolean): Promise<number> {
  const row = db.prepare("SELECT high_water FROM repos WHERE name=?").get(name) as { high_water: string | null } | undefined;
  const high = row?.high_water ?? null;
  const cutoff = high && !full ? iso(new Date(new Date(high).getTime() - OVERLAP_MS)) : null;
  const read = await readRepoSince(db, client, name, cutoff);
  const count = read.count;
  const newest = read.newest > (high ?? "") ? read.newest : (high ?? "");
  // max(): an incremental sync may have moved the high water further while a full pass ran.
  db.prepare(`UPDATE repos SET synced_at=:at, high_water=CASE WHEN :hw IS NOT NULL AND (high_water IS NULL OR high_water < :hw) THEN :hw ELSE high_water END
    WHERE name=:name`).run({ at: iso(new Date()), hw: newest || null, name });
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

// GitHub's search index can lag several minutes, so every search starts 10 minutes before the high
// water, and once an hour it also re-reads the 6 hours before it.
const SEARCH_OVERLAP_MS = 10 * 60 * 1000;
const CATCHUP_EVERY_MS = 60 * 60 * 1000;
const CATCHUP_SPAN_MS = 6 * 60 * 60 * 1000;
// Each tracked repo's open items are listed and reconciled with the mirror once a day.
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE = 20;
const SEARCH_CAP = 1000;
// Rate-limit points a full re-sync leaves for the minute sync.
const FULL_KEEP = 2500;
const META_REFRESH_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 6 * 3600 * 1000;

export const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { repository { name } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

// The index lags, so each query starts before the newest updatedAt stored.
export function searchSince(orgHighWater: string): string {
  return iso(new Date(new Date(orgHighWater).getTime() - SEARCH_OVERLAP_MS));
}

export type Querier = { query(query: string, variables: object): Promise<Node>; spent: number; remaining: number | null };

const getSetting = (db: DatabaseSync, key: string): string | null =>
  ((db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value) ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};

// Search returns at most SEARCH_CAP results per query. A window with more matches is cut in half
// (`updated:A..B` is inclusive, in whole seconds) until every slice fits. A one-second slice with
// more matches than the cap cannot be read by search; the tracked repos are listed for that
// second instead.
export type SearchResult = { count: number; newest: string | null; slices: number; fallbacks: number };

// Everything updated from `since` to `until`, oldest slice first. `newest` is the largest updatedAt
// returned (tracked repos or not), the next sync's starting point; null when nothing matched.
export async function syncBySearch(db: DatabaseSync, client: Querier, tracked: string[], since: string, until: string): Promise<SearchResult> {
  const trackedSet = new Set(tracked);
  const bump = db.prepare("UPDATE repos SET high_water=? WHERE name=? AND (high_water IS NULL OR high_water < ?)");
  // Applied once every window has been read, so a failed run leaves the repos' high water alone.
  const repoNewest = new Map<string, string>();
  let size = SEARCH_PAGE;
  let failures = 0;
  const out: SearchResult = { count: 0, newest: null, slices: 0, fallbacks: 0 };

  async function page(q: string, cursor: string | null): Promise<Node> {
    for (;;) {
      try {
        return (await client.query(SEARCH_QUERY, { q, first: size, after: cursor })).search;
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        if (size > MIN_PAGE) size = Math.max(MIN_PAGE, size >> 1);
        else if (++failures > 6) throw e;
        else await sleep(Math.min(30_000 * failures, 300_000));
      }
    }
  }

  function write(nodes: Node[]): void {
    const groups = new Map<string, Node[]>();
    for (const n of nodes) {
      if (n?.updatedAt && n.updatedAt > (out.newest ?? "")) out.newest = n.updatedAt;
      // Untracked repos are dropped here, before anything else is done with the node.
      if (!n?.repository || !trackedSet.has(n.repository.name)) continue;
      const kind: Kind = n.__typename === "PullRequest" ? "pr" : "issue";
      const detail: Detail = n.state === "OPEN" ? "full" : "light";
      const key = `${n.repository.name}\t${kind}\t${detail}`;
      groups.set(key, [...(groups.get(key) ?? []), n]);
      if (n.updatedAt > (repoNewest.get(n.repository.name) ?? "")) repoNewest.set(n.repository.name, n.updatedAt);
    }
    for (const [key, group] of groups) {
      const [repo, kind, detail] = key.split("\t");
      writePage(db, repo, kind as Kind, detail as Detail, group);
      out.count += group.length;
    }
  }

  async function window(from: Date, to: Date): Promise<void> {
    const q = `org:${ORG} updated:${iso(from)}..${iso(to)}`;
    let conn = await page(q, null);
    const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
    if (conn.issueCount > SEARCH_CAP && seconds >= 1) {
      const mid = new Date(from.getTime() + Math.floor(seconds / 2) * 1000);
      await window(from, mid);
      await window(new Date(mid.getTime() + 1000), to);
      return;
    }
    if (conn.issueCount > SEARCH_CAP) {
      console.warn(`  warning: ${conn.issueCount} items updated in ${iso(from)}, more than search returns: listing the tracked repos for it`);
      out.fallbacks++;
      for (const name of tracked) {
        const r = await readRepoSince(db, client, name, iso(from));
        out.count += r.count;
        if (r.newest > (repoNewest.get(name) ?? "")) repoNewest.set(name, r.newest);
        if (r.newest > (out.newest ?? "")) out.newest = r.newest;
      }
      return;
    }
    out.slices++;
    for (;;) {
      write(conn.nodes);
      if (!conn.pageInfo.hasNextPage) return;
      conn = await page(q, conn.pageInfo.endCursor);
    }
  }

  const from = new Date(since);
  await window(from, new Date(Math.max(from.getTime(), new Date(until).getTime())));
  for (const [repo, t] of repoNewest) bump.run(t, repo, t);
  return out;
}

// True when the lock file names a live process and is not stale.
export function lockHeld(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    const fresh = Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
    if (!(pid > 0 && fresh)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false; // vanished or unreadable: treat as stale
  }
}

// A lock file with the owner's pid. Returns a release function, or null when another live run holds it.
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (lockHeld(path)) return null;
    try {
      unlinkSync(path);
    } catch {
      // another run removed it first
    }
  }
  return null;
}

function lockDir(): string {
  return process.env.CRAFT_AUTO_LOCK_DIR ?? join(homedir(), ".cache/craft-automation-logs");
}

// The incremental sync's lock.
export function lockPath(): string {
  return join(lockDir(), `sync-${basename(dbPath())}.lock`);
}

// A full re-sync has its own lock, so it never blocks the incremental sync.
export function fullLockPath(): string {
  return join(lockDir(), `sync-full-${basename(dbPath())}.lock`);
}

// Wraps a client for a full re-sync, which runs beside the incremental sync and gives way to it:
// before each request it waits while `busy()` (an incremental sync is running) and, when fewer than
// `minRemaining` rate-limit points are left, sleeps until the limit resets so the incremental
// sync keeps a budget.
export type LowPriorityOpts = {
  busy: () => boolean; minRemaining: number; pollMs?: number;
  wait?: (ms: number) => Promise<void>; pause?: () => Promise<void>;
};
export function lowPriority(inner: Client, o: LowPriorityOpts): Querier {
  const wait = o.wait ?? ((ms: number) => sleep(ms));
  return {
    get spent() { return inner.spent; },
    get remaining() { return inner.remaining; },
    async query(query: string, variables: object): Promise<Node> {
      while (o.busy()) await wait(o.pollMs ?? 2000);
      if (inner.remaining !== null && inner.remaining < o.minRemaining) {
        await (o.pause ?? (() => inner.sleepUntilReset(`${inner.remaining} points left, full re-sync keeps ${o.minRemaining} for the minute sync`)))();
      }
      return inner.query(query, variables);
    },
  };
}

type SyncOpts = { only: string[]; all: boolean; full: boolean; perRepo: boolean };

async function refreshRepoList(db: DatabaseSync, client: Querier): Promise<string[]> {
  const repos = await listRepos(client);
  const upsert = db.prepare(`INSERT INTO repos (name, visibility, default_branch, open_prs, open_issues) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET visibility=excluded.visibility, default_branch=excluded.default_branch,
    open_prs=excluded.open_prs, open_issues=excluded.open_issues`);
  for (const r of repos) {
    upsert.run(r.name, r.visibility.toLowerCase(), r.defaultBranchRef?.name ?? null, r.pullRequests.totalCount, r.issues.totalCount);
  }
  setSetting(db, "repos_refreshed_at", iso(new Date()));
  return repos.map((r: Node) => r.name as string);
}

async function syncPerRepo(db: DatabaseSync, client: Querier, opts: SyncOpts): Promise<number> {
  const listed = await refreshRepoList(db, client);
  const tracked = trackedNames(db);
  const names = selectSyncRepos(listed, tracked, opts);
  const gone = opts.only.length || opts.all ? [] : tracked.filter((n) => !listed.includes(n));
  if (gone.length) console.log(`tracked but not in the org (archived or renamed): ${gone.join(", ")}`);
  // A full re-sync goes through the repos in name order and records the last one finished,
  // so a stopped run continues after it. The cursor belongs to one scope (tracked repos or all).
  const resumable = opts.full && !opts.only.length;
  const scope = opts.all ? "all" : "tracked";
  const saved = resumable ? getSetting(db, "full_sync_cursor") : null;
  const after = saved?.startsWith(`${scope}|`) ? saved.slice(scope.length + 1) : null;
  const todo = after === null ? names : names.filter((n) => n > after);
  if (after !== null) console.log(`resuming the full re-sync after ${after}: ${todo.length} of ${names.length} repos left`);
  let total = 0;
  for (const name of todo) {
    const before = client.spent;
    const count = await syncRepo(db, client, name, opts.full);
    total += count;
    if (resumable) setSetting(db, "full_sync_cursor", `${scope}|${name}`);
    console.log(`${name}: ${count} items, ${client.spent - before} points used, ${client.remaining} left`);
  }
  if (resumable) db.prepare("DELETE FROM settings WHERE key='full_sync_cursor'").run();
  return total;
}

// One item by number, any state, for the daily reconcile. A deleted or transferred item comes back null.
export const ONE_QUERY = `
query($name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: "${ORG}", name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { repository { name } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

// Lists a repo's open issues and PRs and reconciles the mirror with them. Mirror rows that are
// open here but not listed as open on GitHub are read one by one: closed or merged ones are
// updated, deleted or transferred ones (not found, or found in another repo) are marked CLOSED
// (no consumer reads a state other than OPEN, CLOSED and MERGED) and audited.
export async function reconcileRepo(db: DatabaseSync, client: Querier, name: string, now: Date = new Date()): Promise<{ open: number; updated: number; gone: number }> {
  const listed = new Set<string>();
  for (const kind of ["issue", "pr"] as const) {
    for await (const nodes of fetchPages(client, kind, "full", name, ["OPEN"])) {
      writePage(db, name, kind, "full", nodes);
      for (const n of nodes) listed.add(`${kind}\t${n.number}`);
    }
  }
  const stale = (db.prepare("SELECT kind, number FROM items WHERE repo = ? AND state = 'OPEN'").all(name) as { kind: Kind; number: number }[])
    .filter((r) => !listed.has(`${r.kind}\t${r.number}`));
  let updated = 0;
  let gone = 0;
  for (const r of stale) {
    const n: Node = (await client.query(ONE_QUERY, { name, number: r.number })).repository?.issueOrPullRequest;
    if (n && n.repository?.name === name) {
      writePage(db, name, n.__typename === "PullRequest" ? "pr" : "issue", n.state === "OPEN" ? "full" : "light", [n]);
      updated++;
    } else {
      db.prepare("UPDATE items SET state = 'CLOSED', closed_at = COALESCE(closed_at, ?) WHERE repo = ? AND number = ? AND state = 'OPEN'")
        .run(iso(now), name, r.number);
      audit(db, "sync", "item-gone", `${name}#${r.number}`, { reason: "not found or transferred on GitHub; marked CLOSED" });
      gone++;
    }
  }
  db.prepare("UPDATE repos SET reconciled_at = ? WHERE name = ?").run(iso(now), name);
  return { open: listed.size, updated, gone };
}

// The tracked repo whose last reconcile is oldest, when it is over a day old (never: first).
function reconcileDue(db: DatabaseSync, tracked: string[], now: Date): string | null {
  const at = new Map((db.prepare("SELECT name, reconciled_at FROM repos").all() as { name: string; reconciled_at: string | null }[]).map((r) => [r.name, r.reconciled_at ?? ""]));
  const oldest = [...tracked].filter((n) => at.has(n)).sort((a, b) => at.get(a)!.localeCompare(at.get(b)!))[0];
  if (oldest === undefined) return null;
  const last = at.get(oldest)!;
  return !last || now.getTime() - new Date(last).getTime() >= RECONCILE_EVERY_MS ? oldest : null;
}

// Runs one sync. `org_high_water` is the newest updatedAt stored, so the next search starts ten
// minutes before it; it does not move for --repo runs, and a full re-sync leaves an existing one alone.
export async function runSync(db: DatabaseSync, client: Querier, opts: SyncOpts, now: Date = new Date()): Promise<{ mode: string; items: number }> {
  const started = iso(now);
  const orgHigh = getSetting(db, "org_high_water");
  const tracked = trackedNames(db);
  const synced = new Set((db.prepare("SELECT name FROM repos WHERE synced_at IS NOT NULL").all() as { name: string }[]).map((r) => r.name));
  const wantsSearch = !opts.only.length && !opts.all && !opts.full && !opts.perRepo && orgHigh !== null
    && tracked.every((n) => synced.has(n));
  const spent0 = client.spent;
  let mode = "per-repo";
  let items: number;
  try {
    if (wantsSearch) {
      const r = await syncBySearch(db, client, tracked, searchSince(orgHigh as string), started);
      mode = "search";
      items = r.count;
      const high = r.newest && r.newest > (orgHigh as string) ? r.newest : (orgHigh as string);
      if (high !== orgHigh) setSetting(db, "org_high_water", high);
      const last = getSetting(db, "search_catchup_at");
      if (!last || now.getTime() - new Date(last).getTime() >= CATCHUP_EVERY_MS) {
        const c = await syncBySearch(db, client, tracked, iso(new Date(new Date(high).getTime() - CATCHUP_SPAN_MS)), iso(new Date(high)));
        items += c.count;
        setSetting(db, "search_catchup_at", started);
      }
      // One org-wide search covers every tracked repo, so each counts as synced now.
      const mark = db.prepare("UPDATE repos SET synced_at = ? WHERE name = ?");
      for (const n of tracked) mark.run(started, n);
      console.log(`search: ${r.slices} slice${r.slices === 1 ? "" : "s"}${r.fallbacks ? `, ${r.fallbacks} listed per repo` : ""}`);
      const due = reconcileDue(db, tracked, now);
      if (due) {
        const c = await reconcileRepo(db, client, due, now);
        console.log(`reconcile ${due}: ${c.open} open, ${c.updated} re-read, ${c.gone} gone`);
      }
      const at = getSetting(db, "repos_refreshed_at");
      if (!at || now.getTime() - new Date(at).getTime() >= META_REFRESH_MS) await refreshRepoList(db, client);
    } else {
      items = await syncPerRepo(db, client, opts);
      if (!opts.only.length && (orgHigh === null || !opts.full)) setSetting(db, "org_high_water", started);
    }
  } finally {
    // The dashboard can show the rate budget from these.
    const prefix = opts.full ? "sync_full" : "sync";
    setSetting(db, `${prefix}_points_last_run`, String(client.spent - spent0));
    if (client.remaining !== null) setSetting(db, "sync_rate_remaining", String(client.remaining));
  }
  return { mode, items };
}

async function sync(args: string[]): Promise<void> {
  const opts: SyncOpts = { only: [], all: false, full: false, perRepo: false };
  let reserve = 1000;
  let keep = FULL_KEEP;
  let restart = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") opts.only.push(args[++i]);
    else if (args[i] === "--full") opts.full = true;
    else if (args[i] === "--all") opts.all = true;
    else if (args[i] === "--per-repo") opts.perRepo = true;
    else if (args[i] === "--reserve") reserve = Number(args[++i]);
    else if (args[i] === "--restart") restart = true;
    else if (args[i] === "--keep") keep = Number(args[++i]);
    else throw new Error(`unknown argument ${args[i]}\nusage: sync [--repo NAME ...] [--all] [--full] [--per-repo] [--reserve N] [--keep N] [--restart]`);
  }
  const release = acquireLock(opts.full ? fullLockPath() : lockPath());
  if (!release) return;
  try {
    const db = connect();
    const client = new Client(reserve);
    if (restart) db.prepare("DELETE FROM settings WHERE key='full_sync_cursor'").run();
    const querier = opts.full ? lowPriority(client, { busy: () => lockHeld(lockPath()), minRemaining: keep }) : client;
    // Each run leaves a row for the Pipeline page; rows older than two days go.
    const row = db.prepare("INSERT INTO sync_runs (started_at) VALUES (?)").run(iso(new Date())).lastInsertRowid;
    db.prepare("DELETE FROM sync_runs WHERE started_at < ?").run(iso(new Date(Date.now() - 2 * 86400_000)));
    try {
      const { mode, items } = await runSync(db, querier, opts);
      db.prepare("UPDATE sync_runs SET ended_at = ?, mode = ?, items = ? WHERE rowid = ?").run(iso(new Date()), mode, items, row);
      console.log(`sync: mode=${mode} items=${items} points=${client.spent} left=${client.remaining}`);
      // Sandboxed calls read the item snapshot instead of GitHub. The refresh is incremental and writes nothing when nothing differs; a visibility change alone removes a repository's rows.
      refreshSnapshot();
    } catch (e) {
      db.prepare("UPDATE sync_runs SET ended_at = ?, error = ? WHERE rowid = ?").run(iso(new Date()), String((e as Error)?.message ?? e).slice(0, 300), row);
      throw e;
    }
  } finally {
    release();
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
  sync: { summary: "mirror issues and PRs of the storytold org: [--repo NAME ...] [--all] [--full] [--per-repo] [--reserve N] [--keep N] [--restart] (default: org-wide search for changes; --full runs beside it and resumes after the last finished repo)", run: sync },
  "sync-status": { summary: "per repo: open PRs, open issues, mirrored rows, synced_at", run: syncStatus },
};
