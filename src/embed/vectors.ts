// The dashboard's in-memory copy of the item vectors: loaded on first use,
// reloaded when `item_embeddings` or the tracked repos change, searched by brute
// force (dot products of unit vectors = cosine similarity).
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./model.ts";
import { fromBlob } from "./store.ts";

export type Hit = { repo: string; number: number; score: number };

// How often a request may check the table for changes.
const CHECK_MS = 5000;

export class VectorIndex {
  private keys: { repo: string; number: number }[] = [];
  private at = new Map<string, number>();
  private vecs = new Float32Array(0);
  private signature = "";
  private checked = 0;

  readonly embedder: Embedder;

  constructor(embedder: Embedder) {
    this.embedder = embedder;
  }

  get size(): number {
    return this.keys.length;
  }

  // Loads the vectors, or reloads them when the table changed (checked at most every CHECK_MS).
  refresh(db: DatabaseSync): void {
    const now = Date.now();
    if (this.signature && now - this.checked < CHECK_MS) return;
    this.checked = now;
    const s = db.prepare(`SELECT (SELECT COUNT(*) FROM main.item_embeddings) AS n, (SELECT MAX(rowid) FROM main.item_embeddings) AS m,
      (SELECT group_concat(name) FROM main.tracked_repos) AS t`).get() as { n: number; m: number | null; t: string | null };
    const sig = `${s.n}|${s.m}|${s.t}`;
    if (sig === this.signature) return;
    const rows = db.prepare(`SELECT repo, number, vec FROM main.item_embeddings
      WHERE model = ? AND repo IN (SELECT name FROM main.tracked_repos)`).all(this.embedder.id) as { repo: string; number: number; vec: Uint8Array }[];
    const dim = this.embedder.dim;
    const vecs = new Float32Array(rows.length * dim);
    const keys: typeof this.keys = [];
    const at = new Map<string, number>();
    for (const r of rows) {
      if (r.vec.byteLength !== dim * 4) continue;
      vecs.set(fromBlob(r.vec), keys.length * dim);
      at.set(`${r.repo}#${r.number}`, keys.length);
      keys.push({ repo: r.repo, number: r.number });
    }
    this.vecs = vecs.subarray(0, keys.length * dim);
    this.keys = keys;
    this.at = at;
    this.signature = sig;
  }

  vectorOf(db: DatabaseSync, repo: string, number: number): Float32Array | undefined {
    this.refresh(db);
    const i = this.at.get(`${repo}#${number}`);
    if (i === undefined) return undefined;
    const dim = this.embedder.dim;
    return this.vecs.slice(i * dim, (i + 1) * dim);
  }

  // The `limit` items closest to `q`, best first, leaving out `skip` ("repo#n").
  nearest(db: DatabaseSync, q: Float32Array, limit: number, skip?: string): Hit[] {
    this.refresh(db);
    const dim = this.embedder.dim;
    const v = this.vecs;
    const skipAt = skip === undefined ? -1 : (this.at.get(skip) ?? -1);
    const top: { i: number; s: number }[] = [];
    let floor = -Infinity;
    for (let i = 0, off = 0; i < this.keys.length; i++, off += dim) {
      if (i === skipAt) continue;
      let s = 0;
      for (let d = 0; d < dim; d++) s += v[off + d]! * q[d]!;
      if (top.length >= limit && s <= floor) continue;
      let j = top.length;
      while (j > 0 && top[j - 1]!.s < s) j--;
      top.splice(j, 0, { i, s });
      if (top.length > limit) top.pop();
      if (top.length >= limit) floor = top[top.length - 1]!.s;
    }
    return top.map(({ i, s }) => ({ ...this.keys[i]!, score: s }));
  }
}
