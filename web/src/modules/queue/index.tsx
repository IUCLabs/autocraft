// Queue: one page for everything waiting on the pipeline. Tabs filter by next step; the Merge tab
// adds the merge queue's columns and the operator's merge controls. The repo filter is the `repos` URL parameter.
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { ListNumbersIcon } from "@phosphor-icons/react";
import { usePagedQuery, useQuery } from "../../api/client";
import type { QueuePage, QueueTab } from "../../api/types";
import type { FeatureModule } from "../../registry/types";
import { num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { cn } from "../../ui/cn";
import { Block, ErrorLine, Page, selectCls, useUrlState } from "../admin/parts";
import { WorkCards, WorkTable } from "./AllTab";
import { FastTrackAdd } from "./fastTrack";
import { MergeTab } from "./MergeTab";

const TABS: [QueueTab, string][] = [
  ["all", "All"],
  ["review", "Review"],
  ["fix", "Fix"],
  ["verify", "Verify"],
  ["merge", "Merge"],
];

function usePage(tab: QueueTab, repos: string) {
  const q = usePagedQuery(
    `queue-page:${tab}:${repos}`,
    (api, after) => api.queuePage({ tab, repos, offset: after ? Number(after) : 0, limit: 100 }),
    (p) => (p.next === null ? null : String(p.next)),
  );
  // After a tab or filter change the cache shows the previous page until the new one arrives.
  const pages = q.pages?.filter((p) => p.tab === tab);
  return { pages: pages?.length ? pages : undefined, counts: q.pages?.[0]?.counts, error: q.error, hasMore: q.hasMore, loadingMore: q.loadingMore, loadMore: q.loadMore };
}

function RepoFilter({ repos, update }: { repos: string; update: (patch: Record<string, string | null>) => void }) {
  const { data: names } = useQuery("repos", (api) => api.repos());
  const single = repos !== "pipeline" && repos !== "all";
  return (
    <div role="group" aria-label="Repos" className="flex items-center gap-1">
      <button aria-pressed={repos === "pipeline"} data-active={repos === "pipeline"} className="chip max-md:h-11" onClick={() => update({ repos: null, repo: null })}>
        Pipeline on
      </button>
      <button aria-pressed={repos === "all"} data-active={repos === "all"} className="chip max-md:h-11" onClick={() => update({ repos: "all", repo: null })}>
        All repos
      </button>
      <select aria-label="Repo" value={single ? repos : ""} onChange={(e) => update({ repos: e.target.value || null, repo: null })} className={cn(selectCls, "h-7 max-md:h-11", single ? "text-accent-ink" : "text-ink/70")}>
        <option value="">One repo</option>
        {names?.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </div>
  );
}

function QueueView() {
  const { tab: param } = useParams();
  const { search } = useLocation();
  const { state, update } = useUrlState();
  const phone = useIsPhone();
  const tab = param ? TABS.find(([t]) => t === param)?.[0] : "all";
  const repos = state.repos || state.repo || "pipeline";
  const { pages, counts, error, hasMore, loadingMore, loadMore } = usePage(tab ?? "all", repos);
  if (!tab) return <Navigate to={`/queue${search}`} replace />;

  const first: QueuePage | undefined = pages?.[0];
  const rows = pages?.flatMap((p) => p.rows) ?? [];
  const mergeRows = pages?.flatMap((p) => p.mergeRows) ?? [];
  const more = hasMore && first ? { total: first.total, count: tab === "merge" ? mergeRows.length : rows.length } : null;

  return (
    <Page title="Queue">
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Queue" className="flex flex-wrap items-center gap-1">
          {TABS.map(([t, label]) => (
            <Link key={t} role="tab" aria-selected={tab === t} data-active={tab === t} to={`/queue${t === "all" ? "" : `/${t}`}${search}`} replace className="chip max-md:h-11">
              {label} {counts && <span className="num opacity-60">{num(counts[t])}</span>}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FastTrackAdd />
          <RepoFilter repos={repos} update={update} />
        </div>
      </div>
      <ErrorLine error={error?.message} className="mt-3" />
      {tab === "merge" ? (
        first && <MergeTab page={first} rows={mergeRows} phone={phone} more={more ? { total: more.total, loading: loadingMore, load: loadMore } : undefined} />
      ) : (
        <Block className="mt-3" flush title={tab === "all" ? "Open items" : TABS.find(([t]) => t === tab)![1]}>
          {first && rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No item here.</p>}
          {rows.length > 0 && (phone ? <WorkCards rows={rows} /> : <WorkTable rows={rows} />)}
          {more && (
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
              <span className="num">
                {num(more.count)} of {num(more.total)}
              </span>
              <button className="chip max-md:h-11" disabled={loadingMore} onClick={loadMore}>
                Show more
              </button>
            </div>
          )}
        </Block>
      )}
    </Page>
  );
}

export const queueModule: FeatureModule = {
  id: "queue",
  permission: "viewer",
  nav: { label: "Queue", icon: ListNumbersIcon, to: "/queue", group: "work", order: 0.4 },
  commands: [{ id: "go-queue", keys: "g q", label: "Go to queue", group: "Go to" }],
  routes: [{ path: "queue/:tab?", view: { id: "queue", title: "Queue", panels: [{ id: "main", title: "Queue", component: QueueView, defaultSize: 100 }] } }],
};
