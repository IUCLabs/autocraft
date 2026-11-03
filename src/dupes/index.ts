// Duplicates stage: finds issues and PRs that describe the same bug or request,
// within one repo, among open items and items closed in the last year. Runs
// after Embed and before Decide; items it holds as duplicates wait out the later
// stages (src/dupes/held.ts). Reads the local database and calls models; writes
// nothing to GitHub. The close itself is the act step.
//
//   craft-auto dupes [--limit N] [--dry-run]
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../db.ts";
import { embedderId, localEmbedder, modelName } from "../embed/model.ts";
import { VectorIndex } from "../embed/vectors.ts";
import { checkPairs, defaultCheckDeps, uncheckedPairs, type CheckDeps } from "./check.ts";
import { applyDuplicateAnswers, askDuplicateDecisions, duplicateAskTargets } from "./decide.ts";
import { scanItem, scanPending } from "./scan.ts";
import { pilotSqlFor } from "../pilot.ts";

export { duplicateCount, duplicateHeld, notHeldSql } from "./held.ts";

/** Pairs checked per job unless the step's limit says otherwise. */
export const DEFAULT_LIMIT = 2000;
/** Items whose neighbours are looked up in one run. */
const SCAN_MAX = 5000;

export type DupesParams = {
  /** Most pairs to send to a model in this run. */
  limit?: number;
  dryRun?: boolean;
  onHandled?: (n: number) => void;
};
export type DupesDeps = { index: VectorIndex; check: CheckDeps };
export type DupesSummary = {
  scanned: number; pairsAdded: number; checked: number; jev: number; haiku: number; verdicts: Record<string, number>;
  unanswered: number; asked: string[]; answersApplied: number; dryRun: boolean;
};

export function defaultDeps(db: DatabaseSync): DupesDeps {
  return { index: new VectorIndex(localEmbedder({ name: modelName(), threads: 1 })), check: defaultCheckDeps(db) };
}

/** Work left: items to scan, pairs to check, decisions to ask or apply. Reads only, for the autopilot. */
export function dupesWork(db: DatabaseSync, modelId: string = embedderId(modelName())): boolean {
  if (scanPending(db, modelId, 1).length || uncheckedPairs(db, 1).length) return true;
  const answered = db.prepare(`SELECT 1 FROM decisions WHERE kind = 'duplicate' AND answer IS NOT NULL AND answer <> 'close' AND applied_at IS NULL AND ${pilotSqlFor("repo", "number")} LIMIT 1`).get();
  if (answered) return true;
  // Asked-but-unanswered ones need no job: asking again only refreshes them.
  const asked = db.prepare("SELECT 1 FROM decisions WHERE id = ?");
  return duplicateAskTargets(db).some((t) => !asked.get(t.id));
}

export async function runDupes(db: DatabaseSync, params: DupesParams = {}, log: (line: string) => void = console.log, deps?: DupesDeps): Promise<DupesSummary> {
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const limit = params.limit ?? DEFAULT_LIMIT;
  const d = deps ?? defaultDeps(db);
  const s: DupesSummary = { scanned: 0, pairsAdded: 0, checked: 0, jev: 0, haiku: 0, verdicts: {}, unanswered: 0, asked: [], answersApplied: 0, dryRun: !!params.dryRun };
  const at = () => d.check.now();
  const todo = scanPending(db, d.index.embedder.id, SCAN_MAX);
  if (params.dryRun) {
    s.scanned = todo.length;
    log(`dupes: ${todo.length} items to scan, ${uncheckedPairs(db, limit).length} pairs to check; dry run, nothing written`);
    return s;
  }
  s.answersApplied = applyDuplicateAnswers(db, at().toISOString());
  if (todo.length) {
    await d.index.ready(db);
    for (const it of todo) {
      s.pairsAdded += scanItem(db, d.index, it, at());
      s.scanned++;
    }
    log(`dupes: scanned ${s.scanned} items, ${s.pairsAdded} new pairs`);
  }
  const keys = uncheckedPairs(db, limit);
  if (keys.length) {
    const c = await checkPairs(db, keys, d.check, params.onHandled);
    Object.assign(s, { checked: c.checked, jev: c.jev, haiku: c.haiku, verdicts: c.verdicts, unanswered: c.unanswered });
    log(`dupes: ${keys.length} pairs sent (${c.jev} to Jev, ${c.haiku} answered by Haiku): ${Object.entries(c.verdicts).map(([k, n]) => `${n} ${k}`).join(", ") || "no verdicts"}`);
  }
  s.asked = askDuplicateDecisions(db, undefined, at().toISOString());
  log(`dupes: ${s.asked.length} duplicate decisions asked, ${s.answersApplied} answers applied`);
  return s;
}

function parseArgs(args: string[]): DupesParams {
  const p: DupesParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") p.dryRun = true;
    else if (a === "--limit" && args[i + 1] !== undefined) p.limit = Number(args[++i]);
    else throw new Error(`unknown or incomplete option ${a}; usage: dupes [--limit N] [--dry-run]`);
  }
  return p;
}

export const commands = {
  dupes: {
    summary: "dupes [--limit N] [--dry-run]: find duplicate issues and PRs (Jev, then Haiku) and ask Close-as-duplicate decisions",
    async run(args: string[]): Promise<void> {
      const db = connect();
      const r = await runDupes(db, parseArgs(args), (l) => console.error(l));
      console.log(JSON.stringify(r));
    },
  },
};
