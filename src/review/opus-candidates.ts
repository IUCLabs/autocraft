// Which PRs the Opus review pass looks at: Sonnet's take or take-fix at the
// current head commit, no Opus row (review or skip) for that head, or an Opus review older than Sonnet's at that head.
import type { DatabaseSync } from "node:sqlite";
import { notHeldSql } from "../dupes/held.ts";
import { headOf, sizeOf, type Size } from "./candidates.ts";
import type { SonnetView } from "./opus-parse.ts";

export type OpusCandidate = {
  repo: string; number: number; title: string; body: string; author_association: string | null;
  head_oid: string; lines_changed: number; size: Size; score: number | null; sonnet: SonnetView;
};

type Row = {
  repo: string; number: number; title: string | null; body: string | null; author_association: string | null;
  head_oid: string | null; updated_at: string | null; is_draft: number | null; additions: number | null; deletions: number | null;
  c_head: string | null; c_state: string | null; c_draft: number | null; c_at: string | null; score: number | null;
  r_head: string; r_at: string; verdict: string; reason: string; fixes: string | null; risks: string | null;
};

const list = <T>(s: string | null): T[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
};

/**
 * Open, non-draft PRs of `repo` whose Sonnet review at the current head is take or take-fix and
 * that have no Opus review or skip record at that head, highest work score first.
 */
export function selectOpusCandidates(db: DatabaseSync, repo: string): OpusCandidate[] {
  const rows = db.prepare(`SELECT i.repo, i.number, i.title, i.body, i.author_association, i.head_oid, i.updated_at, i.is_draft, i.additions, i.deletions,
      c.head_oid AS c_head, c.state AS c_state, c.is_draft AS c_draft, c.fetched_at AS c_at, p.score AS score,
      r.head_oid AS r_head, r.at AS r_at, r.verdict, r.reason, r.fixes, r.risks
    FROM items i JOIN reviews r ON r.repo = i.repo AND r.number = i.number AND r.verdict IN ('take', 'take-fix')
    LEFT JOIN pr_checks c ON c.repo = i.repo AND c.number = i.number
    LEFT JOIN item_rank p ON p.repo = i.repo AND p.number = i.number
    WHERE i.repo = ? AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notHeldSql("i")}
    ORDER BY p.score IS NULL, p.score DESC, i.number`).all(repo) as Row[];
  // A verdict older than Sonnet's review at the same head is out of date: Sonnet read newer discussion. A skip-list row has no verdict and stays.
  const rowsAt = new Map(rows.map((r) => [`${r.number}@${r.r_head}`, r.r_at]));
  const done = new Set((db.prepare("SELECT number, head_oid, at, verdict FROM opus_reviews WHERE repo = ?").all(repo) as { number: number; head_oid: string; at: string; verdict: string | null }[])
    .map((o) => ({ ...o, key: `${o.number}@${o.head_oid}` })).filter((o) => o.verdict === null || !rowsAt.get(o.key) || o.at >= rowsAt.get(o.key)!).map((o) => o.key));
  const out: OpusCandidate[] = [];
  for (const r of rows) {
    const fresh = r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    if (fresh ? r.c_state !== "OPEN" || r.c_draft : r.is_draft) continue;
    const head = headOf(r);
    if (!head || head !== r.r_head || done.has(`${r.number}@${head}`)) continue;
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    out.push({
      repo: r.repo, number: r.number, title: r.title ?? "", body: r.body ?? "", author_association: r.author_association, head_oid: head,
      lines_changed: lines, size: sizeOf(lines), score: r.score,
      sonnet: { verdict: r.verdict, reason: r.reason, fixes: list(r.fixes), risks: list(r.risks) },
    });
  }
  return out;
}
