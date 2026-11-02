// Progress (org) and Repo pages: totals, funnel, per-repo table, breakdowns, trend.
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res } from "../types.ts";
import { hbars, line, sparkline, stacked } from "./charts.ts";
import { decisionList } from "./decisions.ts";
import { esc, notFound, num, page, repoLink, sortHeader, withQuery } from "./layout.ts";
import { breakdowns, donePerHour, doneByRepo, funnelByRepo, openDecisionsByRepo, runStart, trend, type DoneRow, type FunnelRow } from "./stats.ts";

const sum = <T>(rows: T[], f: (r: T) => number): number => rows.reduce((s, r) => s + f(r), 0);

function totalsTiles(open: number, done: DoneRow[], perHour: number, decisions: number, start: string): string {
  const merged = sum(done, (d) => d.merged_pipeline);
  const closedP = sum(done, (d) => d.closed_pipeline);
  const others = sum(done, (d) => d.closed_others);
  const tile = (v: string, l: string) => `<div class=tile><b>${v}</b><span>${l}</span></div>`;
  return `<div class=tiles>${tile(num(open), "open now")}${tile(num(merged + closedP + others), `done since ${esc(start.slice(0, 10))}`)}` +
    `${tile(perHour.toFixed(1), "done per hour, last 24 h")}${tile(num(decisions), "decisions waiting")}</div>` +
    stacked([
      { label: "merged by the pipeline", value: merged, cls: "s1" },
      { label: "closed by the pipeline", value: closedP, cls: "s2" },
      { label: "closed by others", value: others, cls: "s3" },
    ], "Done since run start, by whom");
}

function funnel(f: FunnelRow[], done: DoneRow[], hrefBase: string): string {
  const bars = [
    { label: "Open", value: sum(f, (r) => r.open) },
    { label: "Classified", value: sum(f, (r) => r.classified) },
    { label: "Reviewed", value: sum(f, (r) => r.reviewed) },
    { label: "Taken", value: sum(f, (r) => r.take) },
    { label: "Held", value: sum(f, (r) => r.hold) },
    { label: "To close", value: sum(f, (r) => r.close) },
    { label: "Waiting for a decision", value: sum(f, (r) => r.needs_decision), href: hrefBase },
    { label: "In a batch", value: sum(f, (r) => r.batched), href: hrefBase },
    { label: "Done since run start", value: sum(done, (r) => r.total), cls: "s3" },
  ];
  return `<h2>Funnel</h2>${hbars(bars, "Pipeline funnel for open items")}`;
}

function breakdownBlocks(db: DatabaseSync, repo?: string): string {
  const b = breakdowns(db, repo);
  const block = (t: string, rows: { key: string; n: number }[]) =>
    `<section><h2>${esc(t)}</h2>${hbars(rows.map((r) => ({ label: r.key, value: r.n })), `Open items by ${t}`)}</section>`;
  return block("Type label", b.type) + block("Size (changed lines: S ≤ 50, M ≤ 300, L ≤ 1,000)", b.size) + block("Contributor tier", b.tier);
}

type RepoRow = { repo: string; open: number; done: number; decisions: number; trend: number[] };

function repoTable(req: Req, rows: RepoRow[]): string {
  const sort = req.query.get("sort") ?? "open";
  const key = (["open", "done", "decisions"].includes(sort) ? sort : "open") as "open" | "done" | "decisions";
  if (sort === "repo") rows.sort((a, b) => a.repo.localeCompare(b.repo));
  else rows.sort((a, b) => b[key] - a[key] || a.repo.localeCompare(b.repo));
  const body = rows.map((r) => `<tr><td>${repoLink(r.repo)}</td><td class=n>${num(r.open)}</td><td class=n>${num(r.done)}</td><td class=n>${r.decisions ? `<a href="/?repo=${encodeURIComponent(r.repo)}">${num(r.decisions)}</a>` : "0"}</td><td>${sparkline(r.trend, `${r.repo}: open items per day`)}</td></tr>`).join("");
  return `<h2>Repos</h2><div class=scroll><table><thead><tr>${sortHeader(req, "repo", "Repo", false)}${sortHeader(req, "open", "Open")}${sortHeader(req, "done", "Done")}${sortHeader(req, "decisions", "Decisions")}<th>Trend</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function progress(db: DatabaseSync, req: Req): Res {
  const start = runStart(db);
  const f = funnelByRepo(db);
  const done = doneByRepo(db, start);
  const dec = openDecisionsByRepo(db);
  const openNow = new Map(f.map((r) => [r.repo, r.open]));
  const t = trend(db, start, openNow);
  const doneMap = new Map(done.map((d) => [d.repo, d.total]));
  const names = new Set([...openNow.keys(), ...doneMap.keys(), ...dec.keys()]);
  const rows: RepoRow[] = [...names].map((repo) => ({
    repo, open: openNow.get(repo) ?? 0, done: doneMap.get(repo) ?? 0, decisions: dec.get(repo) ?? 0, trend: t.series.get(repo) ?? [],
  }));
  const orgTrend = t.days.map((_, i) => sum([...t.series.values()], (s) => s[i] ?? 0));
  const openTotal = sum(f, (r) => r.open);
  const decTotal = (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE answer IS NULL").get() as { n: number }).n;
  const body = `<h1>Progress</h1>
    <p class=summary>${num(openTotal)} open items in ${num(openNow.size)} repos; run started ${esc(start.slice(0, 10))}.</p>
    ${totalsTiles(openTotal, done, donePerHour(db), decTotal, start)}
    ${funnel(f, done, "/")}
    ${repoTable(req, rows)}
    ${breakdownBlocks(db)}
    <h2>Open items per day</h2>${line(t.days, orgTrend, "Open items per day, all repos")}`;
  return page(req, "Progress", body);
}

export async function repo(db: DatabaseSync, req: Req): Promise<Res> {
  const name = req.params.name;
  const exists = db.prepare("SELECT 1 FROM items WHERE repo = ? LIMIT 1").get(name) ?? db.prepare("SELECT 1 FROM repos WHERE name = ?").get(name);
  if (!exists) return notFound(req, `No repo ${name}`);
  const start = runStart(db);
  const f = funnelByRepo(db, name);
  const done = doneByRepo(db, start, name);
  const open = sum(f, (r) => r.open);
  const t = trend(db, start, new Map([[name, open]]), name);
  const decN = openDecisionsByRepo(db).get(name) ?? 0;
  const decisions = await decisionList(db, req, { repo: name, limit: 50 });
  const body = `<h1>${esc(name)}</h1>
    <p class=summary>${num(open)} open; <a href="https://github.com/storytold/${encodeURIComponent(name)}">on GitHub</a>; <a href="${esc(withQuery({ ...req, path: "/", query: new URLSearchParams() }, { repo: name }))}">all its decisions</a>.</p>
    ${totalsTiles(open, done, donePerHour(db, name), decN, start)}
    ${funnel(f, done, `/?repo=${encodeURIComponent(name)}`)}
    ${breakdownBlocks(db, name)}
    <h2>Open items per day</h2>${line(t.days, t.series.get(name) ?? [], `Open items per day in ${name}`)}
    <h2>Decisions and batches</h2>${decisions}`;
  return page(req, name, body);
}
