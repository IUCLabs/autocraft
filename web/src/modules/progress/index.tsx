import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ActivityIcon, ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { Progress, RepoProgress } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Hud, RegMarks } from "../../ui/Hud";
import { cn } from "../../ui/cn";
import { num, pct } from "../../lib/format";
import { DoneSplit, FunnelChart, OUTCOMES, Sparkline, StackBar, Throughput, DONE_PARTS } from "./charts";
import { useIsPhone } from "../../shell/useMedia";

const doneTotal = (d: RepoProgress["done"]) => d.mergedByPipeline + d.closedByPipeline + d.closedByOthers;

function Tile({ label, value, sub, children, accent }: { label: string; value: string; sub?: ReactNode; children?: ReactNode; accent?: boolean }) {
  return (
    <div className="min-w-0 bg-panel px-5 py-4">
      <Hud className="block text-2xs">{label}</Hud>
      <div className={cn("mt-2 font-display text-2xl leading-none md:text-3xl", accent && "text-warn")}>{value}</div>
      {sub && <div className="mt-2 font-mono text-2xs text-ink/50">{sub}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function Block({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("relative min-w-0 border border-line bg-panel", className)}>
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <Hud as="h2">{title}</Hud>
        {aside && <span className="ml-auto font-mono text-2xs text-ink/45">{aside}</span>}
      </div>
      <div className="p-4 md:p-5">{children}</div>
    </section>
  );
}

function Overview(_: ViewProps) {
  const { data: p } = useQuery("progress", (api) => api.progress());
  const phone = useIsPhone();
  if (!p) return <div className="p-6 text-ink/50">Loading…</div>;
  const done = doneTotal(p.done);
  const avg = Math.round(p.perHour.reduce((a, b) => a + b, 0) / p.perHour.length);
  const startOpen = p.repos.reduce((a, r) => a + r.openTrend[0], 0);
  const days = Math.ceil((Date.parse(p.now) - Date.parse(p.runStartedAt)) / 86400_000);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-5 md:px-8 md:pt-8">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
          <h1 className="font-display text-2xl md:text-3xl">Run progress</h1>
          <span className="pb-1 font-mono text-2xs text-ink/50">
            started {p.runStartedAt.slice(0, 10)} · day {days} · {p.repos.length} repos
          </span>
        </div>

        <div className="relative mt-6">
          <RegMarks />
          <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
            <Tile label="Open now" value={num(p.funnel.open)} sub={<>from {num(startOpen)} at run start</>} />
            <Tile label="Done since start" value={num(done)} sub={`${pct(p.done.mergedByPipeline + p.done.closedByPipeline, done)} by the pipeline`} />
            <Tile label="Throughput" value={`${avg}/h`} sub={`${num(p.perHour.reduce((a, b) => a + b, 0))} in the last 24 h`} />
            <Tile label="Decisions waiting" value={String(p.decisionsOpen)} accent sub={<Link to="/decisions" className="hover:text-ink">{p.decisionsAnsweredToday} answered today →</Link>} />
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
          <Block title="Funnel · open items" aside={`${pct(p.funnel.reviewed, p.funnel.open)} reviewed`}>
            <FunnelChart f={p.funnel} />
          </Block>
          <Block title="Done since run start" aside={num(done)}>
            <DoneSplit done={p.done} />
            <div className="mt-6 grid grid-cols-3 gap-px border border-line bg-line">
              {DONE_PARTS.map((d) => (
                <div key={d.key} className="bg-panel px-3 py-2.5">
                  <span className={cn("mb-2 block h-0.5 w-5", d.cls)} />
                  <div className="font-mono text-md">{num(p.done[d.key])}</div>
                  <div className="mt-0.5 text-2xs leading-4 text-ink/55">{d.label}</div>
                </div>
              ))}
            </div>
          </Block>
        </div>

        <Block title="Throughput · items done per hour" aside="last 24 h, UTC" className="mt-6">
          <Throughput perHour={p.perHour} nowIso={p.now} />
        </Block>

        <Block title="By repo" aside="click a column to sort" className="mt-6">
          {phone ? <RepoCards p={p} /> : <RepoTable p={p} />}
        </Block>
      </div>
    </div>
  );
}

type SortKey = "open" | "done" | "decisions" | "reviewed";

function RepoTable({ p }: { p: Progress }) {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "open", desc: true });
  const val = (r: RepoProgress) => ({ open: r.funnel.open, done: doneTotal(r.done), decisions: r.decisionsOpen, reviewed: r.funnel.reviewed / r.funnel.open })[sort.k];
  const rows = [...p.repos].sort((a, b) => (val(a) - val(b)) * (sort.desc ? -1 : 1));
  const maxDone = Math.max(...p.repos.map((r) => doneTotal(r.done)));
  const Th = ({ k, children, className }: { k?: SortKey; children: ReactNode; className?: string }) => (
    <th className={cn("h-9 border-b border-line-strong px-2 text-left font-normal", className)} aria-sort={k && sort.k === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      {k ? (
        <button onClick={() => setSort({ k, desc: sort.k === k ? !sort.desc : true })} className={cn("hud inline-flex items-center gap-1 text-2xs", sort.k === k ? "text-ink" : "text-ink/50 hover:text-ink")}>
          {children}
          {sort.k === k && (sort.desc ? <ArrowDownIcon className="text-[9px]" /> : <ArrowUpIcon className="text-[9px]" />)}
        </button>
      ) : (
        <span className="hud text-2xs text-ink/50">{children}</span>
      )}
    </th>
  );
  return (
    <div className="-mx-4 overflow-x-auto md:-mx-5">
      <table className="w-full min-w-[880px] border-collapse">
        <thead>
          <tr>
            <Th className="pl-4 md:pl-5">Repo</Th>
            <Th k="open" className="w-[90px] text-right">
              Open
            </Th>
            <Th k="reviewed">Classified / reviewed</Th>
            <Th>Routed</Th>
            <Th k="done">Done</Th>
            <Th k="decisions" className="w-[90px] text-right">
              Waiting
            </Th>
            <Th className="w-[110px] pr-4 md:pr-5">Open trend</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const f = r.funnel;
            const d = doneTotal(r.done);
            return (
              <tr key={r.repo} className="h-10 border-b border-line last:border-0 hover:bg-ink/[0.03]">
                <td className="pl-4 pr-2 md:pl-5">
                  <Link to={`/decisions?repo=${r.repo}`} className="font-mono text-xs hover:underline">
                    {r.repo}
                  </Link>
                </td>
                <td className="px-2 text-right font-mono text-xs">{num(f.open)}</td>
                <td className="w-[200px] px-2">
                  <div className="relative h-1.5 bg-ink/[0.07]">
                    <div className="absolute inset-y-0 left-0 bg-ink/30" style={{ width: `${(f.classified / f.open) * 100}%` }} />
                    <div className="absolute inset-y-0 left-0 bg-ink/85" style={{ width: `${(f.reviewed / f.open) * 100}%` }} />
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-ink/45">
                    {pct(f.classified, f.open)} / {pct(f.reviewed, f.open)}
                  </div>
                </td>
                <td className="w-[200px] px-2">
                  <StackBar parts={OUTCOMES.map((o) => ({ ...o, value: f[o.key] }))} height={6} />
                </td>
                <td className="w-[210px] px-2">
                  <div className="flex items-center gap-2">
                    <div style={{ width: `${(d / maxDone) * 110}px` }}>
                      <StackBar parts={DONE_PARTS.map((x) => ({ ...x, value: r.done[x.key] }))} height={6} />
                    </div>
                    <span className="font-mono text-xs">{num(d)}</span>
                  </div>
                </td>
                <td className={cn("px-2 text-right font-mono text-xs", r.decisionsOpen ? "text-warn" : "text-ink/30")}>{r.decisionsOpen || "–"}</td>
                <td className="pr-4 text-ink/55 md:pr-5">
                  <Sparkline values={r.openTrend} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RepoCards({ p }: { p: Progress }) {
  const rows = [...p.repos].sort((a, b) => b.funnel.open - a.funnel.open);
  return (
    <ul className="-mx-4 -my-4">
      {rows.map((r) => (
        <li key={r.repo} className="border-b border-line px-4 py-3 last:border-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs">{r.repo}</span>
            {r.decisionsOpen > 0 && <span className="font-mono text-2xs text-warn">{r.decisionsOpen} waiting</span>}
            <span className="ml-auto font-mono text-xs">{num(r.funnel.open)} open</span>
          </div>
          <div className="mt-2">
            <StackBar parts={OUTCOMES.map((o) => ({ ...o, value: r.funnel[o.key] }))} height={5} />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-ink/45">
            <span>{pct(r.funnel.reviewed, r.funnel.open)} reviewed</span>
            <span>{num(doneTotal(r.done))} done</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export const progressModule: FeatureModule = {
  id: "progress",
  permission: "viewer",
  nav: { label: "Progress", icon: ActivityIcon, to: "/progress", group: "work", order: 1, phoneTab: true },
  commands: [{ id: "go-progress", keys: "g p", label: "Go to progress", group: "Go to" }],
  routes: [{ path: "progress", view: { id: "progress", title: "Progress", panels: [{ id: "overview", title: "Overview", component: Overview, defaultSize: 100 }] } }],
};
