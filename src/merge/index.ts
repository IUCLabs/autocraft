// Stage 6, Integrate (first part): merges the queued PRs that may merge, one
// at a time, through the configured merge command, and asks a "Merge this PR?"
// decision for taken PRs the merge rule doesn't cover. No model calls.
//
//   craft-auto merge --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only, calls
// nothing and writes nothing.
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { connect } from "../db.ts";
import { actionable, ask, factsOf, getDecision } from "../decisions.ts";
import { Client, type Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { TIER_LABEL } from "../whitelist.ts";
import { buildQueue, countStates, eligible, HEAD_FACT, MERGE_OPTIONS, mergeDecisionId, QUEUE_STATES, type QueueEntry } from "./queue.ts";

export { buildQueue, countStates, QUEUE_STATES, type QueueEntry, type QueueState } from "./queue.ts";

const ORG = "storytold";
export const DEFAULT_MERGE_COMMAND = "safe-merge";
const ACTOR = "merge";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type MergeDeps = {
  querier: Querier;
  /** Runs the merge command; throws only when it can't be started. */
  run: (cmd: string, args: string[]) => Promise<CommandResult>;
  now: () => Date;
  /** `$CRAFT_AUTO_MERGE_CMD`, default `safe-merge`. */
  mergeCommand: string;
};

export type MergeParams = {
  repo: string;
  /** Most merges to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` merges, assigns or asks. */
  dryRun?: boolean;
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

export function spawnRun(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function defaultDeps(): MergeDeps {
  return { querier: new Client(1000), run: spawnRun, now: () => new Date(), mergeCommand: process.env.CRAFT_AUTO_MERGE_CMD || DEFAULT_MERGE_COMMAND };
}

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

// ---- GitHub reads and the one write this step makes itself (assignment) ----

type Viewer = { login: string; id: string };
const viewers = new WeakMap<Querier, Viewer>();

/** The pipeline's GitHub account, asked once per querier. */
async function viewerOf(q: Querier): Promise<Viewer> {
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

async function prInfo(q: Querier, repo: string, n: number): Promise<PrInfo | null> {
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

const ASSIGN = `mutation($id: ID!, $user: ID!) {
  addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;

// ---- decisions ---------------------------------------------------------------

/** The Merge? question for a take PR outside the rule; its facts carry the head commit. */
export function mergeQuestion(e: QueueEntry): Record<string, unknown> & { id: string } {
  const fixes = e.fixes ? `; ${e.fixes} fix${e.fixes === 1 ? "" : "es"} listed` : "";
  return {
    id: mergeDecisionId(e.repo, e.number, e.head), kind: "merge", repo: e.repo, number: e.number,
    question: "Merge this PR?",
    context: `The review says take, but the merge-without-asking rule doesn't cover it: ${e.outsideRule.join(", ")}.`,
    facts: [
      `size ${e.size}, label ${e.label ?? "not settled"}`,
      `author: ${e.author ?? "unknown"}, ${TIER_LABEL[e.tier]}`,
      `CI ${e.ci}, mergeable ${e.mergeable.toLowerCase()}`,
      `review: ${e.verdict}: ${e.reason}${fixes}`,
      `${HEAD_FACT}${e.head}`,
    ],
    options: Object.values(MERGE_OPTIONS).map((o) => ({ ...o })),
    recommended: "merge",
    asked_by: ACTOR,
  };
}

/** The head commit an answered Merge? decision was asked at, from its facts. */
export function answeredHead(db: DatabaseSync, id: string): string | null {
  const d = getDecision(db, id);
  const f = d ? factsOf(d).find((x) => x.startsWith(HEAD_FACT)) : undefined;
  return f ? f.slice(HEAD_FACT.length).trim() : null;
}

/** Merge? questions still to ask: take PRs outside the rule with no decision at their head. */
export const toAsk = (queue: QueueEntry[]): QueueEntry[] => queue.filter((e) => e.state === "needs-decision" && !e.decisionId);

// ---- the step ----------------------------------------------------------------

export async function runMerge(db: DatabaseSync, params: MergeParams, log: (line: string) => void = console.log, deps?: MergeDeps): Promise<MergeSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `merge-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const queue = buildQueue(db, { repo });
  const open = queue.filter((e) => e.state !== "merged");
  const states = countStates(queue);
  let picks = open.filter(eligible).sort((a, b) => (a.path === b.path ? a.number - b.number : a.path === "rule" ? -1 : 1));
  if (params.limit !== undefined) picks = picks.slice(0, params.limit);
  const ask1 = toAsk(open);
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
  const d = deps ?? defaultDeps();

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

  // What GitHub reported for the PR being tried, once known; a refusal records it so the autopilot retries only when it changes.
  let seen: { ci: string; mergeable: string } | null = null;
  const saveAttempt = (e: QueueEntry, method: string | null, outcome: "merged" | "refused", reason: string | null) =>
    db.prepare("INSERT INTO merges (repo, number, head_oid, run_id, at, path, method, outcome, reason, ci, mergeable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.repo, e.number, e.head, runId, at(), e.path!, method, outcome, reason, seen?.ci ?? e.ci, seen?.mergeable ?? e.mergeable);
  const refuse = (e: QueueEntry, method: string | null, reason: string) => {
    saveAttempt(e, method, "refused", reason);
    audit(db, ACTOR, "merge-refused", refOf(e), { run: runId, head: e.head, path: e.path, method, reason });
    summary.refused.push({ ref: refOf(e), reason });
    log(`  ${refOf(e)}: refused: ${reason}`);
  };

  // One PR at a time; any error that isn't a refusal stops the run.
  for (const e of picks) {
    summary.attempted.push(refOf(e));
    seen = null;
    const [ch] = await refreshChecks(db, d.querier, repo, [e.number]);
    if (ch) seen = { ci: ch.overall ?? "none", mergeable: ch.mergeable ?? "UNKNOWN" };
    if (!ch) { refuse(e, null, "GitHub returned no such PR"); continue; }
    if (ch.state !== "OPEN") { refuse(e, null, `no longer open on GitHub (${ch.state.toLowerCase()})`); continue; }
    if (ch.head_oid !== e.head) { refuse(e, null, `head moved from ${short(e.head)} to ${short(ch.head_oid)} since the review`); continue; }
    if (e.path === "operator") {
      const still = actionable(db).some((a) => a.id === e.decisionId && a.answer === MERGE_OPTIONS.merge.key);
      if (!still) { refuse(e, null, "the operator's merge answer is gone"); continue; }
      const h = answeredHead(db, e.decisionId!);
      if (h !== ch.head_oid) { refuse(e, null, `head moved since the operator's answer (${h ? short(h) : "no head recorded"} → ${short(ch.head_oid)})`); continue; }
    }
    if (ch.overall !== "success" || ch.mergeable !== "MERGEABLE") {
      refuse(e, null, `not ready at merge time: CI ${ch.overall}, mergeable ${(ch.mergeable ?? "unknown").toLowerCase()}`);
      continue;
    }
    const info = await prInfo(d.querier, repo, e.number);
    if (!info) { refuse(e, null, "GitHub returned no such PR"); continue; }
    if (info.head !== e.head) { refuse(e, null, `head moved from ${short(e.head)} to ${short(info.head)} since the review`); continue; }
    if (!info.assignees.length) {
      const me = await viewerOf(d.querier);
      await d.querier.query(ASSIGN, { id: info.id, user: me.id });
      audit(db, ACTOR, "assign", refOf(e), { run: runId, assignee: me.login });
      log(`  ${refOf(e)}: assigned to ${me.login}`);
    }
    const method = methodOf(info);
    const r = await d.run(d.mergeCommand, [`${ORG}/${repo}`, String(e.number), `--${method}`]);
    if (r.code !== 0) {
      const why = oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`;
      refuse(e, method, `${d.mergeCommand}: ${why}`);
      continue;
    }
    saveAttempt(e, method, "merged", null);
    stage.run(e.repo, e.number, "merged", at(), ACTOR, `${method} at ${short(e.head)}${e.path === "operator" ? ", operator answered merge" : ""}`);
    audit(db, ACTOR, "merge", refOf(e), { run: runId, head: e.head, path: e.path, method });
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
  merge: {
    summary: "merge --repo R [--limit N] [--apply]: merge queued PRs that may merge, ask Merge? for the rest (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runMerge(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  queue: {
    summary: "queue [--repo R]: the merge queue with each PR's state",
    run(args: string[]): void {
      const i = args.indexOf("--repo");
      const q = buildQueue(connect(), { repo: i >= 0 ? args[i + 1] : undefined });
      const c = countStates(q);
      console.log(QUEUE_STATES.map((s) => `${s}: ${c[s]}`).join(", "));
      for (const e of q) console.log(`${refOf(e)}\t${e.state}\t${e.verdict}\t${e.size}\t${e.label ?? "-"}\t${e.ci}\t${e.mergeable}\t${e.refusedReason ?? e.outsideRule.join("; ")}`);
    },
  },
};
