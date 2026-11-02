import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ActivityIcon, ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { Progress, RepoProgress } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { cn } from "../../ui/cn";
import { num, pct } from "../../lib/format";
import { DoneSplit, FunnelChart, OUTCOMES, Sparkline, StackBar, Throughput, DONE_PARTS } from "./charts";
import { useIsPhone } from "../../shell/useMedia";

const doneTotal = (d: RepoProgress["done"]) => d.mergedByPipeline + d.closedByPipeline + d.closedByOthers;

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "warn" }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-raised/40 px-4 py-3">
      <div className="text-xs text-ink/55">{label}</div>
      <div className={cn("num mt-1 text-2xl font-semibold", tone === "warn" && "text-warn")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink/50">{sub}</div>}
    </div>
  );
}

function Block({ title, aside, children, className, flush }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-md border border-line", className)}>
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="ml-auto text-xs text-ink/50">{aside}</span>}
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
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
      <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-5 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">Run progress</h1>
          <span className="text-sm text-ink/55">
            Started {p.runStartedAt.slice(0, 10)} · day {days} · {p.repos.length} repos
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Open now" value={num(p.funnel.open)} sub={<>from {num(startOpen)} at run start</>} />
          <Stat label="Done since start" value={num(done)} sub={`${pct(p.done.mergedByPipeline + p.done.closedByPipeline, done)} by the pipeline`} />
          <Stat label="Throughput" value={`${avg} / h`} sub={`${num(p.perHour.reduce((a, b) => a + b, 0))} in the last 24 h`} />
          <Stat
            label="Decisions waiting"
            value={String(p.decisionsOpen)}
            tone="warn"
            sub={
              <Link to="/decisions" className="text-accent-ink hover:underline">
                {p.decisionsAnsweredToday} answered today
              </Link>
            }
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Block title="Open items" aside={`${pct(p.funnel.reviewed, p.funnel.open)} reviewed`}>
            <FunnelChart f={p.funnel} />
          </Block>
          <Block title="Done since run start" aside={num(done)}>
            <DoneSplit done={p.done} />
            <table className="mt-4 w-full text-sm">
              <tbody>
                {DONE_PARTS.map((d) => (
                  <tr key={d.key} className="border-t border-line">
                    <td className="py-1.5">
                      <span className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-sm", d.cls)} /> {d.label}
                      </span>
                    </td>
                    <td className="num py-1.5 text-right font-medium">{num(p.done[d.key])}</td>
                    <td className="num w-14 py-1.5 text-right text-ink/50">{pct(p.done[d.key], done)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
        </div>

        <Block title="Items done per hour" aside="Last 24 h, UTC" className="mt-4">
          <Throughput perHour={p.perHour} nowIso={p.now} />
        </Block>

        <Block title="By repo" aside={phone ? undefined : "Click a column header to sort"} className="mt-4" flush>
          {phone ? <RepoCards p={p} /> : <RepoTable p={p} />}
        </Block>
      </div>
    </div>
  );
}

type SortKey = "repo" | "open" | "done" | "decisions" | "reviewed";

function RepoTable({ p }: { p: Progress }) {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "open", desc: true });
  const val = (r: RepoProgress): number | string => ({ repo: r.repo, open: r.funnel.open, done: doneTotal(r.done), decisions: r.decisionsOpen, reviewed: r.funnel.reviewed / r.funnel.open })[sort.k];
  const rows = [...p.repos].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return sort.desc ? -c : c;
  });
  const maxDone = Math.max(...p.repos.map((r) => doneTotal(r.done)));
  const Th = ({ k, children, className, right }: { k?: SortKey; children: ReactNode; className?: string; right?: boolean }) => (
    <th className={cn("h-8 px-3 font-medium", right ? "text-right" : "text-left", className)} aria-sort={k && sort.k === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      {k ? (
        <button onClick={() => setSort({ k, desc: sort.k === k ? !sort.desc : k !== "repo" })} className={cn("inline-flex items-center gap-1", sort.k === k ? "text-ink" : "text-ink/55 hover:text-ink")}>
          {children}
          {sort.k === k ? sort.desc ? <ArrowDownIcon className="text-[11px]" /> : <ArrowUpIcon className="text-[11px]" /> : <ChevronsUpDownIcon className="text-[11px] opacity-50" />}
        </button>
      ) : (
        <span className="text-ink/55">{children}</span>
      )}
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs">
          <tr className="border-b border-line">
            <Th k="repo">Repo</Th>
            <Th k="open" right className="w-[90px]">
              Open
            </Th>
            <Th k="reviewed" className="w-[200px]">
              Classified / reviewed
            </Th>
            <Th className="w-[200px]">Routed</Th>
            <Th k="done" className="w-[220px]">
              Done
            </Th>
            <Th k="decisions" right className="w-[90px]">
              Waiting
            </Th>
            <Th className="w-[110px]">Open, 7 days</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const f = r.funnel;
            const d = doneTotal(r.done);
            return (
              <tr key={r.repo} className="h-9 border-b border-line last:border-0 hover:bg-ink/[0.03]">
                <td className="px-3">
                  <Link to={`/decisions?repo=${r.repo}`} className="font-medium hover:text-accent-ink hover:underline">
                    {r.repo}
                  </Link>
                </td>
                <td className="num px-3 text-right">{num(f.open)}</td>
                <td className="px-3">
                  <div className="flex items-center gap-2">
                    <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]">
                      <div className="absolute inset-y-0 left-0 bg-ink/25" style={{ width: `${(f.classified / f.open) * 100}%` }} />
                      <div className="absolute inset-y-0 left-0 bg-ink/70" style={{ width: `${(f.reviewed / f.open) * 100}%` }} />
                    </div>
                    <span className="num w-[72px] text-right text-xs text-ink/55">
                      {pct(f.classified, f.open)} / {pct(f.reviewed, f.open)}
                    </span>
                  </div>
                </td>
                <td className="px-3">
                  <StackBar parts={OUTCOMES.map((o) => ({ ...o, value: f[o.key] }))} height={6} />
                </td>
                <td className="px-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <div style={{ width: `${(d / maxDone) * 100}%` }}>
                        <StackBar parts={DONE_PARTS.map((x) => ({ ...x, value: r.done[x.key] }))} height={6} />
                      </div>
                    </div>
                    <span className="num w-12 text-right">{num(d)}</span>
                  </div>
                </td>
                <td className={cn("num px-3 text-right", r.decisionsOpen ? "font-medium text-warn" : "text-ink/30")}>{r.decisionsOpen || "–"}</td>
                <td className="px-3 text-ink/45">
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
    <ul>
      {rows.map((r) => (
        <li key={r.repo} className="border-b border-line px-4 py-2.5 last:border-0">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="font-medium">{r.repo}</span>
            {r.decisionsOpen > 0 && <span className="text-xs text-warn">{r.decisionsOpen} waiting</span>}
            <span className="num ml-auto">{num(r.funnel.open)} open</span>
          </div>
          <div className="mt-1.5">
            <StackBar parts={OUTCOMES.map((o) => ({ ...o, value: r.funnel[o.key] }))} height={5} />
          </div>
          <div className="num mt-1 flex justify-between text-xs text-ink/50">
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
