// Decisions for people. The pipeline asks them with the CLI; only a signed-in
// person on the dashboard answers them, so no command here sets an answer.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "./db.ts";

export const KINDS = ["scope", "duplicate", "close", "merge", "split", "other"] as const;
export type Kind = (typeof KINDS)[number];

export type Option = { key: string; label: string };
export type Ref = { repo: string; number: number };
export type Exception = Ref & { answer: string };

export type DecisionRow = {
  id: string; kind: Kind; repo: string | null; number: number | null; items: string | null;
  question: string; context: string | null; facts: string | null; options: string;
  recommended: string | null; public_text: string | null; asked_at: string; asked_by: string | null;
  docket: string | null; answer: string | null; answer_note: string | null; exceptions: string | null;
  answered_by: string | null; answered_at: string | null; applied_at: string | null;
};

const j = <T>(s: string | null, d: T): T => {
  if (!s) return d;
  try { return JSON.parse(s) as T; } catch { return d; }
};
export const optionsOf = (d: DecisionRow): Option[] => j<Option[]>(d.options, []);
export const factsOf = (d: DecisionRow): string[] => j<string[]>(d.facts, []);
export const itemsOf = (d: DecisionRow): Ref[] => (d.number === null ? j<Ref[]>(d.items, []) : [{ repo: d.repo!, number: d.number }]);
export const exceptionsOf = (d: DecisionRow): Exception[] => j<Exception[]>(d.exceptions, []);
export const isBatch = (d: DecisionRow): boolean => d.number === null;
export const reposOf = (d: DecisionRow): string[] => [...new Set(itemsOf(d).map((r) => r.repo).concat(d.repo ? [d.repo] : []))].sort();

export function getDecision(db: DatabaseSync, id: string): DecisionRow | undefined {
  return db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined;
}

const ASK_FIELDS = ["kind", "repo", "number", "items", "question", "context", "facts", "options", "recommended", "public_text", "asked_at", "asked_by", "docket"] as const;

// Validates one question from the pipeline and returns the column values.
export function validateAsk(q: Record<string, unknown>): Record<string, string | number | null> {
  const err = (m: string) => new Error(`decision ${String(q.id ?? "?")}: ${m}`);
  if (typeof q.id !== "string" || !q.id) throw err("id is required");
  if (!KINDS.includes(q.kind as Kind)) throw err(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof q.question !== "string" || !q.question.trim()) throw err("question is required");
  const options = q.options as Option[];
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 || !options.every((o) => typeof o?.key === "string" && typeof o?.label === "string"))
    throw err("options must be 2–4 {key, label}");
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
    facts: JSON.stringify(facts), options: JSON.stringify(options.map((o) => ({ key: o.key, label: o.label }))),
    recommended: (q.recommended as string) ?? null, public_text: typeof q.public_text === "string" ? q.public_text : null,
    asked_at: typeof q.asked_at === "string" ? q.asked_at : new Date().toISOString(),
    asked_by: typeof q.asked_by === "string" ? q.asked_by : null, docket: typeof q.docket === "string" ? q.docket : null,
  };
}

// Inserts or updates the question by id; answer columns are never touched.
export function ask(db: DatabaseSync, questions: Record<string, unknown>[]): { inserted: number; updated: number } {
  const rows = questions.map(validateAsk);
  const cols = ["id", ...ASK_FIELDS];
  const stmt = db.prepare(`INSERT INTO decisions (${cols.join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})
    ON CONFLICT(id) DO UPDATE SET ${ASK_FIELDS.map((c) => `${c} = excluded.${c}`).join(", ")}`);
  const exists = db.prepare("SELECT 1 FROM decisions WHERE id = ?");
  let inserted = 0, updated = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (exists.get(r.id as string)) updated++; else inserted++;
      stmt.run(r);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { inserted, updated };
}

function list(args: string[]): void {
  const which = args.includes("--all") ? "all" : args.includes("--answered") ? "answered" : "open";
  const ri = args.indexOf("--repo");
  const repo = ri >= 0 ? args[ri + 1] : undefined;
  const where = [which === "open" ? "answer IS NULL" : which === "answered" ? "answer IS NOT NULL" : "1"];
  if (repo) where.push("(repo = :repo OR items LIKE :like)");
  const params: Record<string, string> = {};
  if (repo) Object.assign(params, { repo, like: `%"repo":"${repo}"%` });
  const rows = connect().prepare(`SELECT * FROM decisions WHERE ${where.join(" AND ")} ORDER BY asked_at`).all(params) as DecisionRow[];
  for (const d of rows) {
    const target = isBatch(d) ? `batch of ${itemsOf(d).length}` : `${d.repo}#${d.number}`;
    const state = d.answer ? `answered ${d.answer}${d.applied_at ? ", applied" : ""}` : "open";
    console.log(`${d.id}\t${d.kind}\t${target}\t${state}\t${d.question}`);
  }
}

function show(args: string[]): void {
  const id = args[0];
  if (!id) throw new Error("usage: decisions show <id>");
  const d = getDecision(connect(), id);
  if (!d) throw new Error(`no decision ${id}`);
  // answer_note is shown here: the CLI runs only on the host.
  const out = { ...d, items: j(d.items, null), facts: factsOf(d), options: optionsOf(d), exceptions: j(d.exceptions, null) };
  console.log(JSON.stringify(out, null, 2));
}

function askCmd(args: string[]): void {
  const file = args[0];
  if (!file) throw new Error("usage: decisions ask <file.json>  (one object or an array)");
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const qs = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  for (const q of qs) {
    if (q && typeof q === "object" && ["answer", "answer_note", "answered_by", "answered_at", "exceptions", "applied_at"].some((k) => k in q))
      throw new Error(`decision ${String(q.id)}: the CLI cannot set answers`);
  }
  const r = ask(connect(), qs);
  console.log(`${r.inserted} asked, ${r.updated} updated`);
}

const SUB: Record<string, (args: string[]) => void> = { list, show, ask: askCmd };

export const commands = {
  decisions: {
    summary: "decisions for people: list [--open|--answered|--all] [--repo R] | show ID | ask FILE.json (answers come only from the dashboard)",
    run(args: string[]): void {
      const [sub, ...rest] = args;
      const fn = sub ? SUB[sub] : undefined;
      if (!fn) {
        console.log("usage: craft-auto decisions list|show|ask ...");
        process.exit(sub ? 1 : 0);
      }
      fn(rest);
    },
  },
};
