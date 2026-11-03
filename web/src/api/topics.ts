/**
 * Which server topics each query reads. The server bumps a topic when a table
 * behind it changes (src/live.ts: TOPIC_TABLES); a query is refetched when one of
 * its topics changes. The first matching prefix wins, longest prefix first.
 * A key that matches nothing is refetched on every change, so a new query is
 * correct before it is listed here.
 */
export type Topic =
  | "repos" | "items" | "decisions" | "reviews" | "queue" | "jobs" | "usage" | "accounts" | "agents"
  | "envs" | "tasks" | "actions" | "fixes" | "verify" | "access" | "settings";

/** Everything an item page shows about a pull request. */
const ITEM: Topic[] = ["items", "decisions", "reviews", "verify", "fixes", "actions"];

const RULES: [prefix: string, topics: Topic[]][] = [
  ["progress", ["items", "repos"]],
  ["item:", ITEM],
  ["item-decisions:", ["decisions", "items"]],
  ["items:", ["items", "decisions"]],
  ["similar:", ["items"]],
  ["work:", ["items", "decisions", "reviews", "queue", "verify"]],
  ["cost:", ["usage", "agents"]],
  ["rates-", ["usage", "agents", "accounts"]],
  ["count:", ["decisions"]],
  ["decisions?", ["decisions"]],
  ["decision:", ["decisions"]],
  ["thread:", ["decisions"]],
  ["repos", ["repos"]],
  ["repo-admin", ["repos", "settings"]],
  ["cls:", ["items"]],
  ["dis:", ["items"]],
  ["contributors:", ["items", "settings"]],
  ["access", ["access"]],
  ["audit:", ["access"]],
  ["prompts", []],
  ["flow-running", ["agents"]],
  ["flow-jobs:", ["jobs", "usage"]],
  ["flow:", ["repos", "items", "decisions", "reviews", "queue", "jobs", "tasks", "verify", "fixes", "actions", "settings"]],
  ["pipeline-state", ["settings", "jobs"]],
  ["pipeline-jobs:", ["jobs", "usage"]],
  ["pipeline-job:", ["jobs", "usage", "agents"]],
  ["pipeline", ["jobs", "settings", "repos"]],
  ["agents-accounts", ["accounts"]],
  ["agents-steps", ["jobs", "settings", "repos"]],
  ["agents-repos", ["repos"]],
  ["agents-running", ["agents"]],
  ["agents-recent:", ["agents"]],
  ["agent-", ["agents"]],
  ["queue:", ["queue", "items", "decisions", "reviews", "verify", "fixes", "tasks", "settings", "repos"]],
  ["queue-batches:", ["queue", "tasks", "items"]],
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
