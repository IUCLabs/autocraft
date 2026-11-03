// Which PRs the Opus review looks at: every wanted PR (src/review/candidates.ts) with no Opus
// verdict at its current head commit, or whose verdict there is older than a comment or review by someone else.
import type { DatabaseSync } from "node:sqlite";
import { selectCandidates, type Size } from "./candidates.ts";

export type OpusCandidate = {
  repo: string; number: number; title: string; body: string; author_association: string | null;
  head_oid: string; lines_changed: number; size: Size; score: number | null;
};

/** Wanted PRs of `repo` still to review, highest work score first. */
export function selectOpusCandidates(db: DatabaseSync, repo: string): OpusCandidate[] {
  return selectCandidates(db, repo).map((c) => ({
    repo: c.repo, number: c.number, title: c.title, body: c.body, author_association: c.author_association,
    head_oid: c.head_oid, lines_changed: c.lines_changed, size: c.size, score: c.score ?? null,
  }));
}
