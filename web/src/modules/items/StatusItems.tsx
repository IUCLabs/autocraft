// Items: every issue and PR as Workable rows (the merge queue's table) with its status, filtered by phase.
import { UnlessProject } from "../../shell/ScopePicker";
import { ChatsCircleIcon, MagnifyingGlassIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { usePagedQuery } from "../../api/client";
import type { ItemPhase, ItemStatus, ItemStatusFilter, ItemStatusRow } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { Chip } from "../../ui/atoms/Chip";
import { Pending } from "../../ui/atoms/Pending";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { RepoSelect } from "../../ui/molecules/RepoSelect";
import { PhaseBadge } from "../../ui/molecules/StatusLine";
import { WorkableRow, WorkableTable, type WorkableColumn } from "../../ui/organisms/Workable";
import { CHECK_COLUMNS, checkCells, Size, SIZE_COLUMN } from "../queue/checks";
import { Page } from "../../ui/organisms/Page";
import { useUrlState } from "../admin/parts";
import type { ViewProps } from "../../registry/types";

const PHASES: ItemPhase[] = ["Triage", "Waiting for a person", "Review", "Fixing", "Verifying", "In queue", "Merged", "Closed", "Held", "Out of scope", "Pipeline off"];

const COLUMNS: WorkableColumn[] = [
  { id: "status", label: "Status", width: "190px", mdWidth: "160px", hint: "Where the item stands; what it waits for and what comes next is under the title" },
  ...CHECK_COLUMNS,
  SIZE_COLUMN,
  { id: "author", label: "Author", width: "140px", wide: true },
  { id: "updated", label: "Updated", width: "96px", mdWidth: "80px", align: "end" },
];

/** What it waits for and what happens next, the line under the title. */
function Waits({ s }: { s: ItemStatus }) {
  const parts = [s.waiting && `waiting for ${s.waiting}`, s.next && `next: ${s.next}`].filter(Boolean);
  return parts.length ? <>{parts.join(" · ")}</> : null;
}

function Row({ r }: { r: ItemStatusRow }) {
  return (
    <WorkableRow
      item={{ repo: r.repo, number: r.number, kind: r.kind, state: r.state, title: r.title, closes: r.closes }}
      dataItem={`${r.repo}:${r.number}`}
      sub={r.status.waiting || r.status.next ? <Waits s={r.status} /> : undefined}
      cells={{
        status: <PhaseBadge phase={r.status.phase} />,
        ...checkCells(r.checks),
        size: r.checks ? <Size size={r.checks.size} /> : undefined,
        author: r.author ? <span className="block truncate text-xs text-ink/70">{r.author}</span> : undefined,
        updated: r.updatedAt ? <TimeAgo iso={r.updatedAt} className="num text-xs text-ink/45" /> : undefined,
      }}
    />
  );
}

export function StatusItemsView(_: ViewProps) {
  const { state, update } = useUrlState();
  const phase = PHASES.find((p) => p === state.phase);
  const kind = state.kind === "pr" || state.kind === "issue" ? state.kind : undefined;
  const repo = state.repo || undefined;
  const discord = state.discord === "1";
  const filter: ItemStatusFilter = { q: state.q?.trim() || undefined, phase, kind, repo: repo ? [repo] : undefined, discord: discord || undefined };
  // A change event refetches every loaded page in order, so Load more keeps its place.
  const { pages, error, hasMore, loadingMore, loadMore } = usePagedQuery(`items-status:${JSON.stringify(filter)}`, (a, cursor) => a.itemStatusList({ ...filter, cursor }), (p) => p.nextCursor);
  const data = pages?.[0];
  const rows = pages?.flatMap((p) => p.rows);
  const kinds: [string, string | undefined][] = [["All", undefined], ["Pull requests", "pr"], ["Issues", "issue"]];
  return (
    <Page title="Items" wide>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60 max-md:h-11 max-md:basis-full md:max-w-[420px]">
          <MagnifyingGlassIcon className="shrink-0 text-ink/45" />
          <input value={state.q ?? ""} onChange={(e) => update({ q: e.target.value || null })} placeholder="Filter by number or title" aria-label="Filter items" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40" />
        </label>
        <UnlessProject><RepoSelect value={repo ?? null} onChange={(r) => update({ repo: r })} /></UnlessProject>
        <Link to="/items/filters" className="ml-auto inline-flex h-8 items-center gap-1.5 px-2 text-xs text-ink/60 hover:text-ink max-md:h-11"><SlidersHorizontalIcon /> More filters</Link>
      </div>
      <div className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Phase">
        <Chip active={!phase} onClick={() => update({ phase: null })} count={data ? Object.values(data.byPhase).reduce((a, b) => a + b, 0) : undefined}>Any status</Chip>
        {PHASES.filter((p) => !data || data.byPhase[p] > 0 || p === phase).map((p) => (
          <Chip key={p} active={phase === p} onClick={() => update({ phase: p })} count={data?.byPhase[p]}>{p}</Chip>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1 border-b border-line pb-2 text-sm" role="group" aria-label="Kind">
        {kinds.map(([l, k]) => (
          <button key={l} onClick={() => update({ kind: k ?? null })} aria-pressed={kind === k} className="h-7 rounded px-2 text-xs text-ink/60 hover:text-ink aria-pressed:bg-ink/[0.08] aria-pressed:font-medium aria-pressed:text-ink max-md:h-11">{l}</button>
        ))}
        <button onClick={() => update({ discord: discord ? null : "1" })} aria-pressed={discord} className="ml-1 inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-ink/60 hover:text-ink aria-pressed:bg-ink/[0.08] aria-pressed:font-medium aria-pressed:text-ink max-md:h-11">
          <ChatsCircleIcon aria-hidden /> Seen on Discord
        </button>
      </div>
      {!rows ? <Pending error={error} /> : rows.length === 0 ? <p className="py-8 text-sm text-ink/55">No items match.</p> : (
        <>
          <WorkableTable columns={COLUMNS} label="Items" closes className="mt-3">
            {rows.map((r) => <Row key={`${r.kind}${r.repo}${r.number}`} r={r} />)}
          </WorkableTable>
          <div className="flex items-center gap-3 py-3 text-xs text-ink/55">
            <span className="num">{rows.length} of {data && (phase ? data.byPhase[phase] : data.total)}</span>
            {hasMore && <Button variant="secondary" loading={loadingMore} onClick={loadMore} className="max-md:h-11">Load more</Button>}
          </div>
        </>
      )}
    </Page>
  );
}
