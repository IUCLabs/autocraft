// Duplicate groups and their decisions. Items joined by duplicate pairs form a
// group; the group keeps one canonical item (canonical.ts) and every other open
// member gets one "Close #x as a duplicate of #y?" decision pointing at it, so a
// chain a~b~c never closes b as a duplicate of an item that is itself closing.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { actionable, ask, factsOf, getDecision } from "../decisions.ts";
import { pickCanonical } from "./canonical.ts";
import { DUP_FACT, DUP_OPTIONS } from "./held.ts";

const ACTOR = "dupes";

type Edge = { repo: string; a: number; b: number; similarity: number; jev_p: number | null; haiku: string | null };
export type Info = { number: number; kind: string; state: string; title: string | null; comments_count: number | null };

/** Duplicate pairs whose items still have the checked text. */
export function duplicateEdges(db: DatabaseSync, repo?: string): Edge[] {
  return db.prepare(`SELECT p.repo, p.a, p.b, p.similarity, p.jev_p, p.haiku FROM duplicate_pairs p
    JOIN items ia ON ia.repo = p.repo AND ia.number = p.a AND ia.embed_hash = p.a_hash
    JOIN items ib ON ib.repo = p.repo AND ib.number = p.b AND ib.embed_hash = p.b_hash
    WHERE p.verdict = 'duplicate' AND p.by_operator = 0 ${repo ? "AND p.repo = ?" : ""} ORDER BY p.repo, p.a, p.b`).all(...(repo ? [repo] : [])) as Edge[];
}

export type Group = { repo: string; canonical: number; why: string; members: number[]; edges: Edge[] };

export function duplicateGroups(db: DatabaseSync, repo?: string): Group[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const edges = duplicateEdges(db, repo);
  for (const e of edges) {
    for (const n of [e.a, e.b]) if (!parent.has(`${e.repo}#${n}`)) parent.set(`${e.repo}#${n}`, `${e.repo}#${n}`);
    parent.set(find(`${e.repo}#${e.a}`), find(`${e.repo}#${e.b}`));
  }
  const by = new Map<string, Edge[]>();
  for (const e of edges) by.set(find(`${e.repo}#${e.a}`), [...(by.get(find(`${e.repo}#${e.a}`)) ?? []), e]);
  return [...by.values()].map((es) => {
    const members = [...new Set(es.flatMap((e) => [e.a, e.b]))].sort((x, y) => x - y);
    const c = pickCanonical(db, es[0]!.repo, members);
    return { repo: es[0]!.repo, canonical: c.number, why: c.why, members, edges: es };
  });
}

export const decisionId = (repo: string, x: number, y: number): string => `${repo}#${x}:duplicate@${y}`;

const clip = (s: string | null, n = 110): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const kindWord = (i: Info) => (i.kind === "pr" ? "PR" : "issue");
const stateWord = (i: Info) => i.state === "OPEN" ? "open" : i.state === "MERGED" ? "merged" : "closed";

/** Group members that still need a duplicate question: open, not answered, no other open question. Shared by the asker and the autopilot's work check. */
export function duplicateAskTargets(db: DatabaseSync, repo?: string): { g: Group; x: number; id: string; xi: Info; y: Info }[] {
  const info = db.prepare("SELECT number, kind, state, title, comments_count FROM items WHERE repo = ? AND number = ?");
  const openElsewhere = db.prepare("SELECT 1 FROM decisions WHERE kind = 'duplicate' AND repo = ? AND number = ? AND answer IS NULL AND id <> ?");
  const out: { g: Group; x: number; id: string; xi: Info; y: Info }[] = [];
  for (const g of duplicateGroups(db, repo)) {
    const y = info.get(g.repo, g.canonical) as Info;
    for (const x of g.members) {
      if (x === g.canonical) continue;
      const xi = info.get(g.repo, x) as Info;
      if (xi.state !== "OPEN") continue;
      const id = decisionId(g.repo, x, g.canonical);
      if (getDecision(db, id)?.answer) continue;
      if (openElsewhere.get(g.repo, x, id)) continue;
      out.push({ g, x, id, xi, y });
    }
  }
  return out;
}

/** Asks the decisions for the groups of one repo (every repo when omitted). Returns the ids asked or refreshed. */
export function askDuplicateDecisions(db: DatabaseSync, repo: string | undefined, at: string): string[] {
  const qs: Record<string, unknown>[] = [];
  for (const { g, x, id, xi, y } of duplicateAskTargets(db, repo)) {
      // The pair's own check when there is one, else the member's strongest.
      const mine = g.edges.filter((e) => e.a === x || e.b === x);
      const e = mine.find((m) => m.a === g.canonical || m.b === g.canonical) ?? mine.sort((p, q) => q.similarity - p.similarity)[0]!;
      const jev = e.jev_p === null ? "Jev: no answer" : `Jev: ${e.jev_p.toFixed(2)} same`;
      qs.push({
        id, kind: "duplicate", repo: g.repo, number: x,
        question: `Close #${x} as a duplicate of #${g.canonical}?`,
        context: `The models judge #${x} and #${g.canonical} to describe the same bug or request. #${g.canonical} stays because ${g.why}.`,
        facts: [
          `#${x} (${kindWord(xi)}, ${stateWord(xi)}, ${xi.comments_count ?? 0} comments): ${clip(xi.title)}`,
          `#${g.canonical} (${kindWord(y)}, ${stateWord(y)}, ${y.comments_count ?? 0} comments): ${clip(y.title)}`,
          `similarity ${e.similarity.toFixed(2)}; ${jev}; Haiku: ${e.haiku ?? "not asked"}`,
          `${DUP_FACT}${g.repo}#${g.canonical}`,
        ],
        options: Object.values(DUP_OPTIONS).map((o) => ({ ...o })),
        recommended: e.jev_p !== null && e.jev_p >= 0.9 ? "close" : null,
        asked_by: ACTOR, asked_at: at,
      });
  }
  if (qs.length) ask(db, qs);
  return qs.map((q) => q.id as string);
}

/**
 * Operator answers "not a duplicate" and "keep both": the pair is stored as distinct for good, and the
 * decision is applied. "Close as duplicate" is applied by the act step.
 */
export function applyDuplicateAnswers(db: DatabaseSync, at: string): number {
  let n = 0;
  for (const a of actionable(db)) {
    if (a.kind !== "duplicate" || a.number === null || a.repo === null || a.answer === "close") continue;
    const d = getDecision(db, a.id)!;
    const f = factsOf(d).find((x) => x.startsWith(DUP_FACT))?.slice(DUP_FACT.length);
    const m = f ? /^([\w.-]+)#(\d+)$/.exec(f) : null;
    if (a.answer === "distinct" || a.answer === "keep") {
      if (m) {
        const [lo, hi] = [Math.min(a.number, Number(m[2])), Math.max(a.number, Number(m[2]))];
        db.prepare("UPDATE duplicate_pairs SET verdict = 'distinct', by_operator = 1 WHERE repo = ? AND a = ? AND b = ?").run(a.repo, lo, hi);
        // A pair not stored yet (or stored at other text) still must never be asked again.
        db.prepare(`INSERT OR IGNORE INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, verdict, by_operator, created_at, checked_at)
          SELECT ?, ?, ?, ia.embed_hash, ib.embed_hash, 0, 'distinct', 1, ?, ? FROM items ia, items ib
          WHERE ia.repo = ? AND ia.number = ? AND ib.repo = ? AND ib.number = ?`).run(a.repo, lo, hi, at, at, a.repo, lo, a.repo, hi);
      }
    }
    db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(at, a.id);
    audit(db, ACTOR, "duplicate-answer", `${a.repo}#${a.number}`, { decision: a.id, answer: a.answer });
    n++;
  }
  return n;
}
