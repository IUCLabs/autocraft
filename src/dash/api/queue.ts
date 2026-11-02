// The merge queue for the dashboard: read-only, anyone signed in.
import type { DatabaseSync } from "node:sqlite";
import type { Mergeable, QueueList, QueueRow, QueueState, Tier, TypeLabel } from "../../../web/src/api/types.ts";
import { buildQueue, countStates, QUEUE_STATES } from "../../merge/queue.ts";
import { trackedNames } from "../../repos.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";

const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const CI = ["success", "failure", "pending", "none"];

export function queue(db: DatabaseSync, req: Req): QueueList {
  const repo = req.query.get("repo") || undefined;
  const state = req.query.get("state") || undefined;
  const tracked = new Set(trackedNames(db));
  if (repo && !tracked.has(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  if (state && !(QUEUE_STATES as readonly string[]).includes(state)) throw new HttpError(400, `state must be one of ${QUEUE_STATES.join(", ")}`);
  const all = buildQueue(db, { repo }).filter((e) => tracked.has(e.repo));
  const rows: QueueRow[] = all.filter((e) => !state || e.state === state).map((e) => ({
    repo: e.repo, number: e.number, title: e.title, author: e.author ?? "", tier: TIER[e.tier] ?? "not", head: e.head,
    size: (["S", "M", "L"].includes(e.size) ? e.size : "L") as QueueRow["size"], label: e.label as TypeLabel | null,
    verdict: e.verdict, reason: e.reason, fixes: e.fixes,
    ci: (CI.includes(e.ci) ? e.ci : "unknown") as QueueRow["ci"], mergeable: MERGEABLE[e.mergeable] ?? "unknown",
    state: e.state as QueueState, path: e.path, outsideRule: e.outsideRule, decisionId: e.decisionId, answer: e.answer,
    refusedReason: e.refusedReason, reviewedAt: e.reviewedAt,
  }));
  return { rows, counts: countStates(all), total: rows.length };
}
