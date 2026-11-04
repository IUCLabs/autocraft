/**
 * Which server topics each query reads. The server bumps a topic when a table
 * behind it changes (src/live.ts: TOPIC_TABLES); a query is refetched when one of
 * its topics changes. The first matching prefix wins, longest prefix first.
 * A key that matches nothing is refetched on every change, so a new query is
 * correct before it is listed here.
 */
export type Topic =
  | "repos" | "sync" | "items" | "ranks" | "stages" | "checks" | "classify" | "dupes" | "decisions" | "reviews" | "queue" | "jobs" | "usage" | "accounts" | "agents"
  | "envs" | "tasks" | "actions" | "fixes" | "verify" | "postmerge" | "access" | "settings" | "trace" | "github" | "fasttrack" | "plans" | "conversations" | "steps" | "mainci";

/** What moves an item's queue position (src/rank/position.ts), for every query that carries the badge. */
const withSlot = (...topics: Topic[]): Topic[] => [...new Set<Topic>([...topics, "steps", "repos"])];

/** Everything an item page shows about a pull request. */
const ITEM: Topic[] = withSlot("items", "stages", "classify", "ranks", "decisions", "reviews", "verify", "fixes", "postmerge", "actions", "checks");

const RULES: [prefix: string, topics: Topic[]][] = [
  // Agent progress lines arrive through `agents`; the shared 3 s window in live.tsx limits the refetch.
  ["now", ["jobs", "agents", "tasks", "queue", "sync", "accounts", "settings", "repos", "mainci", "decisions", "access", "actions"]],
  ["progress", ["items", "stages", "repos", "decisions", "mainci"]],
  ["main-ci", ["mainci", "repos"]],
  // The trace reads most tables behind an item page plus model calls, jobs and GitHub detail. The `trace` topic leaves out a running call's progress lines; the page also asks the server `since` its last stamp.
  ["item-trace:", withSlot("items", "stages", "decisions", "reviews", "verify", "fixes", "postmerge", "actions", "plans", "tasks", "conversations", "queue", "access", "checks", "trace")],
  ["item:", ITEM],
  ["item-decisions:", withSlot("decisions", "items")],
  ["items:", withSlot("items", "stages", "classify", "decisions")],
  ["similar:", ["items"]],
  ["work:", ["items", "ranks", "classify", "checks", "decisions", "reviews", "verify", "fixes"]],
  ["cost:", ["usage", "agents"]],
  ["rates-", ["usage", "agents", "accounts"]],
  ["count:", ["decisions"]],
  ["needs:", ["decisions", "conversations", "items", "jobs", "accounts", "settings"]],
  ["decisions?", withSlot("decisions")],
  ["decision:", withSlot("decisions")],
  ["thread:", ["decisions"]],
  ["conversation:", ["conversations"]],
  ["repos", ["repos"]],
  ["repo-admin", ["repos", "sync", "settings"]],
  ["cls:", ["classify", "items"]],
  ["dis:", ["dupes", "items"]],
  ["contributors:", ["items", "settings"]],
  ["access", ["access"]],
  ["audit:", ["access"]],
  ["github-activity:", ["github"]],
  ["prompts", []],
  ["flow-running", ["agents"]],
  ["flow-jobs:", ["jobs", "usage"]],
  ["flow:", ["repos", "sync", "stages", "settings"]],
  ["pipeline-state", ["settings", "jobs"]],
  ["pipeline-jobs:", ["jobs", "usage"]],
  ["pipeline-job:", ["jobs", "usage", "agents"]],
  ["pipeline", ["jobs", "settings", "repos", "sync"]],
  ["agents-accounts", ["accounts"]],
  ["agents-steps", ["jobs", "settings", "repos"]],
  ["agents-repos", ["repos"]],
  ["agents-running", ["agents"]],
  ["agents-recent:", ["agents"]],
  ["agent-", ["agents"]],
  ["queue:", ["queue", "items", "checks", "classify", "decisions", "reviews", "verify", "fixes", "tasks", "settings", "repos"]],
  ["next-page", ["plans", "jobs", "settings", "repos", "items", "ranks", "fasttrack", "usage", "accounts", "stages", "tasks"]],
  ["queue-batches:", ["queue", "tasks", "items"]],
  ["queue-page:", ["queue", "fasttrack", "ranks", "items", "checks", "classify", "decisions", "reviews", "verify", "fixes", "tasks", "settings", "repos"]],
  ["fast-track", ["fasttrack", "items"]],
  ["merge-held", ["queue"]],
  ["accounts", ["accounts", "settings"]],
  ["envs-repos", ["repos"]],
  ["envs", ["envs", "tasks"]],
  ["tasks:", ["tasks", "envs"]],
  ["task-", ["tasks", "envs"]],
  ["build-summary", ["tasks", "envs"]],
].sort((a, b) => b[0].length - a[0].length) as [string, Topic[]][];

/** Topics a query key reads, or null for "any change". */
export function topicsFor(key: string): Topic[] | null {
  return RULES.find(([p]) => key.startsWith(p))?.[1] ?? null;
}
