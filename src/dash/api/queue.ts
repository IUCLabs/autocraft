// The merge queue for the dashboard: read-only, anyone signed in.
import type { DatabaseSync } from "node:sqlite";
import type { Mergeable, QueueList, QueueRow, QueueState, Tier, TypeLabel } from "../../../web/src/api/types.ts";
import { buildQueue, countMerged, countStates, QUEUE_STATES, type QueueEntry } from "../../merge/queue.ts";
import { trackedNames } from "../../repos.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const CI = ["success", "failure", "pending", "none"];

const toRow = (e: QueueEntry): QueueRow => ({
  repo: e.repo, number: e.number, title: e.title, author: e.author ?? "", tier: TIER[e.tier] ?? "not", head: e.head,
  size: (["S", "M", "L"].includes(e.size) ? e.size : "L") as QueueRow["size"], label: e.label as TypeLabel | null,
  verdict: e.verdict, reason: e.reason, fixes: e.fixes,
  ci: (CI.includes(e.ci) ? e.ci : "unknown") as QueueRow["ci"], mergeable: MERGEABLE[e.mergeable] ?? "unknown",
  state: e.state as QueueState, path: e.path, outsideRule: e.outsideRule, decisionId: e.decisionId, answer: e.answer,
  refusedReason: e.refusedReason, reviewedAt: e.reviewedAt,
});

/** `repo#number` cursor of the last row of a page. */
const cursorOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;
function parseCursor(s: string | null): { repo: string; number: number } | undefined {
  if (!s) return undefined;
  const k = s.lastIndexOf("#");
  const number = Number(s.slice(k + 1));
  if (k < 1 || !Number.isInteger(number)) throw new HttpError(400, "after must be repo#number");
  return { repo: s.slice(0, k), number };
}

// The built open queue, kept while nothing it reads changed and for OPEN_TTL at most,
// so paging and the state chips do not rebuild it.
const OPEN_TTL = 20_000;
const openCache = new WeakMap<DatabaseSync, { key: string; at: number; open: QueueEntry[]; merged: number }>();

function openQueue(db: DatabaseSync, repo: string | undefined, tracked: Set<string>): { open: QueueEntry[]; merged: number } {
  const sig = db.prepare(`SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM main.reviews) AS rv,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM main.merges) AS mg,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(answered_at), '') FROM main.decisions WHERE kind = 'merge') AS dc,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(fetched_at), '') FROM main.pr_checks) AS ck,
      (SELECT MAX(rowid) FROM main.classifications) AS cl,
      (SELECT value FROM main.settings WHERE key = 'org_high_water') AS hw,
      (SELECT group_concat(name) FROM main.tracked_repos) AS tr`).get();
  const key = JSON.stringify([sig, repo ?? null]);
  const hit = openCache.get(db);
  const now = Date.now();
  if (hit && hit.key === key && now - hit.at < OPEN_TTL) return hit;
  const open = buildQueue(db, { repo, merged: "exclude" }).filter((e) => tracked.has(e.repo));
  const built = { key, at: now, open, merged: countMerged(db, repo) };
  openCache.set(db, built);
  return built;
}

// Open PRs are built whole (the state of each depends on CI, decisions and merge
// records, so counts and the state filter need all of them) and cut into pages
// by (repo, number). Merged PRs, the bulk of the table, are read a page at a time
// and only when state=merged.
export function queue(db: DatabaseSync, req: Req): QueueList {
  const repo = req.query.get("repo") || undefined;
  const state = req.query.get("state") || undefined;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const after = parseCursor(req.query.get("after"));
  const tracked = new Set(trackedNames(db));
  if (repo && !tracked.has(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  if (state && !(QUEUE_STATES as readonly string[]).includes(state)) throw new HttpError(400, `state must be one of ${QUEUE_STATES.join(", ")}`);
  const { open, merged } = openQueue(db, repo, tracked);
  // An open PR that we merged and the mirror has not seen merged yet counts as merged.
  const counts = countStates(open);
  counts.merged += merged;
  let page: QueueEntry[];
  let more: boolean;
  if (state === "merged") {
    page = buildQueue(db, { repo, merged: "only", after, limit: limit + 1 }).filter((e) => tracked.has(e.repo));
    more = page.length > limit;
    page = page.slice(0, limit);
  } else {
    const match = open.filter((e) => e.state !== "merged" && (!state || e.state === state));
    const from = after ? match.findIndex((e) => e.repo > after.repo || (e.repo === after.repo && e.number > after.number)) : 0;
    const rest = from < 0 ? [] : match.slice(from);
    page = rest.slice(0, limit);
    more = rest.length > limit;
  }
  const total = state === "merged" ? counts.merged : Object.entries(counts).reduce((a, [k, n]) => a + (k === "merged" || (state && k !== state) ? 0 : n), 0);
  return { rows: page.map(toRow), counts, total, next: more ? cursorOf(page[page.length - 1]!) : null };
}
