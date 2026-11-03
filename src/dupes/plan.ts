// Duplicate groups and their comparison sets. Items joined by duplicate pairs form
// a group; the members of one kind (PRs, issues) are compared together in one call
// (compare.ts), and the stored result is current while no member's state, head
// commit or text hash has changed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pickCanonical } from "./canonical.ts";
import { inPilot } from "../pilot.ts";

type Edge = { repo: string; a: number; b: number; similarity: number; jev_p: number | null; haiku: string | null };

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

export type Kind = "pr" | "issue";
export type Member = { number: number; kind: Kind; state: string; title: string | null; head_oid: string | null; embed_hash: string | null; comments_count: number | null };

/** The members of one kind of a group: what one comparison covers. */
export type KindSet = { repo: string; kind: Kind; key: string; members: Member[]; hash: string };

export const setKey = (kind: Kind, numbers: number[]): string => `${kind}:${[...numbers].sort((a, b) => a - b).join(",")}`;

/** Changes whenever a member's state, head commit or text does. */
export function setHash(members: Member[]): string {
  const rows = [...members].sort((a, b) => a.number - b.number).map((m) => [m.number, m.state, m.head_oid, m.embed_hash]);
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}

export function kindSetsOf(db: DatabaseSync, g: Group): KindSet[] {
  const get = db.prepare("SELECT number, kind, state, title, head_oid, embed_hash, comments_count FROM items WHERE repo = ? AND number = ?");
  const members = g.members.map((n) => get.get(g.repo, n) as Member | undefined).filter((m): m is Member => !!m);
  return (["pr", "issue"] as const).flatMap((kind) => {
    const ms = members.filter((m) => m.kind === kind);
    return ms.length ? [{ repo: g.repo, kind, key: setKey(kind, ms.map((m) => m.number)), members: ms, hash: setHash(ms) }] : [];
  });
}

export type StoredComparison = {
  repo: string; key: string; kind: Kind; members: number[]; hash: string; kept: number; source: "model" | "closed" | "rule" | "single";
  model: string | null; reason: string | null; result: ComparisonResult | null; error: string | null; at: string;
};
/** The per-member answers of a comparison, in the shape of the prompt replies. */
export type ComparisonResult = {
  others: { number: number; duplicate?: boolean; better?: string[]; carry?: string[]; adds?: string[]; via?: number }[];
  rounds: number;
};

export function storedComparison(db: DatabaseSync, repo: string, key: string): StoredComparison | null {
  const r = db.prepare("SELECT * FROM dupe_comparisons WHERE repo = ? AND key = ?").get(repo, key) as
    (Omit<StoredComparison, "members" | "result"> & { members: string; result: string | null }) | undefined;
  if (!r) return null;
  let result: ComparisonResult | null = null;
  try { result = r.result ? (JSON.parse(r.result) as ComparisonResult) : null; } catch { /* no result */ }
  return { ...r, members: JSON.parse(r.members) as number[], result };
}

export function saveComparison(db: DatabaseSync, c: StoredComparison): void {
  db.prepare(`INSERT OR REPLACE INTO dupe_comparisons (repo, key, kind, members, hash, kept, source, model, reason, result, error, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.repo, c.key, c.kind, JSON.stringify(c.members), c.hash, c.kept, c.source, c.model, c.reason, c.result ? JSON.stringify(c.result) : null, c.error, c.at);
}

/** The stored comparison of the set when it is current. */
export const currentComparison = (db: DatabaseSync, s: KindSet): StoredComparison | null => {
  const c = storedComparison(db, s.repo, s.key);
  return c && c.hash === s.hash ? c : null;
};

/** Sets that need a comparison: an open member is in the pilot and no current result is stored. */
export function dueSets(db: DatabaseSync, repo?: string): KindSet[] {
  const out: KindSet[] = [];
  for (const g of duplicateGroups(db, repo))
    for (const s of kindSetsOf(db, g))
      if (s.members.some((m) => m.state === "OPEN" && inPilot(db, s.repo, m.number)) && !currentComparison(db, s)) out.push(s);
  return out;
}
