// Per-repo setting: how many PRs the Sonnet first pass puts in one call (1 = one PR per call).
// Stored in settings under `review_batch_size:<repo>`; absent means the default of DEFAULT_CAPS.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { DEFAULT_CAPS, type Caps } from "./batch.ts";

export const MAX_BATCH_SIZE = 50;
const key = (repo: string) => `review_batch_size:${repo}`;

/** The repo's PRs-per-call setting, or null when it uses the default. */
export function batchSizeOf(db: DatabaseSync, repo: string): number | null {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key(repo)) as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Caps for the repo's first-pass calls: `base` with the repo's PRs-per-call setting applied. */
export function reviewCaps(db: DatabaseSync, repo: string, base: Caps = DEFAULT_CAPS): Caps {
  const n = batchSizeOf(db, repo);
  return n === null ? base : { ...base, perCall: n };
}

/** Sets the PRs per call (null restores the default). Returns false when nothing changed. */
export function setBatchSize(db: DatabaseSync, by: string, repo: string, size: number | null): boolean {
  if (!db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new Error(`${repo} is not tracked`);
  if (size !== null && !(Number.isInteger(size) && size >= 1 && size <= MAX_BATCH_SIZE)) throw new Error(`the batch size is a whole number from 1 to ${MAX_BATCH_SIZE}`);
  if (batchSizeOf(db, repo) === size) return false;
  if (size === null) db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  else db.prepare("INSERT OR REPLACE INTO main.settings (key, value) VALUES (?, ?)").run(key(repo), String(size));
  audit(db, by, "review-batch-size", repo, { size });
  return true;
}
