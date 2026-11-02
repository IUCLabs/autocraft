// Work queue: open issues and PRs in rank order, with level, type and size and the next pipeline
// step. Read-only.
import { Link } from "react-router-dom";
import { ListOrderedIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { WorkBreakdown, WorkFilter, WorkRow } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge } from "../../ui/Badge";
import { LevelBadge } from "../../ui/PriorityBadge";
import { RefLink } from "../../ui/RefLink";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ErrorLine, Page, Pager, selectCls, useUrlState } from "../admin/parts";

const LIMIT = 100;

/** Size and reach in one line; the hover text names where each came from. */
function Breakdown({ b }: { b: WorkBreakdown }) {
  const parts: [string, string][] = [
    ["size", `${b.size} (${{ lines: "from changed lines", triage: "Fix triage's estimate", default: "not known yet, medium counts" }[b.sizeSource]})`],
    ...(b.security ? [["security", "a classifier raised the security flag: one level higher"] as [string, string]] : []),
    ...(b.rated === null ? [["unrated", "no priority yet: P2 counts"] as [string, string]] : []),
  ];
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink/60">
      {parts.map(([name, hint]) => (
        <span key={name} title={hint}>
          {name}
        </span>
      ))}
    </span>
  );
}

function Title({ r }: { r: WorkRow }) {
  return (
    <>
      <RefLink repo={r.repo} number={r.number} kind={r.kind} className="text-xs" />
      <Link to={`/item/${r.repo}/${r.number}`} className="line-clamp-2 font-medium hover:text-accent-ink hover:underline" title={r.title}>
        {r.title}
      </Link>
    </>
  );
}

function WorkView(_: ViewProps) {
  const { state, update } = useUrlState();
  const phone = useIsPhone();
  const offset = Math.max(Number(state.offset) || 0, 0);
  const filter: WorkFilter = { repo: state.repo || undefined, kind: state.kind === "pr" || state.kind === "issue" ? state.kind : undefined, limit: LIMIT, offset };
  const { data, error, loading } = useQuery(`work:${JSON.stringify(filter)}`, (api) => api.work(filter));
  const { data: repos } = useQuery("repos", (api) => api.repos());

  return (
    <Page title="Work queue" sub={data && <>{num(data.total)} open items, highest priority first (level, then type, then smaller size). Review, Fix, Verify, Fix-up, Decide and the merge queue take their items in this order.</>}>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <select aria-label="Repo" value={filter.repo ?? ""} onChange={(e) => update({ repo: e.target.value || null, offset: null })} className={cn(selectCls, filter.repo ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Every repo</option>
          {repos?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <div role="group" aria-label="Kind" className="flex items-center gap-1">
          {([undefined, "pr", "issue"] as const).map((k) => (
            <button key={k ?? "all"} aria-pressed={filter.kind === k} data-active={filter.kind === k} className="chip max-md:h-11" onClick={() => update({ kind: k ?? null, offset: null })}>
              {k === "pr" ? "Pull requests" : k === "issue" ? "Issues" : "Both"}
            </button>
          ))}
        </div>
      </div>
      <Block className="mt-3" flush title="Open items" aside={loading && data ? "Updating…" : undefined}>
        <ErrorLine error={error?.message} className="p-4" />
        {data && data.rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No ranked item matches these filters.</p>}
        {data && data.rows.length > 0 && (phone ? <Cards rows={data.rows} offset={offset} /> : <Table rows={data.rows} offset={offset} />)}
        {data && data.total > LIMIT && <Pager offset={offset} limit={LIMIT} total={data.total} onOffset={(o) => update({ offset: o ? String(o) : null })} />}
      </Block>
    </Page>
  );
}

function Table({ rows, offset }: { rows: WorkRow[]; offset: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs text-ink/55">
          <tr className="border-b border-line text-left">
            <th className="h-8 w-[44px] px-3 font-medium">#</th>
            <th className="px-3 font-medium">Item</th>
            <th className="w-[70px] px-3 font-medium">Level</th>
            <th className="w-[110px] px-3 font-medium">Type</th>
            <th className="w-[60px] px-3 font-medium">Size</th>
            <th className="w-[160px] px-3 font-medium">Notes</th>
            <th className="w-[220px] px-3 font-medium">Next step</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.repo}#${r.number}`} className="border-b border-line align-top last:border-0 hover:bg-ink/[0.03]">
              <td className="num px-3 py-2 text-xs text-ink/45">{offset + i + 1}</td>
              <td className="px-3 py-2">
                <Title r={r} />
              </td>
              <td className="px-3 py-2" title={`Sort key ${r.score}, reach ${r.breakdown.reach}`}>
                <LevelBadge level={r.level} />
              </td>
              <td className="px-3 py-2 text-xs text-ink/70">{r.label ?? <span className="text-ink/35">not settled</span>}</td>
              <td className="num px-3 py-2 text-xs">{r.size}</td>
              <td className="px-3 py-2">
                <Breakdown b={r.breakdown} />
              </td>
              <td className="px-3 py-2">
                <Badge tone="neutral">{r.next}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ rows, offset }: { rows: WorkRow[]; offset: number }) {
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={`${r.repo}#${r.number}`} className="border-b border-line px-4 py-2.5 last:border-0">
          <div className="flex items-center gap-2 text-xs text-ink/55">
            <span className="num">{offset + i + 1}.</span>
            <RefLink repo={r.repo} number={r.number} kind={r.kind} className="text-xs" />
            <span className="ml-auto shrink-0" title={`Sort key ${r.score}, reach ${r.breakdown.reach}`}>
              <LevelBadge level={r.level} />
            </span>
          </div>
          <Link to={`/item/${r.repo}/${r.number}`} className="mt-1 block text-sm font-medium leading-5 active:text-accent-ink">
            {r.title}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink/60">
            <Badge tone="neutral">{r.next}</Badge>
            <span>{r.label ?? "not settled"}</span>
            <span className="num">{r.size}</span>
          </div>
          <div className="mt-1">
            <Breakdown b={r.breakdown} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export const workModule: FeatureModule = {
  id: "work",
  permission: "viewer",
  nav: { label: "Work queue", icon: ListOrderedIcon, to: "/work", group: "work", order: 0.4 },
  commands: [{ id: "go-work", keys: "g w", label: "Go to work queue", group: "Go to" }],
  routes: [{ path: "work", view: { id: "work", title: "Work queue", panels: [{ id: "main", title: "Work queue", component: WorkView, defaultSize: 100 }] } }],
};
