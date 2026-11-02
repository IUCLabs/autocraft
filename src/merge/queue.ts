// The merge queue: every PR with a take or take-fix review at its current
// head commit, and what it waits on. Reads only local tables; no GitHub calls.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledOf } from "../classify/settled.ts";
import { actionable } from "../decisions.ts";
import { headOf } from "../review/candidates.ts";
import { getRule, STATS_SQL, tierOf, type Tier } from "../whitelist.ts";

export const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "ci-failed", "conflict",
  "needs-fix-up", "needs-decision", "declined", "merged",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** Type labels whose PRs may merge without asking. */
export const RULE_LABELS = ["bugfix", "infra"];
/** Sizes that may merge without asking. */
export const RULE_SIZES = ["S", "M"];
/** Tiers that count as on the whitelist. */
export const RULE_TIERS: Tier[] = ["whitelisted", "allow"];

/** Option keys of a "Merge this PR?" decision. Only an operator's answer counts. */
export const MERGE_OPTIONS = {
  merge: { key: "merge", label: "Merge", hint: "Merge once CI is green at this head commit." },
  hold: { key: "hold", label: "Hold", hint: "Keep it open and out of the merge queue." },
  close: { key: "close", label: "Close", hint: "Not wanted as it is; close it with a short reason." },
} as const;

/** One open decision per PR head: a push gets a new one. */
export const mergeDecisionId = (repo: string, number: number, head: string): string => `${repo}#${number}:merge@${head}`;
export const HEAD_FACT = "head commit ";

export type QueueEntry = {
  repo: string; number: number; title: string; author: string | null; tier: Tier;
  head: string; size: string; label: string | null; verdict: "take" | "take-fix";
  reason: string; fixes: number; ci: string; mergeable: string;
  state: QueueState;
  /** How the PR may merge: by the rule, by an operator's answer, or not yet. */
  path: "rule" | "operator" | null;
  /** Why the rule doesn't cover it; empty when it does. */
  outsideRule: string[];
  decisionId: string | null;
  /** The operator's answer to the Merge? decision at this head, when there is one. */
  answer: string | null;
  refusedReason: string | null;
  reviewedAt: string;
};

/** True when the PR may be merged now (ready, approved, or retried after a refusal). */
export const eligible = (e: QueueEntry): boolean =>
  e.path !== null && e.ci === "success" && e.mergeable === "MERGEABLE" && (e.state === "ready" || e.state === "decision-answered-merge" || e.state === "refused");

type Row = {
  repo: string; number: number; title: string | null; author: string | null; state: string; head_oid: string | null; updated_at: string | null;
  c_head: string | null; c_at: string | null; overall: string | null; c_mergeable: string | null; i_mergeable: string | null;
  r_head: string; verdict: "take" | "take-fix"; reason: string; fixes: string | null; size: string | null; r_at: string;
};

/** Tiers of the given logins, from one stats query. */
function tiersOf(db: DatabaseSync, logins: string[]): Map<string, Tier> {
  const out = new Map<string, Tier>();
  if (!logins.length) return out;
  const rule = getRule(db);
  const marks = logins.map(() => "?").join(",");
  const stats = new Map((db.prepare(`${STATS_SQL} AND author IN (${marks}) GROUP BY author`).all(...logins) as { login: string; merged: number; closed: number }[]).map((r) => [r.login, r]));
  const over = new Map((db.prepare(`SELECT login, status FROM whitelist_overrides WHERE login IN (${marks})`).all(...logins) as { login: string; status: string }[]).map((r) => [r.login, r.status]));
  for (const l of logins) {
    const s = stats.get(l);
    out.set(l, tierOf(s?.merged ?? 0, s?.closed ?? 0, over.get(l) ?? null, rule));
  }
  return out;
}

export type QueueOptions = { repo?: string };

export function buildQueue(db: DatabaseSync, opts: QueueOptions = {}): QueueEntry[] {
  // Latest review per PR; only take and take-fix verdicts enter the queue.
  const rows = db.prepare(`
    WITH last AS MATERIALIZED (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.repo, r.number ORDER BY r.at DESC, r.rowid DESC) AS k FROM reviews r
      ${opts.repo ? "WHERE r.repo = :repo" : ""})
    SELECT i.repo, i.number, i.title, i.author, i.state, i.head_oid, i.updated_at, i.mergeable AS i_mergeable,
      c.head_oid AS c_head, c.fetched_at AS c_at, c.overall, c.mergeable AS c_mergeable,
      l.head_oid AS r_head, l.verdict, l.reason, l.fixes, l.size, l.at AS r_at
    FROM last l CROSS JOIN items i ON i.repo = l.repo AND i.number = l.number
    LEFT JOIN pr_checks c ON c.repo = l.repo AND c.number = l.number
    WHERE l.k = 1 AND l.verdict IN ('take', 'take-fix') AND i.kind = 'pr' AND i.state IN ('OPEN', 'MERGED')
    ORDER BY i.repo, i.number`).all(opts.repo ? { repo: opts.repo } : {}) as Row[];

  const merges = db.prepare("SELECT outcome, reason FROM merges WHERE repo = ? AND number = ? AND head_oid = ? ORDER BY at DESC, rowid DESC LIMIT 1");
  const decision = db.prepare("SELECT id, answer FROM decisions WHERE id = ?");
  const answers = new Map(actionable(db).filter((a) => a.kind === "merge").map((a) => [a.id, a.answer]));
  const tiers = tiersOf(db, [...new Set(rows.map((r) => r.author).filter((a): a is string => !!a))]);
  const run = latestRun(db);

  const out: QueueEntry[] = [];
  for (const r of rows) {
    const last = merges.get(r.repo, r.number, r.r_head) as { outcome: string; reason: string | null } | undefined;
    const mergedByUs = last?.outcome === "merged";
    // A merged PR keeps the review of the head it merged at; an open one must be reviewed at its current head.
    if (r.state === "OPEN" && !mergedByUs && headOf(r) !== r.r_head) continue;
    // Checks describe the reviewed head only when they were fetched for it.
    const checksHere = r.c_head === r.r_head;
    const ci = checksHere ? (r.overall ?? "none") : "unknown";
    const mergeable = (checksHere ? r.c_mergeable : r.i_mergeable) ?? "UNKNOWN";
    const tier = r.author ? tiers.get(r.author)! : "not";
    const label = settledOf(db, r.repo, r.number, run).label;
    const size = r.size ?? "L";
    let fixes = 0;
    try { fixes = (JSON.parse(r.fixes ?? "[]") as unknown[]).length; } catch { /* none */ }

    const outsideRule: string[] = [];
    if (r.verdict !== "take") outsideRule.push("review asks for fixes");
    if (!RULE_SIZES.includes(size)) outsideRule.push(`size ${size}`);
    if (!label || !RULE_LABELS.includes(label)) outsideRule.push(label ? `label ${label}` : "no settled label");
    if (!RULE_TIERS.includes(tier)) outsideRule.push(r.author ? "author not on the whitelist" : "author unknown");

    const id = mergeDecisionId(r.repo, r.number, r.r_head);
    const asked = decision.get(id) as { id: string; answer: string | null } | undefined;
    const answer = answers.get(id) ?? null;
    const e: QueueEntry = {
      repo: r.repo, number: r.number, title: r.title ?? "", author: r.author, tier, head: r.r_head, size, label,
      verdict: r.verdict, reason: r.reason, fixes, ci, mergeable, state: "needs-decision", path: null, outsideRule,
      decisionId: asked ? id : null, answer, refusedReason: null, reviewedAt: r.r_at,
    };
    e.state = stateOf(e, r.state === "MERGED" || mergedByUs, last);
    out.push(e);
  }
  return out;
}

function stateOf(e: QueueEntry, merged: boolean, last: { outcome: string; reason: string | null } | undefined): QueueState {
  if (merged) return "merged";
  if (e.verdict === "take-fix") return "needs-fix-up";
  if (!e.outsideRule.length) e.path = "rule";
  else if (e.answer === "merge") e.path = "operator";
  else if (e.answer) return "declined";
  if (e.mergeable === "CONFLICTING") return "conflict";
  if (e.ci === "failure") return "ci-failed";
  if (!e.path) return "needs-decision";
  if (e.ci !== "success" || e.mergeable !== "MERGEABLE") return "waiting-ci";
  if (last?.outcome === "refused") {
    e.refusedReason = last.reason;
    return "refused";
  }
  return e.path === "rule" ? "ready" : "decision-answered-merge";
}

export function countStates(entries: QueueEntry[]): Record<QueueState, number> {
  const c = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<QueueState, number>;
  for (const e of entries) c[e.state]++;
  return c;
}
