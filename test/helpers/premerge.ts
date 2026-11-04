// Fixture: a stored pre-merge review with no findings, so the merge queue treats the head as reviewed.
import type { DatabaseSync } from "node:sqlite";
import { savePremerge } from "../../src/premerge/store.ts";

export function seedPremergeClean(db: DatabaseSync, repo: string, number: number, head: string, at = "2026-01-01T00:00:00.000Z"): void {
  savePremerge(db, { repo, number, head, at, runId: "premerge-test", model: "test", findings: [], searched: "" });
}
