// Similar items and semantic search over the item embeddings that
// `craft-auto embed` writes. The vectors live in memory (src/embed/vectors.ts);
// the query text of a search, and an item that has no vector yet, are embedded
// here with the same model.
import type { DatabaseSync } from "node:sqlite";
import type { SimilarHit } from "../../../web/src/api/types.ts";
import type { Embedder } from "../../embed/model.ts";
import { itemText } from "../../embed/text.ts";
import { VectorIndex, type Hit } from "../../embed/vectors.ts";
import { HttpError } from "../server/util.ts";
import { latestRun, settledOf } from "../../classify/settled.ts";
import type { Req } from "../types.ts";
import { itemState } from "./decisions.ts";

const REASON: Record<string, SimilarHit["stateReason"]> = { COMPLETED: "completed", NOT_PLANNED: "not-planned", DUPLICATE: "duplicate" };

function limitOf(req: Req, def: number): number {
  const l = Number(req.query.get("limit") ?? def);
  return Number.isInteger(l) && l > 0 ? Math.min(l, 50) : def;
}

function describe(db: DatabaseSync, hits: Hit[]): SimilarHit[] {
  const row = db.prepare("SELECT kind, title, author, state, state_reason FROM items WHERE repo = ? AND number = ?");
  const run = latestRun(db);
  const out: SimilarHit[] = [];
  for (const h of hits) {
    const r = row.get(h.repo, h.number) as { kind: string; title: string | null; author: string | null; state: string; state_reason: string | null } | undefined;
    if (!r) continue;
    const l = settledOf(db, h.repo, h.number, run);
    out.push({
      repo: h.repo, number: h.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author ?? "",
      state: itemState(r.state), score: Math.round(h.score * 1000) / 1000,
      stateReason: REASON[r.state_reason ?? ""] ?? null, label: l.label, labelBy: l.source,
    });
  }
  return out;
}

async function embedOne(index: VectorIndex, text: string, role: "item" | "query"): Promise<Float32Array> {
  try {
    return (await index.embedder.embed([text], role))[0]!;
  } catch (e) {
    console.error(`embedding model unavailable: ${(e as Error).message}`);
    throw new HttpError(503, "The embedding model is not available on the server.");
  }
}

function needVectors(db: DatabaseSync, index: VectorIndex): void {
  index.refresh(db);
  if (!index.size) throw new HttpError(503, "No item embeddings yet: run craft-auto embed.");
}

export async function similar(db: DatabaseSync, req: Req, index: VectorIndex): Promise<SimilarHit[]> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  const it = db.prepare("SELECT title, body FROM items WHERE repo = ? AND number = ?").get(repo, n) as { title: string | null; body: string | null } | undefined;
  if (!it) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  needVectors(db, index);
  const q = index.vectorOf(db, repo, n) ?? await embedOne(index, itemText(it.title, it.body), "item");
  return describe(db, index.nearest(db, q, limitOf(req, 10), `${repo}#${n}`));
}

export async function semanticSearch(db: DatabaseSync, req: Req, index: VectorIndex): Promise<SimilarHit[]> {
  const q = (req.query.get("q") ?? "").trim().slice(0, 500);
  if (!q) return [];
  needVectors(db, index);
  return describe(db, index.nearest(db, await embedOne(index, q, "query"), limitOf(req, 20)));
}
