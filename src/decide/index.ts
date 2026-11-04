// Decide stage: open items that need a maintainer's scope call become
// dashboard decisions, each with a short AI summary and a recommendation
// from one Opus call.
//
// runDecide() is the step the runner registers; `autocraft decide` runs it
// from a shell. Idempotent: items with a decision or a later stage are
// skipped, so a re-run or an interrupted run asks only what is still missing.
import type { DatabaseSync } from "node:sqlite";
import type { Item } from "../classify/parse.ts";
import { loadItems } from "../classify/run.ts";
import { connect } from "../db.ts";
import { trackedNames } from "../repos.ts";
import { buildDecision } from "./decision.ts";
import { recommend, recommendIds } from "./recommend.ts";
import { type Candidate, type Reason } from "./select.ts";
import { latestRun, settledLookup } from "../classify/settled.ts";
import { scopeReason } from "../core/decide-item.ts";
import { plannedItems } from "../core/select-items.ts";

export type DecideParams = {
  /** Repo names; empty or missing means every tracked repo. */
  repos?: string[];
  /** Most decisions to create in this run. */
  limit?: number;
  dryRun?: boolean;
  /** Classification run; default the one with the newest Jev verdict. */
  run?: string;
  /** Called with the running count of items sent to the model. */
  onSent?: (n: number) => void;
  /** Read-only checkout of a repo's default branch for the recommendation call, or null to ask without tools. Default: fetched from GitHub. */
  checkout?: (repo: string) => Promise<string | null>;
  /** PR diffs for the item block of a conversation the recommendation starts. Default: the diff cache or GitHub. */
  diff?: (repo: string, number: number, head: string) => Promise<string | null>;
};

/** Most Opus calls (new decisions plus recommendations for open ones) per run when no limit is given. */
const DEFAULT_LIMIT = 50;

export type RepoCount = { candidates: number; needsDecision: number; scopeDisagreement: number; asked: number; noSummary: number };
export type DecideResult = { run: string | null; dryRun: boolean; byRepo: Record<string, RepoCount>; asked: number; noSummary: number; recommended: number; usageRun: string | null };

export type Log = (line: string) => void;

const now = () => new Date().toISOString();

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
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  // New decisions and recommendations for open ones share one budget.
  const total = params.limit ?? DEFAULT_LIMIT;
  const tracked = new Set(trackedNames(db));
  const untracked = (params.repos ?? []).filter((r) => !tracked.has(r));
  if (untracked.length) throw new Error(`not tracked: ${untracked.join(", ")}`);
  const run = params.run ?? latestRun(db);
  const result: DecideResult = { run, dryRun: !!params.dryRun, byRepo: {}, asked: 0, noSummary: 0, recommended: 0, usageRun: null };
  const picked: Candidate[] = [];
  if (!run) log("decide: no classification run with Jev verdicts");
  else {
    const lookup = settledLookup(db, run);
    const all: Candidate[] = plannedItems(db, "decide", { run, bucket: "new" })
      .filter((p) => !params.repos?.length || params.repos.includes(p.facts.repo))
      .map((p) => ({ repo: p.facts.repo, number: p.facts.number, reason: scopeReason(p.facts)!, settled: lookup(p.facts.repo, p.facts.number) }));
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
  const fresh = picked.map((c) => ({ ...buildDecision(db, c) }));
  // New decisions first, then open ones that never had a model recommendation, within the step's limit.
  const room = Math.max(0, total - picked.length);
  const ids = recommendIds(db).slice(0, room);
  if (fresh.length || ids.length) {
    result.usageRun = usageRun;
    const r = await recommend(db, [...fresh, ...ids], {
      checkout: params.checkout ?? ((repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo))),
      diff: params.diff ?? ((r, n, h) => import("../conversations/run.ts").then((m) => m.githubDiff(r, n, h))),
      usageRun, log, onSent: () => params.onSent?.(++sent),
    });
    result.recommended = r.stored;
    const repoOf = new Map(fresh.map((q) => [q.id, q.repo]));
    for (const id of r.asked) count(result.byRepo, repoOf.get(id)!).asked++;
    for (const ref of r.noSummary) count(result.byRepo, ref.slice(0, ref.lastIndexOf("#"))).noSummary++;
  }
  for (const n of Object.values(result.byRepo)) { result.asked += n.asked; result.noSummary += n.noSummary; }
  log(`decide: asked ${result.asked} decisions; ${result.noSummary} items without a summary; ${result.recommended} recommendations`);
  return result;
}

function parseArgs(args: string[]): DecideParams {
  const p: DecideParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if (a === "--dry-run") { p.dryRun = true; continue; }
    if (v === undefined || !["--repo", "--limit", "--run"].includes(a)) throw new Error(`unknown or incomplete option ${a}; usage: decide [--repo R ...] [--limit N] [--run ID] [--dry-run]`);
    i++;
    if (a === "--repo") (p.repos ??= []).push(v);
    else if (a === "--limit") p.limit = Number(v);
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
    summary: `decide [--repo R ...] [--limit N] [--run ID] [--dry-run]: ask scope decisions with AI summaries and recommendations`,
    async run(args: string[]): Promise<void> {
      const r = await runDecide(connect(), parseArgs(args), (l) => console.error(l));
      console.log(table(r));
    },
  },
};
