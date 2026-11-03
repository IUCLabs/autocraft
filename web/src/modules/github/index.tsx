// Every write the app made on GitHub: comments, labels, closes, pushes, merges and the rest.
import { useEffect, useRef } from "react";
import { ArrowSquareOutIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { useQuery, usePagedQuery } from "../../api/client";
import type { GithubActivityFilter, GithubActivityRow } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";
import { Block, ErrorLine, Page, selectCls, useUrlState, when } from "../admin/parts";

function useFilter() {
  const { state, update } = useUrlState();
  const filter: GithubActivityFilter = { repo: state.repo || undefined, action: state.action || undefined };
  return { filter, update };
}

function Item({ r, stretch }: { r: GithubActivityRow; stretch?: boolean }) {
  if (r.number !== null) return <ItemRef repo={r.repo} number={r.number} kind={r.kind} state={r.state} title={r.title} stretch={stretch} />;
  return (
    <span className="code text-ink/80">
      {r.repo}
      {r.branch ? `:${r.branch}` : ""}
    </span>
  );
}

function Detail({ r }: { r: GithubActivityRow }) {
  return (
    <>
      {r.error && <Badge tone="bad">Failed</Badge>}
      {r.outcome === "unknown" && <span className="mr-1.5 text-ink/55">Unknown outcome.</span>}
      {r.detail && <span className={cn("[overflow-wrap:anywhere]", r.error && "ml-1.5")}>{r.detail}</span>}
      {r.error && <span className="block text-xs text-bad [overflow-wrap:anywhere]">{r.error}</span>}
    </>
  );
}

const Out = ({ url }: { url: string }) => (
  <a href={url} target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub" className="relative z-10 inline-flex size-6 items-center justify-center text-ink/55 hover:text-accent-ink max-md:size-11">
    <ArrowSquareOutIcon className="size-4" />
  </a>
);

function Table({ rows }: { rows: GithubActivityRow[] }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-[130px]" />
          <col className="w-[120px]" />
          <col className="w-[28%]" />
          <col />
          <col className="w-[190px]" />
          <col className="w-[40px]" />
        </colgroup>
        <thead className="bg-ink/[0.03] text-xs text-ink/55">
          <tr className="border-b border-line text-left">
            <th className="h-8 px-3 font-medium">Time</th>
            <th className="px-3 font-medium">Action</th>
            <th className="px-3 font-medium">Item</th>
            <th className="px-3 font-medium">Detail</th>
            <th className="px-3 font-medium">Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="relative border-b border-line align-top last:border-0 hover:bg-ink/[0.03]">
              <td className="num px-3 py-2 text-xs text-ink/60">{when(r.at)}</td>
              <td className="px-3 py-2">{r.label}</td>
              <td className="px-3 py-2 [overflow-wrap:anywhere]">
                <Item r={r} stretch />
              </td>
              <td className="px-3 py-2 text-ink/75">
                <Detail r={r} />
              </td>
              <td className="px-3 py-2 text-xs text-ink/60 [overflow-wrap:anywhere]">{r.source}</td>
              <td className="py-1">
                <Out url={r.url} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ rows }: { rows: GithubActivityRow[] }) {
  return (
    <ul className="md:hidden">
      {rows.map((r) => (
        <li key={r.id} className="relative flex items-start gap-2 border-b border-line px-3 py-2.5 last:border-0">
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{r.label}</div>
            <Item r={r} stretch />
            {(r.detail || r.error || r.outcome === "unknown") && (
              <div className="mt-0.5 text-ink/75">
                <Detail r={r} />
              </div>
            )}
            <div className="mt-0.5 text-xs text-ink/55">
              <span className="num">{when(r.at)}</span> · {r.source}
            </div>
          </div>
          <Out url={r.url} />
        </li>
      ))}
    </ul>
  );
}

function GithubActivityView(_: ViewProps) {
  const { filter, update } = useFilter();
  const q = usePagedQuery(`github-activity:${JSON.stringify(filter)}`, (api, after) => api.githubActivity({ ...filter, after }), (p) => p.next);
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const rows = q.pages?.flatMap((p) => p.rows) ?? [];
  const first = q.pages?.[0];
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = q.loading || q.loadingMore;
  const { hasMore, loadMore } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && loadMore(), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadMore, rows.length]);

  return (
    <Page title="GitHub activity" sub={first && `${num(first.total)} write${first.total === 1 ? "" : "s"} on GitHub`}>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <select aria-label="Repo" value={filter.repo ?? ""} onChange={(e) => update({ repo: e.target.value || null })} className={cn(selectCls, filter.repo ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Every repo</option>
          {repos?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select aria-label="Action" value={filter.action ?? ""} onChange={(e) => update({ action: e.target.value || null })} className={cn(selectCls, filter.action ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Every action</option>
          {first?.actions.map((a) => (
            <option key={a.action} value={a.action}>
              {a.label} ({a.action})
            </option>
          ))}
        </select>
      </div>
      <Block className="mt-3" flush title="Writes" aside={loading && rows.length ? "Updating…" : undefined}>
        <ErrorLine error={q.error?.message} className="p-4" />
        {first && rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">Nothing has been written to GitHub yet.</p>}
        {rows.length > 0 && (
          <>
            <Table rows={rows} />
            <Cards rows={rows} />
          </>
        )}
        {q.hasMore && (
          <div ref={sentinel} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
            <span className="num">
              {num(rows.length)} of {num(first?.total ?? 0)}
            </span>
            <button className="chip max-md:h-11" disabled={loading} onClick={q.loadMore}>
              {loading ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </Block>
    </Page>
  );
}

export const githubModule: FeatureModule = {
  id: "github-activity",
  permission: "viewer",
  nav: { label: "GitHub activity", icon: ClockCounterClockwiseIcon, to: "/github-activity", group: "insight", order: 13 },
  routes: [{ path: "github-activity", view: { id: "github-activity", title: "GitHub activity", panels: [{ id: "main", title: "GitHub activity", component: GithubActivityView, defaultSize: 100 }] } }],
};
