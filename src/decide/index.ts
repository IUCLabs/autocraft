// Decide stage: open items that need a maintainer's scope call become
// dashboard decisions, each with a short AI summary.
//
// runDecide() is the step the runner registers; `craft-auto decide` runs it
// from a shell. Idempotent: items with a decision or a later stage are
// skipped, so a re-run or an interrupted run asks only what is still missing.
import type { DatabaseSync } from "node:sqlite";
import { refOf, parseSummaryReply, type Item } from "../classify/parse.ts";
import { claudeRoom } from "../agents/call.ts";
import { askClaude, loadItems, pool, saveUsage, type Usage } from "../classify/run.ts";
import { connect } from "../db.ts";
import { ask } from "../decisions.ts";
import { trackedNames } from "../repos.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { buildDecision } from "./decision.ts";
import { backfillIds, recommend } from "./recommend.ts";
import { latestJevRun, selectCandidates, type Candidate, type Reason } from "./select.ts";

const PROMPT = CLAUDE_PROMPTS["decide.summary"];

export const DECIDE_MODELS = PROMPT.models as readonly string[];

export type DecideParams = {
  /** Repo names; empty or missing means every tracked repo. */
  repos?: string[];
  /** Most decisions to create in this run. */
  limit?: number;
  dryRun?: boolean;
  /** Model for the summaries, one of DECIDE_MODELS; default the prompt's first. */
  model?: string;
  /** Classification run; default the one with the newest Jev verdict. */
  run?: string;
  /** Called with the running count of items sent to the model. */
  onSent?: (n: number) => void;
  /** Read-only checkout of a repo's default branch for the recommendation call, or null to ask without tools. Default: fetched from GitHub. */
  checkout?: (repo: string) => Promise<string | null>;
};

/** Most summary items plus recommendation calls per run when no limit is given. */
const DEFAULT_LIMIT = 50;

export type RepoCount = { candidates: number; needsDecision: number; scopeDisagreement: number; asked: number; noSummary: number };
export type DecideResult = { run: string | null; dryRun: boolean; byRepo: Record<string, RepoCount>; asked: number; noSummary: number; recommended: number; usageRun: string | null };

export type Log = (line: string) => void;

const now = () => new Date().toISOString();
const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0) });

/** Items with their GitHub labels and first non-bot comments, for the summary prompt. */
export function loadSummaryItems(db: DatabaseSync, refs: { repo: string; number: number }[]): Item[] {
  const labels = db.prepare("SELECT labels FROM items WHERE repo = ? AND number = ?");
  const comments = db.prepare(`SELECT author, body FROM comments WHERE repo = ? AND number = ? AND COALESCE(TRIM(body), '') <> ''
    AND COALESCE(author, '') NOT LIKE '%[bot]' ORDER BY created_at LIMIT 3`);
  return loadItems(db, refs).map((i) => {
    let l: unknown = [];
    try { l = JSON.parse((labels.get(i.repo, i.number) as { labels: string | null }).labels ?? "[]"); } catch { /* none */ }
    return {
      ...i, labels: Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [],
      comments: comments.all(i.repo, i.number) as { author: string | null; body: string }[],
    };
  });
}

function count(byRepo: Record<string, RepoCount>, repo: string): RepoCount {
  return (byRepo[repo] ??= { candidates: 0, needsDecision: 0, scopeDisagreement: 0, asked: 0, noSummary: 0 });
}

export async function runDecide(db: DatabaseSync, params: DecideParams = {}, log: Log = console.log): Promise<DecideResult> {
  const model = params.model ?? PROMPT.models[0]!;
  if (!DECIDE_MODELS.includes(model)) throw new Error(`model must be one of ${DECIDE_MODELS.join(", ")}`);
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  // Summary items and recommendation calls share one budget.
  const total = params.limit ?? DEFAULT_LIMIT;
  const tracked = new Set(trackedNames(db));
  const untracked = (params.repos ?? []).filter((r) => !tracked.has(r));
  if (untracked.length) throw new Error(`not tracked: ${untracked.join(", ")}`);
  const run = params.run ?? latestJevRun(db);
  const result: DecideResult = { run, dryRun: !!params.dryRun, byRepo: {}, asked: 0, noSummary: 0, recommended: 0, usageRun: null };
  const picked: Candidate[] = [];
  if (!run) log("decide: no classification run with Jev verdicts");
  else {
    const all = selectCandidates(db, run, params.repos);
    picked.push(...all.slice(0, total));
    const reasonKey: Record<Reason, "needsDecision" | "scopeDisagreement"> = { "needs-decision": "needsDecision", "scope-disagreement": "scopeDisagreement" };
    for (const c of picked) {
      const n = count(result.byRepo, c.repo);
      n.candidates++;
      n[reasonKey[c.reason]]++;
    }
    log(`decide: run ${run}, ${all.length} items need a scope decision, ${picked.length} in this run${params.dryRun ? " (dry run)" : ""}`);
  }
  if (params.dryRun) return result;

  const usageRun = `decide-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  let sent = 0;
  const askedIds: string[] = [];
  if (picked.length) await summarise(db, picked, model, usageRun, result, askedIds, (n) => { sent = n; params.onSent?.(n); }, log);

  // New decisions first, then open ones that never had a model recommendation, within the step's limit.
  const room = Math.max(0, total - picked.length);
  const first = askedIds.slice(0, room);
  const ids = [...first, ...backfillIds(db, room - first.length).filter((id) => !first.includes(id))];
  if (picked.length || ids.length) result.usageRun = usageRun;
  if (ids.length) {
    result.recommended = await recommend(db, ids, {
      checkout: params.checkout ?? ((repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo))),
      usageRun, log, onSent: () => params.onSent?.(++sent),
    });
  }
  for (const n of Object.values(result.byRepo)) { result.asked += n.asked; result.noSummary += n.noSummary; }
  log(`decide: asked ${result.asked} decisions; ${result.noSummary} items without a summary; ${result.recommended} recommendations`);
  return result;
}

async function summarise(db: DatabaseSync, picked: Candidate[], model: string, usageRun: string, result: DecideResult, askedIds: string[], onSent: (n: number) => void, log: Log): Promise<void> {
  // Batches stay within one repo so token use can be counted per repo.
  const byRepo = new Map<string, Candidate[]>();
  for (const c of picked) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c]);
  const batches: Candidate[][] = [];
  for (const cs of byRepo.values()) for (let i = 0; i < cs.length; i += PROMPT.limits.perCall) batches.push(cs.slice(i, i + PROMPT.limits.perCall));
  const stage = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'needs-decision', ?, 'decide', ?)");
  let sent = 0;
  await pool(batches.map((batch, b) => async () => {
    const repo = batch[0]!.repo, start = now();
    sent += batch.length;
    onSent(sent);
    const items = loadSummaryItems(db, batch);
    const cand = new Map(batch.map((c) => [refOf(c), c]));
    let usage = zero(), done = 0;
    let todo = items;
    for (let attempt = 0; attempt < PROMPT.limits.attempts && todo.length; attempt++) {
      const reply = await askClaude("decide.summary", model, todo, db);
      if (!reply) continue;
      usage = add(usage, reply.usage);
      const { summaries, missing } = parseSummaryReply(reply.text, todo.map(refOf));
      const at = now();
      const qs = summaries.map((s) => ({ ...buildDecision(db, cand.get(s.ref)!), asked_at: at, summary: s.summary, summary_by: model, summary_at: at }));
      if (qs.length) {
        ask(db, qs);
        for (const q of qs) { stage.run(q.repo, q.number, at, `scope decision ${q.id}`); askedIds.push(q.id); }
        done += qs.length;
      }
      todo = todo.filter((i) => missing.includes(refOf(i)));
    }
    const n = count(result.byRepo, repo);
    n.asked += done;
    n.noSummary += todo.length;
    if (todo.length) log(`decide: no valid summary for ${todo.map(refOf).join(", ")}; the next run retries them`);
    saveUsage(db, usageRun, `decide-${String(b).padStart(3, "0")}`, "decide", model, done, usage, start, now());
  }), () => claudeRoom(db), { first: true });
}

function parseArgs(args: string[]): DecideParams {
  const p: DecideParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if (a === "--dry-run") { p.dryRun = true; continue; }
    if (v === undefined || !["--repo", "--limit", "--model", "--run"].includes(a)) throw new Error(`unknown or incomplete option ${a}; usage: decide [--repo R ...] [--limit N] [--model ${DECIDE_MODELS.join("|")}] [--run ID] [--dry-run]`);
    i++;
    if (a === "--repo") (p.repos ??= []).push(v);
    else if (a === "--limit") p.limit = Number(v);
    else if (a === "--model") p.model = v;
    else p.run = v;
  }
  return p;
}

function table(r: DecideResult): string {
  const rows = Object.entries(r.byRepo).sort(([a], [b]) => a.localeCompare(b));
  const head = r.dryRun ? "repo\tdecisions\tneeds decision\tscope disagreement" : "repo\tcandidates\tasked\tno summary";
  return [head, ...rows.map(([repo, n]) => r.dryRun ? `${repo}\t${n.candidates}\t${n.needsDecision}\t${n.scopeDisagreement}` : `${repo}\t${n.candidates}\t${n.asked}\t${n.noSummary}`)].join("\n");
}

export const commands = {
  decide: {
    summary: `decide [--repo R ...] [--limit N] [--model ${DECIDE_MODELS.join("|")}] [--run ID] [--dry-run]: ask scope decisions with AI summaries`,
    async run(args: string[]): Promise<void> {
      const r = await runDecide(connect(), parseArgs(args), (l) => console.error(l));
      console.log(table(r));
    },
  },
};
