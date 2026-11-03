// Which open items become scope decisions.
//
// An item is a candidate when it is open, not a draft, in a tracked repo, has a
// Jev or Haiku verdict in the run, and either
// - its settled classification carries the "needs decision" flag, or
// - it is unsettled because Jev and Haiku chose different scope labels
//   (missing feature, small extra, plugin candidate): that is a scope call too.
// Items already covered are skipped: any open decision on the item, any scope
// decision on it (answered ones too), or a stage row past "classified".
import { fastScoreSql } from "../fasttrack.ts";
import { notHeldSql } from "../dupes/held.ts";
import type { DatabaseSync } from "node:sqlite";
import { trackedNames } from "../repos.ts";
import { needsDecisionOf, settle, type Settled } from "../classify/settled.ts";

export const SCOPE_LABELS = ["missing feature", "small extra", "plugin candidate"] as const;
export const isScope = (l: string | null): boolean => l !== null && (SCOPE_LABELS as readonly string[]).includes(l);

export type Reason = "needs-decision" | "scope-disagreement";

export type Candidate = { repo: string; number: number; reason: Reason; settled: Settled };

const json = <T>(s: string | null, d: T): T => {
  try { return s ? (JSON.parse(s) as T) : d; } catch { return d; }
};

export function latestJevRun(db: DatabaseSync): string | null {
  const r = db.prepare("SELECT run_id FROM classifications WHERE classifier IN ('jev', 'haiku') ORDER BY at DESC LIMIT 1").get() as { run_id: string } | undefined;
  return r?.run_id ?? null;
}

/** Why an item would become a decision, or null. */
export function reasonOf(s: Settled): Reason | null {
  if (s.status === "settled" && s.flags.includes("needs decision")) return "needs-decision";
  if (s.status === "disagree" && isScope(s.jevLabel) && isScope(s.haikuLabel)) return "scope-disagreement";
  return null;
}

/** Refs ("repo#n") that already have a decision or a stage past classification. */
function covered(db: DatabaseSync): Set<string> {
  const out = new Set<string>();
  const rows = db.prepare(`SELECT repo, number, items FROM decisions WHERE (answer IS NULL OR kind = 'scope' OR answer = 'backlog') AND id NOT LIKE '%:dupegroup:%'`).all() as
    { repo: string | null; number: number | null; items: string | null }[];
  for (const d of rows) {
    if (d.number !== null) out.add(`${d.repo}#${d.number}`);
    else for (const r of json<{ repo: string; number: number }[]>(d.items, [])) out.add(`${r.repo}#${r.number}`);
  }
  const stages = db.prepare(`SELECT repo, number, stage FROM item_stage WHERE stage <> 'classified'`).all() as { repo: string; number: number; stage: string }[];
  for (const s of stages) out.add(`${s.repo}#${s.number}`);
  return out;
}

type Row = { repo: string; number: number; jl: string | null; jf: string | null; probs: string | null; hl: string | null; hf: string | null };

/** Candidates in the given repos (default: every tracked repo), pull requests before issues, oldest first. */
export function selectCandidates(db: DatabaseSync, run: string, repos?: string[]): Candidate[] {
  const tracked = new Set(trackedNames(db));
  const want = (repos?.length ? repos : [...tracked]).filter((r) => tracked.has(r));
  if (!want.length) return [];
  const skip = covered(db);
  const rows = db.prepare(`SELECT k.repo, k.number, j.type_label AS jl, j.flags AS jf, j.probs, h.type_label AS hl, h.flags AS hf
    FROM (SELECT repo, number FROM classifications WHERE run_id = :run AND classifier IN ('jev', 'haiku') GROUP BY repo, number) k
    JOIN items i ON i.repo = k.repo AND i.number = k.number
    LEFT JOIN item_rank p ON p.repo = k.repo AND p.number = k.number
    LEFT JOIN classifications j ON j.repo = k.repo AND j.number = k.number AND j.classifier = 'jev' AND j.run_id = :run
    LEFT JOIN classifications h ON h.repo = k.repo AND h.number = k.number AND h.classifier = 'haiku' AND h.run_id = :run
    WHERE i.state = 'OPEN' AND COALESCE(i.is_draft, 0) = 0
      AND k.repo IN (SELECT value FROM json_each(:repos)) AND ${notHeldSql("i")}
    ORDER BY ${fastScoreSql("i.repo", "i.number", "p.score")} IS NULL, ${fastScoreSql("i.repo", "i.number", "p.score")} DESC, i.kind = 'pr' DESC, i.created_at, k.repo, k.number`).all({ run, repos: JSON.stringify(want) }) as Row[];
  const out: Candidate[] = [];
  for (const r of rows) {
    if (skip.has(`${r.repo}#${r.number}`)) continue;
    const top = json<{ top?: unknown } | null>(r.probs, null)?.top;
    const s = settle(
      r.jl === null ? null : { label: r.jl, flags: json<string[]>(r.jf, []), top: typeof top === "number" ? top : null, nd: needsDecisionOf(r.probs) },
      r.hl === null ? null : { label: r.hl, flags: json<string[]>(r.hf, []) },
    );
    const reason = reasonOf(s);
    if (reason) out.push({ repo: r.repo, number: r.number, reason, settled: s });
  }
  return out;
}
