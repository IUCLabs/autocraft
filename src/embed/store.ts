// Embedding new and changed items into `item_embeddings`. Each batch commits on
// its own, so an interrupted run loses at most one batch and the next run picks
// up where it stopped.
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./model.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { itemText } from "./text.ts";

export type Todo = { repo: string; number: number; text: string; hash: string };

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

// Tracked items whose text or model differs from the stored vector (every
// tracked item with `all`), shortest text first so batches pad little.
export function pending(db: DatabaseSync, modelId: string, all = false): Todo[] {
  fillEmbedHashes(db);
  // The first query runs on covering indexes; only the rows that differ are read in full.
  const diff = db.prepare(`SELECT i.repo, i.number, i.embed_hash AS hash FROM main.items i
    LEFT JOIN main.item_embeddings e ON e.repo = i.repo AND e.number = i.number
    WHERE i.repo IN (SELECT name FROM main.tracked_repos)
      AND (:all OR e.model IS NOT :model OR e.hash IS NOT i.embed_hash)`).all({ all: all ? 1 : 0, model: modelId }) as unknown as
    { repo: string; number: number; hash: string }[];
  const get = db.prepare("SELECT title, body FROM main.items WHERE repo = ? AND number = ?");
  return diff.map((r) => {
    const t = get.get(r.repo, r.number) as { title: string | null; body: string | null };
    return { repo: r.repo, number: r.number, text: itemText(t.title, t.body), hash: r.hash };
  }).sort((a, b) => a.text.length - b.text.length);
}

// Vectors of items that left the mirror or the tracked repos.
export function prune(db: DatabaseSync): number {
  return Number(db.prepare(`DELETE FROM main.item_embeddings WHERE repo NOT IN (SELECT name FROM main.tracked_repos)
    OR NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = item_embeddings.repo AND i.number = item_embeddings.number)`).run().changes);
}

export type Progress = { done: number; total: number; ms: number };

export async function embedItems(db: DatabaseSync, embedder: Embedder,
  opts: { all?: boolean; batch?: number; onProgress?: (p: Progress) => void } = {}): Promise<{ embedded: number; pruned: number; ms: number }> {
  const start = performance.now();
  const pruned = prune(db);
  const todo = pending(db, embedder.id, opts.all);
  const size = opts.batch ?? 32;
  const put = db.prepare(`INSERT OR REPLACE INTO main.item_embeddings (repo, number, model, hash, vec, at) VALUES (?,?,?,?,?,?)`);
  let done = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const vecs = await embedder.embed(batch.map((t) => t.text), "item");
    const at = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      batch.forEach((t, k) => put.run(t.repo, t.number, embedder.id, t.hash, toBlob(vecs[k]!), at));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    done += batch.length;
    opts.onProgress?.({ done, total: todo.length, ms: performance.now() - start });
  }
  return { embedded: done, pruned, ms: performance.now() - start };
}
