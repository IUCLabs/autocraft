// Facts of open items (issues and PRs) for the triage steps: classification, priority, embedding, duplicates, scope decision, labels.
// Loaded in one pass for a whole database or a slice. Reads only: the old selectors fill missing hashes on the way; here a missing hash is computed.
import type { DatabaseSync } from "node:sqlite";
import { notOwnIntegrationSql, groupHeldSql, backlogHeldSql } from "../dupes/held.ts";
import { FAST_FLOOR, fastScoreSql } from "../fasttrack.ts";
import { latestRun, needsDecisionOf, securityOf, settle, topOf, SURE, type Referee } from "../classify/settled.ts";
import { JEV_FLAG_NO, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "../classify/parse.ts";
import { groupsToAsk } from "../dupes/decide.ts";
import { dueSets } from "../dupes/plan.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { classifyHash, SCHEME_ID } from "../itemhash.ts";
import { approvalOf as labelsApprovalOf } from "../labels/approval.ts";
import { pilotSql, pilotSqlFor } from "../pilot.ts";
import { scopeAnswers } from "../review/candidates.ts";
import type { ItemFacts } from "./plan.ts";

export type { ItemFacts } from "./plan.ts";

export type ItemLoadOptions = {
  repo?: string;
  /** Only these items, as "repo#number". */
  refs?: Iterable<string>;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The classification run (default: latestRun, the current run else the newest verdict run). */
  run?: string | null;
};

type Row = {
  repo: string; number: number; kind: "pr" | "issue"; title: string | null; is_draft: number | null; updated_at: string | null; labels: string | null;
  embed_hash: string | null; class_hash: string | null; class_scheme: string | null; score: number | null;
  in_pilot: number; not_integration: number; held_backlog: number; held_dup: number;
  pr_hash: string | null; e_hash: string | null; scan_hash: string | null; stage: string | null; attempt: string | null;
};

const SELECT = `SELECT i.repo, i.number, i.kind, i.title, i.is_draft, i.updated_at, i.labels, i.embed_hash, i.class_hash, i.class_scheme,
    ${fastScoreSql("i.repo", "i.number", "r.score")} AS score,
    ${pilotSql("i")} AS in_pilot, ${notOwnIntegrationSql("i")} AS not_integration, ${backlogHeldSql("i")} AS held_backlog,
    (EXISTS (SELECT 1 FROM decisions dh WHERE dh.kind = 'duplicate' AND dh.id NOT LIKE '%:dupegroup:%' AND dh.repo = i.repo AND dh.number = i.number AND (dh.answer IS NULL OR dh.answer = 'close'))
      OR ${groupHeldSql("i")}) AS held_dup,
    p.text_hash AS pr_hash, e.hash AS e_hash, s.hash AS scan_hash, st.stage, fa.state AS attempt
  FROM items i JOIN tracked_repos t ON t.name = i.repo
  LEFT JOIN item_rank r ON r.repo = i.repo AND r.number = i.number
  LEFT JOIN item_priority p ON p.repo = i.repo AND p.number = i.number
  LEFT JOIN item_embeddings e ON e.repo = i.repo AND e.number = i.number AND e.model = :model
  LEFT JOIN duplicate_scans s ON s.repo = i.repo AND s.number = i.number
  LEFT JOIN item_stage st ON st.repo = i.repo AND st.number = i.number
  LEFT JOIN fix_attempts fa ON fa.repo = i.repo AND fa.number = i.number
  WHERE i.state = 'OPEN'`;

const json = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const flagsOf = (s: string | null): string[] => { const f = json<unknown>(s, []); return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : []; };
const refsOf = (d: { repo: string | null; number: number | null; items: string | null }): string[] =>
  d.number !== null ? [`${d.repo}#${d.number}`] : json<{ repo: string; number: number }[]>(d.items, []).map((r) => `${r.repo}#${r.number}`);

type Cls = { classifier: string; at: string; type_label: string; flags: string | null; probs: string | null; input_hash: string | null };

/** Facts of every open item (issue or PR) of the tracked repos, for the database, repo or refs given. */
export function loadItemFacts(db: DatabaseSync, opts: ItemLoadOptions = {}): ItemFacts[] {
  const now = opts.now ?? Date.now();
  const model = embedderId(modelName());
  const params: Record<string, string> = { model };
  let where = "";
  if (opts.repo) { where += " AND i.repo = :repo"; params.repo = opts.repo; }
  if (opts.refs) { where += " AND i.repo || '#' || i.number IN (SELECT value FROM json_each(:refs))"; params.refs = JSON.stringify([...opts.refs]); }
  const rows = db.prepare(`${SELECT}${where} ORDER BY i.repo, i.number`).all(params) as Row[];

  // Values read once for all items.
  const run = opts.run !== undefined ? opts.run : latestRun(db);
  const byItem = new Map<string, Cls[]>();
  if (run) {
    for (const c of db.prepare("SELECT repo, number, classifier, at, type_label, flags, probs, input_hash FROM classifications WHERE run_id = ?").all(run) as (Cls & { repo: string; number: number })[]) {
      const k = `${c.repo}#${c.number}`;
      (byItem.get(k) ?? byItem.set(k, []).get(k)!).push(c);
    }
  }
  const answers = scopeAnswers(db);
  const operatorAnswers = scopeAnswers(db, true);
  const openScope = new Set<string>(), covered = new Set<string>(), recommend = new Map<string, { failures: number; failedAt: string | null }>();
  for (const d of db.prepare(`SELECT id, kind, repo, number, items, answer, recommended_by, recommend_failures, recommend_failed_at FROM decisions ORDER BY asked_at, id`).all() as
    { id: string; kind: string; repo: string | null; number: number | null; items: string | null; answer: string | null; recommended_by: string | null; recommend_failures: number | null; recommend_failed_at: string | null }[]) {
    const dupegroup = d.id.includes(":dupegroup:");
    if (d.kind === "scope" && d.answer === null) {
      for (const r of refsOf(d)) openScope.add(r);
      if (d.number !== null && d.recommended_by === null) { const k = `${d.repo}#${d.number}`; if (!recommend.has(k)) recommend.set(k, { failures: d.recommend_failures ?? 0, failedAt: d.recommend_failed_at }); }
    }
    if ((d.answer === null || d.kind === "scope" || d.answer === "backlog") && !dupegroup) for (const r of refsOf(d)) covered.add(r);
  }
  const labeled = new Map((db.prepare("SELECT repo, number, note FROM stages WHERE stage = 'labeled' ORDER BY at, rowid").all() as { repo: string; number: number; note: string | null }[])
    .map((s) => [`${s.repo}#${s.number}`, s.note]));
  const pairs = new Map<string, number>();
  for (const p of db.prepare(`SELECT p.repo, p.a, p.b FROM duplicate_pairs p
    JOIN items ia ON ia.repo = p.repo AND ia.number = p.a AND ia.embed_hash = p.a_hash
    JOIN items ib ON ib.repo = p.repo AND ib.number = p.b AND ib.embed_hash = p.b_hash
    WHERE p.verdict IS NULL AND (ia.state = 'OPEN' OR ib.state = 'OPEN') AND p.repo IN (SELECT name FROM tracked_repos)
      AND (${pilotSqlFor("p.repo", "p.a")} OR ${pilotSqlFor("p.repo", "p.b")})`).all() as { repo: string; a: number; b: number }[])
    for (const n of [p.a, p.b]) pairs.set(`${p.repo}#${n}`, (pairs.get(`${p.repo}#${n}`) ?? 0) + 1);
  // Group-level work (which groups to ask about, which sets to compare) is planned per group by dupes/decide.ts and dupes/plan.ts; the items carry its result.
  const inGroup = new Set(groupsToAsk(db, opts.repo).flatMap((g) => g.group.members.map((n) => `${g.repo}#${n}`)));
  const inCompare = new Set(dueSets(db, opts.repo, now).flatMap((s) => s.members.map((m) => `${s.repo}#${m.number}`)));
  const approved = new Map<string, boolean>();
  const labelsApproved = (repo: string) => approved.get(repo) ?? (approved.set(repo, labelsApprovalOf(db, repo) !== null), approved.get(repo)!);
  const body = db.prepare("SELECT repo, number, kind, title, body, additions, deletions, changed_files, author_association FROM items WHERE repo = ? AND number = ?");

  return rows.map((r): ItemFacts => {
    const ref = `${r.repo}#${r.number}`;
    const cls = byItem.get(ref) ?? [];
    const j = cls.find((c) => c.classifier === "jev");
    // A Haiku row without a Jev row counts only when Haiku classified alone (it carries the item's input hash).
    const h = cls.find((c) => c.classifier === "haiku" && (j || c.input_hash !== null));
    const s = cls.find((c) => c.classifier === "sonnet");
    let referee: Referee | null = null;
    if (s && j && h && s.at >= j.at && s.at >= h.at) {
      const sure = json<{ sure?: unknown } | null>(s.probs, null)?.sure;
      if (typeof sure === "boolean") referee = { label: s.type_label, sure, reason: "" };
    }
    const settled = settle(
      j ? { label: j.type_label, flags: flagsOf(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
      h ? { label: h.type_label, flags: flagsOf(h.flags) } : null,
      referee,
    );
    // The classifier's input hash: stored on the row, recomputed when it was made under another scheme.
    let classHash = r.class_scheme === SCHEME_ID ? r.class_hash : null;
    if (classHash === null && (j || h)) {
      const b = body.get(r.repo, r.number) as { repo: string; number: number; kind: string; title: string | null; body: string | null; additions: number | null; deletions: number | null; changed_files: number | null; author_association: string | null };
      classHash = classifyHash(b);
    }
    const unsureFlag = (key: string, yes: number): boolean => {
      const p = (json<Record<string, unknown> | null>(j?.probs ?? null, null) ?? {})[key];
      return typeof p === "number" && p >= JEV_FLAG_NO && p < yes;
    };
    const jev = j ? {
      at: j.at,
      changed: j.input_hash !== null ? j.input_hash !== classHash : (r.updated_at ?? "") > j.at,
      unsure: (topOf(j.probs) ?? 0) < SURE || unsureFlag("security", JEV_SECURITY_YES) || unsureFlag("needs_decision", JEV_NEEDS_DECISION_YES),
    } : null;
    const haiku = h ? { at: h.at, aloneCurrent: h.input_hash !== null && h.input_hash === classHash && (!j || h.at > j.at) } : null;
    const embedHash = r.embed_hash;
    const note = labeled.get(ref) ?? null;
    return {
      repo: r.repo, number: r.number, kind: r.kind, now, draft: !!r.is_draft,
      inScope: !!r.in_pilot, integration: !r.not_integration,
      held: r.held_backlog ? "backlog" : r.held_dup ? "duplicate" : null,
      fast: (r.score ?? 0) >= FAST_FLOOR, score: r.score, repoFacts: { labelsApproved: labelsApproved(r.repo) },
      run,
      classification: {
        status: settled.status, label: settled.label, flags: settled.flags, jevLabel: settled.jevLabel, haikuLabel: settled.haikuLabel,
        referee: settled.referee ? { sure: settled.referee.sure } : null, jev, haiku,
      },
      embedHash, embeddedHash: r.e_hash, priorityHash: r.pr_hash, scannedHash: r.scan_hash,
      pairsToCheck: pairs.get(ref) ?? 0, inGroupToAsk: inGroup.has(ref), inCompareSet: inCompare.has(ref),
      scope: { open: openScope.has(ref), answer: answers.get(ref) ?? null, covered: covered.has(ref), pastClassified: r.stage !== null && r.stage !== "classified", recommend: recommend.get(ref) ?? null },
      labels: { existing: json<unknown[]>(r.labels, []).map(String), pluginAnswer: operatorAnswers.get(ref) === "plugin", labeledNote: note },
      fixAttempt: r.attempt,
    };
  });
}

/** Facts of one open item, or null. */
export function loadItemFact(db: DatabaseSync, repo: string, number: number, opts: Omit<ItemLoadOptions, "repo" | "refs"> = {}): ItemFacts | null {
  return loadItemFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] })[0] ?? null;
}
