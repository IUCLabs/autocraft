// The work queue for the dashboard: every open item in work-score order with the parts of its score and its
// next pipeline step. Read-only, anyone signed in, limited to the repos the requester may see.
import type { DatabaseSync } from "node:sqlite";
import type { TypeLabel, WorkList, WorkRow } from "../../../web/src/api/types.ts";
import { latestRun, settledLookup } from "../../classify/settled.ts";
import { classifyListOf, factsOf, nextStepOf } from "../../rank/next.ts";
import type { RankBreakdown } from "../../rank/score.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { visibleRepos } from "./visible.ts";

type Row = { repo: string; number: number; kind: string; title: string | null; head_oid: string | null; score: number; breakdown: string };

export async function work(db: DatabaseSync, req: Req): Promise<WorkList> {
  const repo = req.query.get("repo") || undefined;
  const kind = req.query.get("kind") || undefined;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const visible = await visibleRepos(db, req);
  if (repo && !visible.includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  if (kind && kind !== "pr" && kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
  const repos = repo ? [repo] : visible;
  if (!repos.length) return { rows: [], total: 0, next: null };
  const where = `i.state = 'OPEN' AND i.repo IN (${repos.map(() => "?").join(",")})${kind ? " AND i.kind = ?" : ""}`;
  const args = [...repos, ...(kind ? [kind] : [])];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN item_rank r ON r.repo = i.repo AND r.number = i.number WHERE ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT i.repo, i.number, i.kind, i.title, i.head_oid, r.score, r.breakdown FROM items i JOIN item_rank r ON r.repo = i.repo AND r.number = i.number
    WHERE ${where} ORDER BY r.score DESC, i.repo, i.number LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
  const settled = settledLookup(db, latestRun(db));
  const out: WorkRow[] = rows.map((r) => {
    const s = settled(r.repo, r.number), bd = JSON.parse(r.breakdown) as RankBreakdown;
    const facts = factsOf(db, r.repo, r.number, r.kind, r.head_oid, s);
    return {
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, level: bd.level, size: bd.size,
      breakdown: bd, label: s.label as TypeLabel | null,
      next: nextStepOf(facts), nextHref: facts.disagree && !facts.held ? classifyListOf(r.repo) : null,
    };
  });
  return { rows: out, total, next: offset + rows.length < total ? offset + rows.length : null };
}
