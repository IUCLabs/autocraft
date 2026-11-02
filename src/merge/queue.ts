// The merge queue: every PR with a take or take-fix review at its current
// head commit, and what it waits on. Reads only local tables; no GitHub calls.
import type { DatabaseSync } from "node:sqlite";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { actionable } from "../decisions.ts";
import { headOf } from "../review/candidates.ts";
import { getRule, STATS_SQL, tierOf, type Tier } from "../whitelist.ts";

export const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "declined", "merged",
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

/** Verification states that let a PR merge. */
export const VERIFY_OK = ["passed", "ci-enough"];
export const verifyOk = (state: string | null | undefined): boolean => !!state && VERIFY_OK.includes(state);

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
  /** The verification of the PR's current head, or null when there is none. */
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
};

/** True when the PR may be merged now (ready, approved, or retried after a refusal). */
export const eligible = (e: QueueEntry): boolean =>
  e.path !== null && verifyOk(e.verify?.state) && e.ci === "success" && e.mergeable === "MERGEABLE" && (e.state === "ready" || e.state === "decision-answered-merge" || e.state === "refused");

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

export type QueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  /** Repos left out. */
  exclude?: string[];
  /** The classification run for labels, resolved once by the caller (default: latestRun). */
  run?: string | null;
};

export function buildQueue(db: DatabaseSync, opts: QueueOptions = {}): QueueEntry[] {
  const states = { exclude: "'OPEN'", only: "'MERGED'", all: "'OPEN', 'MERGED'" }[opts.merged ?? "all"];
  const params: Record<string, string | number> = {};
  const where: string[] = [];
  if (opts.repo) { where.push("i.repo = :repo"); params.repo = opts.repo; }
  opts.exclude?.forEach((r, k) => { where.push(`i.repo <> :ex${k}`); params[`ex${k}`] = r; });
  if (opts.after) {
    where.push("(i.repo > :ar OR (i.repo = :ar AND i.number > :an))");
    params.ar = opts.after.repo;
    params.an = opts.after.number;
  }
  // Latest review per PR (newest `at`, then rowid); only take and take-fix verdicts enter the queue.
  const rows = db.prepare(`
    SELECT i.repo, i.number, i.title, i.author, i.state, i.head_oid, i.updated_at, i.mergeable AS i_mergeable,
      c.head_oid AS c_head, c.fetched_at AS c_at, c.overall, c.mergeable AS c_mergeable,
      l.head_oid AS r_head, l.verdict, l.reason, l.fixes, l.size, l.at AS r_at
    FROM items i
    JOIN reviews l ON l.repo = i.repo AND l.number = i.number AND l.rowid = (
      SELECT r.rowid FROM reviews r WHERE r.repo = i.repo AND r.number = i.number ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    LEFT JOIN pr_checks c ON c.repo = l.repo AND c.number = l.number
    WHERE l.verdict IN ('take', 'take-fix') AND i.kind = 'pr' AND i.state IN (${states}) ${where.map((w) => `AND ${w}`).join(" ")}
    ORDER BY i.repo, i.number ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ""}`).all(params) as Row[];

  const merges = db.prepare("SELECT outcome, reason FROM merges WHERE repo = ? AND number = ? AND head_oid = ? ORDER BY at DESC, rowid DESC LIMIT 1");
  const verifs = db.prepare("SELECT state, kind, summary, note FROM verifications WHERE repo = ? AND number = ? AND head_sha = ?");
  const decision = db.prepare("SELECT id, answer FROM decisions WHERE id = ?");
  const answers = new Map(actionable(db).filter((a) => a.kind === "merge").map((a) => [a.id, a.answer]));
  const tiers = tiersOf(db, [...new Set(rows.map((r) => r.author).filter((a): a is string => !!a))]);
  const settled = settledLookup(db, opts.run !== undefined ? opts.run : latestRun(db));

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
    const label = settled(r.repo, r.number).label;
    const size = r.size ?? "L";
    let fixes = 0;
    try { fixes = (JSON.parse(r.fixes ?? "[]") as unknown[]).length; } catch { /* none */ }

    const outsideRule: string[] = [];
    if (r.verdict !== "take") outsideRule.push("review asks for fixes");
    if (!RULE_SIZES.includes(size)) outsideRule.push(`size ${size}`);
    if (!label || !RULE_LABELS.includes(label)) outsideRule.push(label ? `label ${label}` : "no settled label");
    if (!RULE_TIERS.includes(tier)) outsideRule.push(r.author ? "author not on the whitelist" : "author unknown");

    const verify = (verifs.get(r.repo, r.number, r.r_head) as QueueEntry["verify"] | undefined) ?? null;
    const id = mergeDecisionId(r.repo, r.number, r.r_head);
    const asked = decision.get(id) as { id: string; answer: string | null } | undefined;
    const answer = answers.get(id) ?? null;
    const e: QueueEntry = {
      repo: r.repo, number: r.number, title: r.title ?? "", author: r.author, tier, head: r.r_head, size, label,
      verdict: r.verdict, reason: r.reason, fixes, ci, mergeable, state: "needs-decision", path: null, outsideRule,
      decisionId: asked ? id : null, answer, refusedReason: null, reviewedAt: r.r_at, verify,
    };
    e.state = stateOf(e, r.state === "MERGED" || mergedByUs, last);
    out.push(e);
  }
  return out;
}

/** The queue state a PR is in until its verification passed (or said CI is enough); null once it did. */
function verifyState(e: QueueEntry): QueueState | null {
  const s = e.verify?.state;
  if (verifyOk(s)) return null;
  return s === "failed" ? "verify-failed" : s === "error" ? "verify-error" : "waiting-verify";
}

function stateOf(e: QueueEntry, merged: boolean, last: { outcome: string; reason: string | null } | undefined): QueueState {
  if (merged) return "merged";
  if (e.verdict === "take-fix") return "needs-fix-up";
  if (!e.outsideRule.length) e.path = "rule";
  else if (e.answer === "merge") e.path = "operator";
  else if (e.answer) return "declined";
  if (e.mergeable === "CONFLICTING") return "conflict";
  if (e.ci === "failure") return "ci-failed";
  // A Merge? question is asked only once the operator can see the verification result.
  if (!e.path) return verifyState(e) ?? "needs-decision";
  if (e.ci !== "success" || e.mergeable !== "MERGEABLE") return "waiting-ci";
  const v = verifyState(e);
  if (v) return v;
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

/** How many merged PRs have a take or take-fix review as their latest. */
export function countMerged(db: DatabaseSync, repo?: string, exclude: string[] = []): number {
  const params: Record<string, string> = repo ? { repo } : {};
  exclude.forEach((r, k) => { params[`ex${k}`] = r; });
  return (db.prepare(`SELECT COUNT(*) AS n FROM items i
    JOIN reviews l ON l.repo = i.repo AND l.number = i.number AND l.rowid = (
      SELECT r.rowid FROM reviews r WHERE r.repo = i.repo AND r.number = i.number ORDER BY r.at DESC, r.rowid DESC LIMIT 1)
    WHERE l.verdict IN ('take', 'take-fix') AND i.kind = 'pr' AND i.state = 'MERGED' ${repo ? "AND i.repo = :repo" : ""}${exclude.map((_, k) => ` AND i.repo <> :ex${k}`).join("")}`)
    .get(params) as { n: number }).n;
}
