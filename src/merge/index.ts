// Stage 6, Integrate (first part): merges the queued PRs that may merge, one
// at a time, through the configured merge command, and asks a "Merge this PR?"
// decision for taken PRs the merge rule doesn't cover. No model calls.
//
//   autocraft merge --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only, calls
// nothing and writes nothing.
import { scopeRepos } from "../pilot.ts";
import { FAST_FLOOR, workScores } from "../fasttrack.ts";
import { mergeHeld } from "./holds.ts";
import { backlogHeld, duplicateHeld } from "../dupes/held.ts";
import { mergeApprovalOf } from "./approval.ts";
import { markReread } from "./ci-approval.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { actionable, ask, factsOf, getDecision } from "../decisions.ts";
import { assignTo, mergeViaCommand, MERGE_RECORDED_ENV, type Writer } from "../github/write.ts";
import { Client, markMerged, type Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { readGate } from "./changes-requested.ts";
import { liveGateChecked } from "../review/discussion.ts";
import { fillReviewSummaries } from "../review/summary.ts";
import { verificationOf } from "../verify/results.ts";
import { TIER_LABEL } from "../whitelist.ts";
import { withdrawBlockedQuestions, withdrawGroupedQuestions } from "./withdraw.ts";
import { buildQueue, UNSURE_REASON, ciAllows, toAsk, countStates, eligible, HEAD_FACT, MERGE_OPTIONS, mergeDecisionId, QUEUE_STATES, VERIFY_UNAVAILABLE, verifyAllows, type QueueEntry } from "./queue.ts";

export { buildQueue, countStates, QUEUE_STATES, toAsk, type QueueEntry, type QueueState } from "./queue.ts";
import { envVar } from "../env.ts";

export const ORG = "storytold";
/** Name of the built-in guarded merge (`autocraft safe-merge`); any other `$AUTOCRAFT_MERGE_CMD` is run as an external command. */
export const DEFAULT_MERGE_COMMAND = "safe-merge";
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ACTOR = "merge";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type MergeDeps = {
  querier: Querier;
  /** Runs the merge command; throws only when it can't be started. */
  run: (cmd: string, args: string[]) => Promise<CommandResult>;
  now: () => Date;
  /** `$AUTOCRAFT_MERGE_CMD`, default the built-in `safe-merge`. */
  mergeCommand: string;
};

export type MergeParams = {
  repo: string;
  /** Most merges to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` merges, assigns or asks. */
  dryRun?: boolean;
  /** Only PRs this accepts are merged (the rest are left to the integration batches). */
  only?: (e: QueueEntry) => boolean;
  /** Stop at the first PR that is refused; the rest wait for the next round. */
  stopOnRefusal?: boolean;
  /** Called with the running count of PRs merged, after each merge. */
  onMerged?: (merged: number) => void;
};

export type MergeSummary = {
  runId: string; repo: string; dryRun: boolean;
  states: Record<string, number>;
  /** PRs tried (or, in a dry run, that would be). */
  attempted: string[]; merged: string[]; refused: { ref: string; reason: string }[];
  /** Merge? decisions asked (or that would be). */
  asked: string[];
};

export function spawnRun(cmd: string, args: string[], env?: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs the merge command; the built-in name runs `autocraft safe-merge` from this checkout. */
export function mergeRun(cmd: string, args: string[]): Promise<CommandResult> {
  return cmd === DEFAULT_MERGE_COMMAND ? spawnRun(process.execPath, ["--no-warnings", CLI, "safe-merge", ...args], { [MERGE_RECORDED_ENV]: "1" }) : spawnRun(cmd, args);
}

export function defaultDeps(): MergeDeps {
  return { querier: new Client(1000), run: mergeRun, now: () => new Date(), mergeCommand: envVar("MERGE_CMD") || DEFAULT_MERGE_COMMAND };
}

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

// ---- GitHub reads and the one write this step makes itself (assignment) ----

type Viewer = { login: string; id: string };
const viewers = new WeakMap<Querier, Viewer>();

/** The pipeline's GitHub account, asked once per querier. */
export async function viewerOf(q: Querier): Promise<Viewer> {
  let v = viewers.get(q);
  if (!v) {
    const d = await q.query("query { viewer { login id } }", {}) as { viewer?: Viewer };
    if (!d.viewer?.login || !d.viewer.id) throw new Error("could not read the pipeline's GitHub account");
    v = d.viewer;
    viewers.set(q, v);
  }
  return v;
}

export type PrInfo = { id: string; head: string; state: string; assignees: string[]; authors: number; commits: number };

export const PR_INFO_QUERY = `query($name: String!, $n: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: "${ORG}", name: $name) {
    pullRequest(number: $n) {
      id headRefOid state
      assignees(first: 10) { nodes { login } }
      commits(first: 100) { totalCount nodes { commit { authors(first: 10) { nodes { email name user { login } } } } } }
    }
  }
}`;

type InfoNode = {
  id: string; headRefOid: string; state: string; assignees?: { nodes?: { login: string }[] };
  commits?: { totalCount: number; nodes?: { commit?: { authors?: { nodes?: { email?: string | null; name?: string | null; user?: { login: string } | null }[] } } }[] };
};

export async function prInfo(q: Querier, repo: string, n: number): Promise<PrInfo | null> {
  const d = await q.query(PR_INFO_QUERY, { name: repo, n }) as { repository?: { pullRequest?: InfoNode | null } };
  const p = d.repository?.pullRequest;
  if (!p) return null;
  const who = new Set<string>();
  for (const c of p.commits?.nodes ?? [])
    for (const a of c.commit?.authors?.nodes ?? []) who.add(a.user?.login ? `@${a.user.login}` : (a.email || a.name || "?").toLowerCase());
  return {
    id: p.id, head: p.headRefOid, state: p.state, assignees: (p.assignees?.nodes ?? []).map((a) => a.login),
    authors: who.size, commits: p.commits?.totalCount ?? 0,
  };
}

/** Squash keeps one author; a PR with commits by several (or more commits than we can read) is merged as is. */
export const methodOf = (info: PrInfo): "squash" | "merge" => (info.authors > 1 || info.commits > 100 ? "merge" : "squash");


// ---- decisions ---------------------------------------------------------------

/** The Merge? question for a take PR outside the rule; its facts carry the head commit. */
export function mergeQuestion(e: QueueEntry): Record<string, unknown> & { id: string } {
  const fixes = e.fixes ? `; ${e.fixes} fix${e.fixes === 1 ? "" : "es"} listed` : "";
  return {
    id: mergeDecisionId(e.repo, e.number, e.head), kind: "merge", repo: e.repo, number: e.number,
    question: "Merge this PR?",
    context: `The review says take, but the merge-without-asking rule doesn't cover it: ${e.outsideRule.join(", ")}.`,
    facts: [
      `size ${e.size}, label ${e.label ?? "not settled"}; author: ${e.author ?? "unknown"}, ${TIER_LABEL[e.tier]}`,
      `CI ${e.noCi ? "none: the repo has no CI checks" : e.ci}, mergeable ${e.mergeable.toLowerCase()}`,
      e.verify?.state === VERIFY_UNAVAILABLE
        ? `not verified: ${e.verify.summary ?? "Verify cannot build this repo"}`
        : `verify: ${e.verify ? `${e.verify.kind ?? "unknown"}, ${e.verify.state}${e.verify.note ? `: ${e.verify.note}` : ""}` : "none"}`,
      `review: ${e.verdict}: ${e.reason}${fixes}`,
      `${HEAD_FACT}${e.head}`,
    ],
    options: Object.values(MERGE_OPTIONS).map((o) => ({ ...o })),
    ...(e.outsideRule.includes(UNSURE_REASON) ? {} : { recommended: "merge" }),
    asked_by: ACTOR,
  };
}

/** The head commit an answered Merge? decision was asked at, from its facts. */
export function answeredHead(db: DatabaseSync, id: string): string | null {
  const d = getDecision(db, id);
  const f = d ? factsOf(d).find((x) => x.startsWith(HEAD_FACT)) : undefined;
  return f ? f.slice(HEAD_FACT.length).trim() : null;
}


/**
 * Asks the Merge? decisions that are due in the given repos (default: all), whether or not the repo has
 * a merge approval or a PR the rule could merge. Writes decisions only, nothing to GitHub.
 */
export function askMergeDecisions(db: DatabaseSync, opts: { repos?: string[]; run?: string | null; at?: string } = {}): string[] {
  const repos = opts.repos && new Set(opts.repos);
  const queue = buildQueue(db, { merged: "exclude", ...(opts.run === undefined ? {} : { run: opts.run }) });
  const qs = toAsk(db, queue.filter((e) => !repos || repos.has(e.repo))).map(mergeQuestion);
  const at = opts.at ?? new Date().toISOString();
  withdrawBlockedQuestions(db, queue.filter((e) => !repos || repos.has(e.repo)), at);
  for (const r of repos ?? new Set(queue.map((e) => e.repo))) withdrawGroupedQuestions(db, at, r);
  if (qs.length) ask(db, qs.map((q) => ({ ...q, asked_at: at })));
  fillReviewSummaries(db, at);
  return qs.map((q) => q.id);
}

// ---- the step ----------------------------------------------------------------

export async function runMerge(db: DatabaseSync, params: MergeParams, log: (line: string) => void = console.log, deps?: MergeDeps): Promise<MergeSummary> {
  const { repo } = params;
  const w: Writer = { db, login: ACTOR };
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `merge-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  if (!scopeRepos(db).has(repo)) {
    log(`merge ${repo}: not in the pipeline scope; nothing done`);
    return { runId, repo, dryRun, states: {}, attempted: [], merged: [], refused: [], asked: [] };
  }
  const d = deps ?? defaultDeps();
  // A PR in changes-requested is read live again each run: the mirror alone can block wrongly (the association is relative to the viewer) and a blocked PR never reaches the merge-time read.
  if (!dryRun) {
    for (const e of buildQueue(db, { repo, merged: "exclude" })) if (e.state === "changes-requested") await readGate(db, d.querier, ORG, repo, e.number, log);
  }
  const queue = buildQueue(db, { repo });
  const open = queue.filter((e) => e.state !== "merged");
  const states = countStates(queue);
  const scores = workScores(db, repo);
  const fast = (e: QueueEntry) => (scores.get(e.number) ?? 0) >= FAST_FLOOR;
  const byRank = (a: QueueEntry, b: QueueEntry) => (scores.get(b.number) ?? -1) - (scores.get(a.number) ?? -1) || a.number - b.number;
  // Fast-tracked PRs first, in the order added (their score falls with the order); then rule merges before answered ones, each by work score, unranked last.
  let picks = open.filter((e) => eligible(e) && (!params.only || params.only(e))).sort((a, b) =>
    fast(a) || fast(b) ? Number(fast(b)) - Number(fast(a)) || byRank(a, b) : a.path === b.path ? byRank(a, b) : a.path === "rule" ? -1 : 1);
  if (params.limit !== undefined) picks = picks.slice(0, params.limit);
  const ask1 = toAsk(db, open);
  const summary: MergeSummary = { runId, repo, dryRun, states, attempted: [], merged: [], refused: [], asked: [] };
  log(`merge ${repo}: ${queue.length} in the queue (${QUEUE_STATES.filter((s) => states[s]).map((s) => `${states[s]} ${s}`).join(", ") || "none"})`);

  if (dryRun) {
    summary.attempted = picks.map(refOf);
    summary.asked = ask1.map((e) => mergeDecisionId(e.repo, e.number, e.head));
    for (const e of picks) log(`  would merge ${refOf(e)} at ${short(e.head)} (${e.path === "rule" ? "by the rule" : "operator answered merge"})`);
    for (const e of ask1) log(`  would ask Merge? for ${refOf(e)}: ${e.outsideRule.join(", ")}`);
    log(`merge ${repo}: dry run, nothing called or written`);
    return summary;
  }

  // A Merge? question open for a PR a maintainer has since blocked no longer applies.
  const withdrawn = withdrawBlockedQuestions(db, open, at());
  if (withdrawn) log(`  withdrew ${withdrawn} Merge? decision${withdrawn === 1 ? "" : "s"} of PRs with changes requested`);
  const grouped = withdrawGroupedQuestions(db, at(), repo);
  if (grouped) log(`  set aside ${grouped} Merge? decision${grouped === 1 ? "" : "s"} of PRs in a duplicate group`);

  // Every taken PR in the queue gets one `batched` stage row per head.
  const batched = db.prepare("SELECT 1 FROM stages WHERE repo = ? AND number = ? AND stage = 'batched' AND note LIKE ?");
  const stage = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, ?, ?, ?, ?)");
  for (const e of open) {
    if (!batched.get(e.repo, e.number, `queued at ${short(e.head)}%`)) stage.run(e.repo, e.number, "batched", at(), ACTOR, `queued at ${short(e.head)}: ${e.state}`);
  }

  if (ask1.length) {
    const qs = ask1.map(mergeQuestion);
    ask(db, qs.map((q) => ({ ...q, asked_at: at() })));
    summary.asked = qs.map((q) => q.id);
    log(`  asked ${qs.length} Merge? decision${qs.length === 1 ? "" : "s"}`);
  }
  fillReviewSummaries(db, at());

  // What GitHub reported for the PR being tried, once known; a refusal records it so the autopilot retries only when it changes.
  let seen: { ci: string; mergeable: string } | null = null;
  const saveAttempt = (e: QueueEntry, method: string | null, outcome: "merged" | "refused", reason: string | null) =>
    db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome, reason, ci, mergeable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.repo, e.number, e.head, runId, at(), e.path!, method, outcome, reason, seen?.ci ?? e.ci, seen?.mergeable ?? e.mergeable);
  const refuse = (e: QueueEntry, method: string | null, reason: string) => {
    saveAttempt(e, method, "refused", reason);
    if (/action_required/.test(reason)) markReread(db, e.repo, e.number, e.head);
    audit(db, ACTOR, "merge-refused", refOf(e), { run: runId, head: e.head, path: e.path, method, reason });
    summary.refused.push({ ref: refOf(e), reason });
    log(`  ${refOf(e)}: refused: ${reason}`);
  };

  // One PR at a time; any error that isn't a refusal stops the run.
  for (const e of picks) {
    if (params.stopOnRefusal && summary.refused.length) break;
    if (!mergeApprovalOf(db, repo)) { log(`  merging in ${repo} is no longer approved; stopping`); break; }
    if (mergeHeld(db, repo, e.number)) { log(`  ${refOf(e)}: merge held since the queue was read; skipped`); continue; }
    if (backlogHeld(db, repo, e.number) || duplicateHeld(db, repo, e.number)) { log(`  ${refOf(e)}: held since the queue was read; skipped`); continue; }
    summary.attempted.push(refOf(e));
    seen = null;
    const [ch] = await refreshChecks(db, d.querier, repo, [e.number]);
    // GitHub often has no mergeable state yet right after a merge: end the round without a refusal on record.
    if (params.stopOnRefusal && summary.merged.length && ch?.state === "OPEN" && ch.mergeable === "UNKNOWN") { log(`  ${refOf(e)}: GitHub has not computed its mergeable state yet; left for the next round`); summary.attempted.pop(); break; }
    if (ch) seen = { ci: ch.overall ?? "none", mergeable: ch.mergeable ?? "UNKNOWN" };
    if (!ch) { refuse(e, null, "GitHub returned no such PR"); continue; }
    if (ch.state !== "OPEN") { refuse(e, null, `no longer open on GitHub (${ch.state.toLowerCase()})`); continue; }
    if (ch.head_oid !== e.head) { refuse(e, null, `head moved from ${short(e.head)} to ${short(ch.head_oid)} since the review`); continue; }
    const ver = verificationOf(db, repo, e.number, ch.head_oid);
    if (!verifyAllows(e.path, ver?.state)) { refuse(e, null, `verification at ${short(ch.head_oid)} is ${ver?.state ?? "missing"}, not passed`); continue; }
    if (e.path === "operator") {
      const still = actionable(db).some((a) => a.id === e.decisionId && a.answer === MERGE_OPTIONS.merge.key);
      if (!still) { refuse(e, null, "the operator's merge answer is gone"); continue; }
      const h = answeredHead(db, e.decisionId!);
      if (h !== ch.head_oid) { refuse(e, null, `head moved since the operator's answer (${h ? short(h) : "no head recorded"} → ${short(ch.head_oid)})`); continue; }
    }
    if (!ciAllows(e.path, ch.overall, e.noCi) || ch.mergeable !== "MERGEABLE") {
      refuse(e, null, `not ready at merge time: CI ${ch.overall}, mergeable ${(ch.mergeable ?? "unknown").toLowerCase()}`);
      continue;
    }
    const info = await prInfo(d.querier, repo, e.number);
    if (!info) { refuse(e, null, "GitHub returned no such PR"); continue; }
    if (info.head !== e.head) { refuse(e, null, `head moved from ${short(e.head)} to ${short(info.head)} since the review`); continue; }
    // Not a refusal: no merges row, so the queue keeps the PR and takes it up again once it is reviewed again.
    // The same read checks for a maintainer's changes-requested review, whatever merge command runs next.
    const gate = await liveGateChecked(db, d.querier, repo, e.number, e.head, log);
    if (gate === null) continue;
    if (gate.blocked) { log(`  ${refOf(e)}: ${gate.blocked}; not merged`); continue; }
    if (gate.moved) {
      audit(db, ACTOR, "merge-held-for-discussion", refOf(e), { run: runId, head: e.head, path: e.path });
      log(`  ${refOf(e)}: new comments or reviews since the final review; not merged, it is reviewed again first`);
      continue;
    }
    if (!info.assignees.length) {
      const me = await viewerOf(d.querier);
      await assignTo(w, d.querier, { repo, number: e.number, id: info.id }, me, { run: runId });
      log(`  ${refOf(e)}: assigned to ${me.login}`);
    }
    const method = methodOf(info);
    // A hold may have been set during the calls above.
    if (mergeHeld(db, repo, e.number)) { log(`  ${refOf(e)}: merge held meanwhile; skipped`); summary.attempted.pop(); continue; }
    const r = await mergeViaCommand(w, d.run, d.mergeCommand, [`${ORG}/${repo}`, String(e.number), `--${method}`], { run: runId, head: e.head, path: e.path });
    if (r.code !== 0) {
      const why = oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`;
      refuse(e, method, `${d.mergeCommand}: ${why}`);
      continue;
    }
    saveAttempt(e, method, "merged", null);
    markMerged(db, e.repo, e.number, at());
    stage.run(e.repo, e.number, "merged", at(), ACTOR, `${method} at ${short(e.head)}${e.path === "operator" ? ", operator answered merge" : ""}`);
    if (e.path === "operator") db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(at(), e.decisionId);
    summary.merged.push(refOf(e));
    params.onMerged?.(summary.merged.length);
    log(`  ${refOf(e)}: merged (${method})`);
  }
  log(`merge ${repo}: ${summary.merged.length} merged, ${summary.refused.length} refused, ${summary.asked.length} asked; run ${runId}`);
  return summary;
}

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false, dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") dry = true;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
  }
  if (!repo) throw new Error("missing --repo");
  if (apply && dry) throw new Error("--apply and --dry-run exclude each other");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  "merge-ask": {
    summary: "merge-ask: ask the Merge? decisions that are due in every repo (writes decisions only)",
    run(): void {
      const ids = askMergeDecisions(connect());
      console.log(`${ids.length} Merge? decisions asked`);
    },
  },
  merge: {
    summary: "merge --repo R [--limit N] [--apply]: merge queued PRs that may merge, ask Merge? for the rest (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runMerge(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  queue: {
    summary: "queue [--repo R]: the merge queue with each PR's state and verification",
    run(args: string[]): void {
      const i = args.indexOf("--repo");
      const q = buildQueue(connect(), { repo: i >= 0 ? args[i + 1] : undefined });
      const c = countStates(q);
      console.log(QUEUE_STATES.map((s) => `${s}: ${c[s]}`).join(", "));
      for (const e of q) console.log(`${refOf(e)}\t${e.state}\t${e.verdict}\t${e.size}\t${e.label ?? "-"}\t${e.ci}\t${e.mergeable}\t${e.verify?.state ?? "-"}\t${e.refusedReason ?? e.outsideRule.join("; ")}`);
    },
  },
};
