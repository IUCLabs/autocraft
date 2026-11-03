// Decisions for people. The pipeline asks them with the CLI; only a signed-in
// person on the dashboard answers them. The one command that sets answers is
// the operator's bulk Backlog (`decisions backlog`), which only holds items.
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";
import { connect } from "./db.ts";
import { inPilot } from "./pilot.ts";

export const KINDS = ["scope", "duplicate", "close", "merge", "split", "other"] as const;
export type Kind = (typeof KINDS)[number];

export type Option = { key: string; label: string; hint?: string };
export type Ref = { repo: string; number: number };
export type Exception = Ref & { answer: string };

export type DecisionRow = {
  id: string; kind: Kind; repo: string | null; number: number | null; items: string | null;
  question: string; context: string | null; facts: string | null; options: string;
  recommended: string | null; recommended_reason: string | null; recommended_by: string | null; public_text: string | null; asked_at: string; asked_by: string | null;
  docket: string | null; answer: string | null; answer_note: string | null; exceptions: string | null;
  answered_by: string | null; answered_at: string | null; applied_at: string | null;
  summary: string | null; summary_by: string | null; summary_at: string | null; adopted_opinion: string | null;
};

const j = <T>(s: string | null, d: T): T => {
  if (!s) return d;
  try { return JSON.parse(s) as T; } catch { return d; }
};
/** The answer every decision offers last: nothing is written to GitHub and the items stay held (see src/dupes/held.ts). */
export const BACKLOG: Option = { key: "backlog", label: "Backlog", hint: "Hold this undecided: nothing is written and no later step takes the item up." };
export const isBacklog = (answer: string | null): boolean => answer === BACKLOG.key;

/** The options the pipeline asked, then Backlog. */
export const optionsOf = (d: DecisionRow): Option[] => {
  const asked = j<Option[]>(d.options, []);
  return asked.some((o) => o.key === BACKLOG.key) ? asked : [...asked, BACKLOG];
};
export const factsOf = (d: DecisionRow): string[] => j<string[]>(d.facts, []);
export const itemsOf = (d: DecisionRow): Ref[] => (d.number === null ? j<Ref[]>(d.items, []) : [{ repo: d.repo!, number: d.number }]);
export const exceptionsOf = (d: DecisionRow): Exception[] => j<Exception[]>(d.exceptions, []);
export const isBatch = (d: DecisionRow): boolean => d.number === null;
export const reposOf = (d: DecisionRow): string[] => [...new Set(itemsOf(d).map((r) => r.repo).concat(d.repo ? [d.repo] : []))].sort();

export function getDecision(db: DatabaseSync, id: string): DecisionRow | undefined {
  return db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined;
}

const ASK_FIELDS = ["kind", "repo", "number", "items", "question", "context", "facts", "options", "recommended", "recommended_reason", "public_text", "asked_at", "asked_by", "docket", "summary", "summary_by", "summary_at"] as const;

// A re-ask without a summary keeps the one the decision has.
const SUMMARY_FIELDS: readonly string[] = ["summary", "summary_by", "summary_at"];

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// Validates one question from the pipeline and returns the column values.
export function validateAsk(q: Record<string, unknown>): Record<string, string | number | null> {
  const err = (m: string) => new Error(`decision ${String(q.id ?? "?")}: ${m}`);
  if (typeof q.id !== "string" || !q.id) throw err("id is required");
  if (!KINDS.includes(q.kind as Kind)) throw err(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof q.question !== "string" || !q.question.trim()) throw err("question is required");
  const options = q.options as Option[];
  if (!Array.isArray(options) || options.length < 2 || options.length > 5 ||
    !options.every((o) => typeof o?.key === "string" && typeof o?.label === "string" && (o.hint === undefined || typeof o.hint === "string")))
    throw err("options must be 2–5 {key, label, hint?}");
  if (new Set(options.map((o) => o.key)).size !== options.length) throw err("option keys must be unique");
  if (q.recommended != null && !options.some((o) => o.key === q.recommended)) throw err("recommended must be an option key");
  const facts = (q.facts ?? []) as unknown[];
  if (!Array.isArray(facts) || facts.length > 5 || !facts.every((f) => typeof f === "string")) throw err("facts must be up to five strings");
  const batch = q.number == null;
  let items: Ref[] | null = null;
  if (batch) {
    items = q.items as Ref[];
    if (!Array.isArray(items) || !items.length || !items.every((r) => typeof r?.repo === "string" && Number.isInteger(r?.number)))
      throw err("a batch needs items: [{repo, number}]");
  } else {
    if (typeof q.repo !== "string" || !Number.isInteger(q.number)) throw err("repo and number are required for one item");
  }
  const repo = typeof q.repo === "string" ? q.repo : batch && new Set(items!.map((r) => r.repo)).size === 1 ? items![0].repo : null;
  return {
    id: q.id, kind: q.kind as string, repo, number: batch ? null : (q.number as number),
    items: items ? JSON.stringify(items.map((r) => ({ repo: r.repo, number: r.number }))) : null,
    question: q.question.trim(), context: typeof q.context === "string" ? q.context : null,
    facts: JSON.stringify(facts), options: JSON.stringify(options.map((o) => ({ key: o.key, label: o.label, ...(o.hint ? { hint: o.hint } : {}) }))),
    recommended: (q.recommended as string) ?? null,
    // A reason without a recommendation would be shown with nothing to explain.
    recommended_reason: q.recommended ? str(q.recommended_reason) : null,
    public_text: typeof q.public_text === "string" ? q.public_text : null,
    asked_at: typeof q.asked_at === "string" ? q.asked_at : new Date().toISOString(),
    asked_by: typeof q.asked_by === "string" ? q.asked_by : null, docket: typeof q.docket === "string" ? q.docket : null,
    summary: str(q.summary), summary_by: str(q.summary_by), summary_at: str(q.summary_at),
  };
}

// Inserts or updates the question by id; answer columns are never touched, a re-ask replaces the recommendation along with its reason and clears its author, and neither is a summary the new question lacks.
export function ask(db: DatabaseSync, questions: Record<string, unknown>[], inTransaction = false): { inserted: number; updated: number } {
  const rows = questions.map(validateAsk);
  const cols = ["id", ...ASK_FIELDS];
  const stmt = db.prepare(`INSERT INTO decisions (${cols.join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})
    ON CONFLICT(id) DO UPDATE SET ${ASK_FIELDS.map((c) => SUMMARY_FIELDS.includes(c) ? `${c} = COALESCE(excluded.${c}, ${c})` : `${c} = excluded.${c}`).join(", ")}, recommended_by = NULL`);
  const exists = db.prepare("SELECT 1 FROM decisions WHERE id = ?");
  let inserted = 0, updated = 0;
  if (!inTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      if (exists.get(r.id as string)) updated++; else inserted++;
      stmt.run(r);
    }
    if (!inTransaction) db.exec("COMMIT");
  } catch (e) {
    if (!inTransaction) db.exec("ROLLBACK");
    throw e;
  }
  return { inserted, updated };
}

// Answers the pipeline may act on: answered by someone who is an operator
// (role operator) now, not yet applied, and not Backlog (which only holds). Option keys only, never free text.
// Opinions and comments are display-only and never read here.
export type Actionable = { id: string; kind: Kind; repo: string | null; number: number | null; items: Ref[]; answer: string; exceptions: Exception[] };

function operators(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT login FROM access WHERE role = 'operator'").all() as { login: string }[]).map((r) => r.login));
}

export function actionable(db: DatabaseSync): Actionable[] {
  const rows = db.prepare(`SELECT * FROM decisions WHERE answer IS NOT NULL AND answer <> '${BACKLOG.key}' AND applied_at IS NULL
    AND answered_by IN (SELECT login FROM access WHERE role = 'operator') ORDER BY answered_at`).all() as DecisionRow[];
  return rows.map((d) => ({
    id: d.id, kind: d.kind, repo: d.repo, number: d.number, items: itemsOf(d), answer: d.answer!,
    exceptions: exceptionsOf(d).map((e) => ({ repo: e.repo, number: e.number, answer: e.answer })),
  }));
}

export type BacklogScope = { outsidePilot?: boolean; repo?: string };
export type BacklogResult = { applied: boolean; decisions: { id: string; kind: Kind; repo: string | null; number: number | null }[] };

/** Open decisions in scope: of the repo when given, and, with `outsidePilot`, none of whose items is in the pilot (with no pilot set, none is outside). */
export function backlogCandidates(db: DatabaseSync, scope: BacklogScope): DecisionRow[] {
  if (!scope.outsidePilot && !scope.repo) throw new Error("name a scope: outsidePilot or a repo");
  const rows = db.prepare("SELECT * FROM decisions WHERE answer IS NULL ORDER BY asked_at, id").all() as DecisionRow[];
  const members = db.prepare("SELECT repo, number FROM dupe_group_items WHERE decision_id = ?");
  return rows.filter((d) => {
    const refs = [...itemsOf(d), ...(members.all(d.id) as Ref[])];
    if (scope.repo && !reposOf(d).includes(scope.repo) && !refs.some((x) => x.repo === scope.repo)) return false;
    // Outside the scope: no item in a repo whose pipeline is on and, with an item pilot, in that pilot.
    return !scope.outsidePilot || !refs.some((x) => inPilot(db, x.repo, x.number));
  });
}

/** Answers the open decisions in scope with Backlog and audits each; a dry run only lists them. The answer is written for `by`. */
export function backlogOpen(db: DatabaseSync, scope: BacklogScope, by: string, apply: boolean, at: string = new Date().toISOString()): BacklogResult {
  const rows = backlogCandidates(db, scope);
  const decisions = rows.map((d) => ({ id: d.id, kind: d.kind, repo: d.repo, number: d.number }));
  if (!apply) return { applied: false, decisions };
  db.exec("BEGIN IMMEDIATE");
  try {
    const set = db.prepare(`UPDATE decisions SET answer = ?, answer_note = NULL, exceptions = ?, answered_by = ?, answered_at = ?, adopted_opinion = NULL WHERE id = ? AND answer IS NULL`);
    for (const d of rows) {
      if (set.run(BACKLOG.key, isBatch(d) ? "[]" : null, by, at, d.id).changes === 1) audit(db, by, "answer", d.id, { answer: BACKLOG.key, bulk: true });
    }
    audit(db, by, "backlog-bulk", null, { ...scope, count: rows.length });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { applied: true, decisions };
}

/**
 * Withdraws open scope decisions in scope: deletes each with its opinions, comments, claims and the stages row Decide
 * wrote when it asked, so the item counts as never asked and Decide asks it again later. Other kinds are left alone
 * (their answers drive side tables). A dry run only lists them. Writes nothing to GitHub.
 */
export function withdrawOpen(db: DatabaseSync, scope: BacklogScope, by: string, apply: boolean): BacklogResult {
  const rows = backlogCandidates(db, scope).filter((d) => d.kind === "scope" && !isBatch(d) && d.repo !== null && d.number !== null);
  const decisions = rows.map((d) => ({ id: d.id, kind: d.kind, repo: d.repo, number: d.number }));
  if (!apply) return { applied: false, decisions };
  db.exec("BEGIN IMMEDIATE");
  try {
    const del = db.prepare("DELETE FROM decisions WHERE id = ? AND answer IS NULL");
    const side = ["decision_opinions", "decision_comments", "decision_claims"].map((t) => db.prepare(`DELETE FROM ${t} WHERE decision_id = ?`));
    const stage = db.prepare("DELETE FROM stages WHERE repo = ? AND number = ? AND stage = 'needs-decision' AND note = ?");
    // item_stage is kept by an insert trigger only, so it is rebuilt from the remaining stages rows.
    const latest = db.prepare("SELECT stage, at FROM stages WHERE repo = ? AND number = ? ORDER BY at DESC, rowid DESC LIMIT 1");
    const reviewed = db.prepare("SELECT 1 FROM stages WHERE repo = ? AND number = ? AND stage = 'reviewed' LIMIT 1");
    const put = db.prepare("UPDATE item_stage SET stage = ?, at = ?, reviewed = ? WHERE repo = ? AND number = ?");
    const drop = db.prepare("DELETE FROM item_stage WHERE repo = ? AND number = ?");
    for (const d of rows) {
      if (del.run(d.id).changes !== 1) continue;
      for (const s of side) s.run(d.id);
      stage.run(d.repo, d.number, `scope decision ${d.id}`);
      const l = latest.get(d.repo, d.number) as { stage: string; at: string } | undefined;
      if (l) put.run(l.stage, l.at, reviewed.get(d.repo, d.number) ? 1 : 0, d.repo, d.number);
      else drop.run(d.repo, d.number);
      audit(db, by, "withdraw", d.id, { repo: d.repo, number: d.number, question: d.question });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { applied: true, decisions };
}

function withdrawCmd(args: string[]): void {
  const ri = args.indexOf("--repo");
  const scope: BacklogScope = { outsidePilot: args.includes("--outside-pilot"), repo: ri >= 0 ? args[ri + 1] : undefined };
  if (ri >= 0 && !scope.repo) throw new Error("--repo needs a repo name");
  if (!scope.outsidePilot && !scope.repo) throw new Error("usage: decisions withdraw (--outside-pilot | --repo R) [--apply]");
  const apply = args.includes("--apply");
  const res = withdrawOpen(connect(), scope, userInfo().username, apply);
  for (const d of res.decisions) console.log(`${d.id}\t${d.repo}#${d.number}`);
  console.log(`${res.decisions.length} open scope decision${res.decisions.length === 1 ? "" : "s"} ${apply ? "withdrawn" : "would be withdrawn (dry run; --apply writes)"}`);
}

function backlogCmd(args: string[]): void {
  const ri = args.indexOf("--repo");
  const scope: BacklogScope = { outsidePilot: args.includes("--outside-pilot"), repo: ri >= 0 ? args[ri + 1] : undefined };
  if (ri >= 0 && !scope.repo) throw new Error("--repo needs a repo name");
  if (!scope.outsidePilot && !scope.repo) throw new Error("usage: decisions backlog (--outside-pilot | --repo R) [--apply]");
  const apply = args.includes("--apply");
  const res = backlogOpen(connect(), scope, userInfo().username, apply);
  for (const d of res.decisions) console.log(`${d.id}\t${d.kind}\t${d.repo ?? ""}${d.number === null ? "" : `#${d.number}`}`);
  console.log(`${res.decisions.length} open decision${res.decisions.length === 1 ? "" : "s"} ${apply ? "answered Backlog" : "would be answered Backlog (dry run; --apply writes)"}`);
}

function list(args: string[]): void {
  if (args.includes("--actionable")) {
    for (const a of actionable(connect())) console.log(JSON.stringify(a));
    return;
  }
  const which = args.includes("--all") ? "all" : args.includes("--answered") ? "answered" : "open";
  const ri = args.indexOf("--repo");
  const repo = ri >= 0 ? args[ri + 1] : undefined;
  const where = [which === "open" ? "answer IS NULL" : which === "answered" ? "answer IS NOT NULL" : "1"];
  if (repo) where.push("(repo = :repo OR items LIKE :like)");
  const params: Record<string, string> = {};
  if (repo) Object.assign(params, { repo, like: `%"repo":"${repo}"%` });
  const db = connect();
  const ops = operators(db);
  const rows = db.prepare(`SELECT * FROM decisions WHERE ${where.join(" AND ")} ORDER BY asked_at`).all(params) as DecisionRow[];
  for (const d of rows) {
    const target = isBatch(d) ? `batch of ${itemsOf(d).length}` : `${d.repo}#${d.number}`;
    const by = isBacklog(d.answer) || (d.answered_by && ops.has(d.answered_by)) ? "" : " (not actionable: not answered by an operator)";
    const state = d.answer ? `answered ${d.answer}${d.applied_at ? ", applied" : ""}${by}` : "open";
    console.log(`${d.id}\t${d.kind}\t${target}\t${state}\t${d.question}`);
  }
}

function show(args: string[]): void {
  const id = args[0];
  if (!id) throw new Error("usage: decisions show <id>");
  const db = connect();
  const d = getDecision(db, id);
  if (!d) throw new Error(`no decision ${id}`);
  // Agents run this command: no free text from people (answer_note), and
  // adopted_opinion points at an opinion, which agents never see.
  const { adopted_opinion: _adopted, answer_note: _note, ...rest } = d;
  const actionable = d.answer !== null && !isBacklog(d.answer) && d.answered_by !== null && operators(db).has(d.answered_by);
  const out = { ...rest, actionable, items: j(d.items, null), facts: factsOf(d), options: optionsOf(d), exceptions: j(d.exceptions, null) };
  console.log(JSON.stringify(out, null, 2));
}

function askCmd(args: string[]): void {
  const file = args[0];
  if (!file) throw new Error("usage: decisions ask <file.json>  (one object or an array)");
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const qs = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  for (const q of qs) {
    if (q && typeof q === "object" && ["answer", "answer_note", "answered_by", "answered_at", "exceptions", "applied_at", "adopted_opinion"].some((k) => k in q))
      throw new Error(`decision ${String(q.id)}: the CLI cannot set answers`);
  }
  const r = ask(connect(), qs);
  console.log(`${r.inserted} asked, ${r.updated} updated`);
}

const SUB: Record<string, (args: string[]) => void> = { list, show, ask: askCmd, backlog: backlogCmd, withdraw: withdrawCmd };

export const commands = {
  decisions: {
    summary: "decisions for people: list [--open|--answered|--all|--actionable] [--repo R] | show ID | ask FILE.json | backlog (--outside-pilot | --repo R) [--apply] | withdraw (--outside-pilot | --repo R) [--apply] (answers come from the dashboard; backlog is the operator bulk hold; withdraw deletes open scope decisions so Decide asks them again later)",
    run(args: string[]): void {
      const [sub, ...rest] = args;
      const fn = sub ? SUB[sub] : undefined;
      if (!fn) {
        console.log("usage: autocraft decisions list|show|ask|backlog|withdraw ...");
        process.exit(sub ? 1 : 0);
      }
      fn(rest);
    },
  },
};
