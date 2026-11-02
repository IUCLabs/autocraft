// Run and cost: token use per stage and model, per repo, and the experiment's
// headline numbers.
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res } from "../types.ts";
import { esc, num, page } from "./layout.ts";
import { doneByRepo, latestCte, runStart, SIZE_ORDER, SIZE_SQL } from "./stats.ts";

type Usage = { stage: string | null; model: string | null; runs: number; items: number; input: number; output: number; cread: number; cwrite: number };

const per = (t: number, n: number): string => (n ? num(Math.round(t / n)) : "–");

export function cost(db: DatabaseSync, req: Req): Res {
  const start = runStart(db);
  const usage = db.prepare(`SELECT stage, model, COUNT(*) AS runs, COALESCE(SUM(items),0) AS items,
      COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(SUM(cache_read_tokens),0) AS cread, COALESCE(SUM(cache_write_tokens),0) AS cwrite
    FROM token_usage GROUP BY stage, model ORDER BY stage, model`).all() as Usage[];
  const tokens = (u: { input: number; output: number; cread: number; cwrite: number }) => u.input + u.output + u.cread + u.cwrite;
  const usageTable = usage.length
    ? `<div class=scroll><table><thead><tr><th>Stage</th><th>Model</th><th class=n>Runs</th><th class=n>Items</th><th class=n>Input</th><th class=n>Output</th><th class=n>Cache read</th><th class=n>Cache write</th><th class=n>Tokens per item</th></tr></thead><tbody>${usage.map((u) =>
      `<tr><td>${esc(u.stage ?? "–")}</td><td>${esc(u.model ?? "–")}</td><td class=n>${num(u.runs)}</td><td class=n>${num(u.items)}</td><td class=n>${num(u.input)}</td><td class=n>${num(u.output)}</td><td class=n>${num(u.cread)}</td><td class=n>${num(u.cwrite)}</td><td class=n>${per(tokens(u), u.items)}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class=muted>No agent runs recorded yet.</p>`;

  const byRepo = db.prepare(`SELECT repo, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(SUM(cache_read_tokens),0) AS cread, COALESCE(SUM(cache_write_tokens),0) AS cwrite, COALESCE(SUM(items),0) AS items
    FROM token_usage WHERE repo IS NOT NULL GROUP BY repo`).all() as (Usage & { repo: string })[];
  const done = new Map(doneByRepo(db, start).map((d) => [d.repo, d.merged_pipeline + d.closed_pipeline]));
  const repos = [...new Set([...byRepo.map((r) => r.repo), ...done.keys()])].sort();
  const tok = new Map(byRepo.map((r) => [r.repo, tokens(r)]));
  const repoTable = `<div class=scroll><table><thead><tr><th>Repo</th><th class=n>Done by the pipeline</th><th class=n>Tokens</th><th class=n>Tokens per done item</th></tr></thead><tbody>${repos.map((r) =>
    `<tr><td>${esc(r)}</td><td class=n>${num(done.get(r) ?? 0)}</td><td class=n>${num(tok.get(r) ?? 0)}</td><td class=n>${per(tok.get(r) ?? 0, done.get(r) ?? 0)}</td></tr>`).join("")}</tbody></table></div>`;

  const outcomes = db.prepare(`WITH ${latestCte()}
    SELECT ${SIZE_SQL} AS size,
      SUM(i.state = 'MERGED' AND l.stage = 'merged') AS merged,
      SUM(i.state = 'CLOSED' AND l.stage = 'closed') AS closed,
      SUM(l.stage = 'fixed-by-us') AS fixed
    FROM items i JOIN latest l ON l.repo = i.repo AND l.number = i.number
    WHERE i.state <> 'OPEN' AND i.closed_at >= :start GROUP BY size`).all({ start }) as { size: string; merged: number; closed: number; fixed: number }[];
  outcomes.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
  const tot = outcomes.reduce((s, o) => ({ merged: s.merged + o.merged, closed: s.closed + o.closed, fixed: s.fixed + o.fixed }), { merged: 0, closed: 0, fixed: 0 });
  const outcomeTable = `<div class=scroll><table><thead><tr><th>Size</th><th class=n>Merged</th><th class=n>Closed</th><th class=n>Fixed by us</th></tr></thead><tbody>${outcomes.map((o) =>
    `<tr><td>${esc(o.size)}</td><td class=n>${num(o.merged)}</td><td class=n>${num(o.closed)}</td><td class=n>${num(o.fixed)}</td></tr>`).join("")}<tr><th>All</th><th class=n>${num(tot.merged)}</th><th class=n>${num(tot.closed)}</th><th class=n>${num(tot.fixed)}</th></tr></tbody></table></div>`;

  const dec = db.prepare("SELECT COUNT(*) AS asked, SUM(answer IS NOT NULL) AS answered FROM decisions").get() as { asked: number; answered: number | null };
  const human = db.prepare(`WITH ${latestCte()} SELECT COUNT(*) AS n FROM items i JOIN latest l ON l.repo = i.repo AND l.number = i.number
    WHERE i.state = 'OPEN' AND l.stage IN ('needs-decision', 'batched')`).get() as { n: number };
  const all = usage.reduce((s, u) => s + tokens(u), 0);
  const tile = (v: string, l: string) => `<div class=tile><b>${v}</b><span>${l}</span></div>`;
  const body = `<h1>Run and cost</h1><p class=summary>Since ${esc(start.slice(0, 10))}: ${num(tot.merged)} merged, ${num(tot.closed)} closed and ${num(tot.fixed)} fixed by the pipeline, for ${num(all)} tokens.</p>
    <div class=tiles>${tile(num(tot.merged), "merged by the pipeline")}${tile(num(tot.closed), "closed by the pipeline")}${tile(num(tot.fixed), "fixed by us")}${tile(num(dec.asked), "decisions asked")}${tile(num(dec.answered ?? 0), "decisions answered")}${tile(num(human.n), "items still needing a person")}</div>
    <h2>Outcomes by size</h2>${outcomeTable}
    <h2>By stage and model</h2>${usageTable}
    <h2>By repo</h2>${repoTable}`;
  return page(req, "Run and cost", body);
}
