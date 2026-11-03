// Items: every issue and PR in the tracked repos, with full-text search and the
// settled type label. Every filter lives in the URL.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Popover } from "radix-ui";
import { CaretDownIcon, RadioButtonIcon, GitMergeIcon, GitPullRequestIcon, ListIcon, MagnifyingGlassIcon, ProhibitIcon, ShieldWarningIcon, FlagIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { ItemFilter, ItemList, ItemListRow, ItemSort, Settled, SettledStatus, Snippet, Stage, StatusFilter, TypeLabel } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge, type Tone } from "../../ui/Badge";
import { RefLink } from "../../ui/RefLink";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ErrorLine, Page, Pager, selectCls, TextInput, useUrlState } from "../admin/parts";
import { useNow } from "../../lib/useNow";

const PAGE = 50;
const LABELS: TypeLabel[] = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"];
const STATUS: Record<SettledStatus, [string, Tone]> = {
  settled: ["Settled", "ok"],
  waiting: ["Waiting for a second opinion", "warn"],
  disagree: ["Classifiers disagree", "bad"],
  unclassified: ["Not classified", "neutral"],
};
const STATUS_KEYS = Object.keys(STATUS) as SettledStatus[];
const FLAGS: [string, string][] = [["security", "Security"], ["needs decision", "Needs a decision"]];
const SORTS: [ItemSort, string][] = [["relevance", "Relevance"], ["updated", "Updated"], ["created", "Created"], ["number", "Number"]];
const STATES = [["open", "Open"], ["closed", "Closed"], ["merged", "Merged"], ["all", "Any state"]] as const;
const STAGE: Record<Stage, string> = {
  classified: "Classified", reviewed: "Reviewed", take: "Taken", hold: "Held", close: "To close", "needs-decision": "Waiting for a decision",
  batched: "In a batch", merged: "Merged by the pipeline", closed: "Closed by the pipeline", "fixed-by-us": "Fixed by us",
  "verify-planned": "Being verified", "verify-ci-enough": "CI is enough", "verify-error": "Verification not planned", "verify-unavailable": "Not verified",
  verified: "Verified", "verify-failed": "Verification failed",
};

/** "review.take-fix" as "Review › take fix". */
const flowLabel = (k: string) => {
  const [node, branch] = k.split(".");
  return `${node![0]!.toUpperCase()}${node!.slice(1)} › ${branch!.replace(/-/g, " ")}`;
};

const csv = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

function useFilter() {
  const { state, update } = useUrlState();
  const q = state.q?.trim() || undefined;
  const sort = SORTS.some(([k]) => k === state.sort) ? (state.sort as ItemSort) : undefined;
  const filter: ItemFilter = {
    q,
    repo: csv(state.repo),
    kind: state.kind === "pr" || state.kind === "issue" ? state.kind : undefined,
    state: STATES.some(([k]) => k === state.state) ? (state.state as ItemFilter["state"]) : "open",
    label: LABELS.includes(state.label as TypeLabel) ? (state.label as TypeLabel) : undefined,
    status: csv(state.status).filter((s): s is StatusFilter => s === "unsettled" || STATUS_KEYS.includes(s as SettledStatus)),
    flag: csv(state.flag).filter((f) => FLAGS.some(([k]) => k === f)),
    author: state.author?.trim() || undefined,
    since: /^\d{4}-\d{2}-\d{2}$/.test(state.since ?? "") ? state.since : undefined,
    flow: /^[a-z]+\.[a-z-]+$/.test(state.flow ?? "") ? state.flow : undefined,
    sort: sort === "relevance" && !q ? undefined : sort,
    desc: state.desc !== "0",
    limit: PAGE,
    offset: Math.max(0, Number(state.offset) || 0),
  };
  return { filter, update };
}

function ItemsView(_: ViewProps) {
  const { filter, update } = useFilter();
  const { data, error, loading } = useQuery(`items:${JSON.stringify(filter)}`, (api) => api.items(filter));
  const phone = useIsPhone();
  const set = (patch: Record<string, string | null>) => update({ ...patch, offset: null });
  const unsettled = data ? data.byStatus.waiting + data.byStatus.disagree : undefined;
  const statusOn = (s: StatusFilter) => filter.status?.includes(s) ?? false;

  return (
    <Page title="Items" sub={data && <Summary list={data} filter={filter} />}>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <QueryField value={filter.q ?? ""} onChange={(q) => set({ q: q || null, sort: null })} />
        <select aria-label="State" value={filter.state} onChange={(e) => set({ state: e.target.value === "open" ? null : e.target.value })} className={cn(selectCls, "text-ink/80")}>
          {STATES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Kind" value={filter.kind ?? ""} onChange={(e) => set({ kind: e.target.value || null })} className={cn(selectCls, filter.kind ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Issues and PRs</option>
          <option value="pr">PRs</option>
          <option value="issue">Issues</option>
        </select>
        <RepoPicker value={filter.repo ?? []} onChange={(r) => set({ repo: r.length ? r.join(",") : null })} />
        <select aria-label="Type label" value={filter.label ?? ""} onChange={(e) => set({ label: e.target.value || null })} className={cn(selectCls, filter.label ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Any type</option>
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort"
          value={filter.sort ?? (filter.q ? "relevance" : "updated")}
          onChange={(e) => set({ sort: e.target.value })}
          className={cn(selectCls, "text-ink/70 sm:ml-auto")}
        >
          {SORTS.filter(([k]) => k !== "relevance" || filter.q).map(([k, l]) => (
            <option key={k} value={k}>
              Sort: {l}
            </option>
          ))}
        </select>
        <button className="chip max-md:h-11" onClick={() => set({ desc: filter.desc ? "0" : null })} aria-label="Sort direction">
          {filter.desc ? (filter.sort === "number" ? "Highest first" : filter.sort === "relevance" || (!filter.sort && filter.q) ? "Best first" : "Newest first") : filter.sort === "number" ? "Lowest first" : filter.sort === "relevance" || (!filter.sort && filter.q) ? "Weakest first" : "Oldest first"}
        </button>
      </div>

      {filter.flow && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-ink/55">From the pipeline flow:</span>
          <button data-active className="chip max-md:h-11" onClick={() => set({ flow: null })} aria-label="Clear the flowchart branch">
            {flowLabel(filter.flow)} <XIcon className="opacity-60" />
          </button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="Classification" className="flex flex-wrap items-center gap-1">
          <button aria-pressed={!filter.status?.length} data-active={!filter.status?.length} className="chip max-md:h-11" onClick={() => set({ status: null })}>
            Any classification
          </button>
          <button aria-pressed={statusOn("unsettled")} data-active={statusOn("unsettled")} className="chip max-md:h-11" onClick={() => set({ status: statusOn("unsettled") ? null : "unsettled" })}>
            Unsettled <span className="num opacity-60">{unsettled !== undefined ? num(unsettled) : ""}</span>
          </button>
          {STATUS_KEYS.map((s) => (
            <button key={s} aria-pressed={statusOn(s)} data-active={statusOn(s)} className="chip max-md:h-11" onClick={() => set({ status: statusOn(s) ? null : s })}>
              {STATUS[s][0]} <span className="num opacity-60">{data ? num(data.byStatus[s]) : ""}</span>
            </button>
          ))}
        </div>
        {FLAGS.map(([k, l]) => {
          const on = filter.flag?.includes(k) ?? false;
          const next = on ? filter.flag!.filter((f) => f !== k) : [...(filter.flag ?? []), k];
          return (
            <button key={k} aria-pressed={on} data-active={on} className="chip max-md:h-11" onClick={() => set({ flag: next.length ? next.join(",") : null })}>
              {l}
            </button>
          );
        })}
        <DebouncedInput value={filter.author ?? ""} onChange={(v) => set({ author: v || null })} placeholder="Author login" label="Author" className="w-36" />
        <label className="flex items-center gap-1.5 text-xs text-ink/60">
          Updated since
          <TextInput type="date" value={filter.since ?? ""} onChange={(e) => set({ since: e.target.value || null })} className="w-[150px]" />
        </label>
      </div>

      <Block
        className="mt-3"
        flush
        title={<span className="flex items-center gap-2">{filter.q ? `Matches for “${filter.q}”` : "Items"}</span>}
        aside={loading && data ? "Updating…" : phone ? undefined : filter.q ? 'Words must all match; use "a phrase", prefix*, -word, OR.' : undefined}
      >
        <ErrorLine error={error?.message} className="p-4" />
        {data && data.rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No item matches these filters.</p>}
        {data && data.rows.length > 0 && (phone ? <Cards rows={data.rows} /> : <Table rows={data.rows} />)}
        {data && <Pager offset={filter.offset ?? 0} limit={PAGE} total={data.total} onOffset={(o) => update({ offset: o ? String(o) : null })} />}
      </Block>
    </Page>
  );
}

function Summary({ list, filter }: { list: ItemList; filter: ItemFilter }) {
  const all = Object.values(list.byStatus).reduce((a, b) => a + b, 0);
  return (
    <>
      {num(list.total)} {list.total === 1 ? "item" : "items"}
      {filter.status?.length ? ` of ${num(all)}` : ""} · {num(list.byStatus.settled)} settled, {num(list.byStatus.waiting)} waiting for a second opinion,{" "}
      {num(list.byStatus.disagree)} disagreements
      {list.run ? ` (run ${list.run})` : ""}
    </>
  );
}

function DebouncedInput({ value, onChange, placeholder, label, className, icon }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string; icon?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v.trim() === value) return;
    const t = setTimeout(() => onChange(v.trim()), 300);
    return () => clearTimeout(t);
  }, [v, value, onChange]);
  return (
    <label className={cn("flex h-8 items-center gap-2 rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60 max-md:h-11", className)}>
      {icon && <MagnifyingGlassIcon className="text-ink/40" />}
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onChange(v.trim())}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
      />
    </label>
  );
}

function QueryField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <DebouncedInput icon value={value} onChange={onChange} placeholder='Search titles, descriptions, comments' label="Search text" className="w-full sm:w-80" />;
}

function RepoPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const label = value.length === 0 ? "Every repo" : value.length === 1 ? value[0] : `${value.length} repos`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={cn(selectCls, "inline-flex items-center gap-1.5 px-2.5", value.length ? "text-accent-ink" : "text-ink/70")} aria-label="Repos">
          {label} <CaretDownIcon className="text-[11px] opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 max-h-[60vh] w-[240px] overflow-y-auto rounded-md border border-line-strong bg-raised p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise">
          {value.length > 0 && (
            <button className="mb-1 w-full rounded px-2 py-1.5 text-left text-xs text-accent-ink hover:bg-ink/[0.06]" onClick={() => onChange([])}>
              Clear: every repo
            </button>
          )}
          {repos?.map((r) => (
            <label key={r} className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-ink/[0.06] max-md:h-11">
              <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
              {r}
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A snippet with its matches marked (U+0002 … U+0003 from the server). */
function SnippetText({ s }: { s: Snippet }) {
  const parts = s.text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <span className="text-xs text-ink/60">
      <span className="text-ink/45">{s.field === "comment" ? `Comment${s.author ? ` by ${s.author}` : ""}: ` : s.field === "title" ? "Title: " : ""}</span>
      {parts.map((p, i) =>
        p.startsWith("\u0002") ? (
          <mark key={i} className="rounded-sm bg-warn/25 px-0.5 text-ink">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

function StateIcon({ it }: { it: ItemListRow }) {
  if (it.state === "merged") return <GitMergeIcon className="shrink-0 text-merged" aria-label="Merged" />;
  if (it.state === "closed") return <ProhibitIcon className="shrink-0 text-ink/45" aria-label="Closed" />;
  return it.kind === "pr" ? <GitPullRequestIcon className="shrink-0 text-ok" aria-label="Open PR" /> : <RadioButtonIcon className="shrink-0 text-ok" aria-label="Open issue" />;
}

/** The settled label, or why there is none. */
export function SettledBadge({ s, detail }: { s: Settled; detail?: boolean }) {
  const conf = s.confidence !== null ? ` ${s.confidence.toFixed(2)}` : "";
  if (s.status === "settled")
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={s.source === "jev" ? `Jev is sure (top probability${conf})` : `Jev unsure (${conf.trim()}), Haiku agrees`}>
        <Badge tone="ok">{s.label}</Badge>
        <span className="num text-2xs text-ink/45">{s.source === "jev" ? `Jev${conf}` : `Jev${conf} + Haiku`}</span>
      </span>
    );
  const [text, tone] = STATUS[s.status];
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge tone={tone}>{s.status === "waiting" ? "Waiting" : s.status === "disagree" ? "Disagree" : text}</Badge>
      {s.jevLabel && (
        <span className="text-2xs text-ink/50">
          Jev {s.jevLabel}
          {conf}
          {s.status === "disagree" ? ` · Haiku ${s.haikuLabel}` : ""}
          {s.referee && s.status === "disagree" ? ` · Sonnet ${s.referee.label}, unsure: ${s.referee.reason}` : ""}
        </span>
      )}
      {detail && (s.status === "waiting" || s.status === "disagree") && <span className="text-2xs text-ink/50">{text}</span>}
    </span>
  );
}

function Flags({ flags }: { flags: string[] }) {
  if (!flags.length) return <span className="text-ink/30">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.includes("security") && (
        <Badge tone="bad" icon={<ShieldWarningIcon className="text-[10px]" />}>
          security
        </Badge>
      )}
      {flags.includes("needs decision") && (
        <Badge tone="warn" icon={<FlagIcon className="text-[10px]" />}>
          decision
        </Badge>
      )}
    </span>
  );
}

function Table({ rows }: { rows: ItemListRow[] }) {
  useNow();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs text-ink/55">
          <tr className="border-b border-line text-left">
            <th className="h-8 px-3 font-medium">Item</th>
            <th className="w-[120px] px-3 font-medium">Author</th>
            <th className="w-[80px] px-3 font-medium">Updated</th>
            <th className="w-[230px] px-3 font-medium">Type</th>
            <th className="w-[120px] px-3 font-medium">Flags</th>
            <th className="w-[120px] px-3 font-medium">Stage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it) => (
            <tr key={`${it.repo}#${it.number}`} className="border-b border-line align-top last:border-0 hover:bg-ink/[0.03]">
              <td className="max-w-0 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <StateIcon it={it} />
                  <RefLink repo={it.repo} number={it.number} kind={it.kind} className="shrink-0 text-xs" />
                  <Link to={`/item/${it.repo}/${it.number}`} className="truncate font-medium hover:text-accent-ink hover:underline" title={it.title}>
                    {it.title}
                  </Link>
                </div>
                {it.snippet && it.snippet.field !== "title" && (
                  <div className="mt-0.5 line-clamp-2 pl-6">
                    <SnippetText s={it.snippet} />
                  </div>
                )}
              </td>
              <td className="truncate px-3 py-2 text-ink/70">{it.author}</td>
              <td className="num whitespace-nowrap px-3 py-2 text-ink/55" title={`created ${it.createdAt.slice(0, 10)}, updated ${it.updatedAt.slice(0, 16).replace("T", " ")}`}>
                {it.updatedAt ? `${ago(it.updatedAt)} ago` : "–"}
              </td>
              <td className="px-3 py-2">
                <SettledBadge s={it.settled} />
              </td>
              <td className="px-3 py-2">
                <Flags flags={it.settled.flags} />
              </td>
              <td className="px-3 py-2 text-xs text-ink/60">{it.stage ? STAGE[it.stage] : <span className="text-ink/30">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ rows }: { rows: ItemListRow[] }) {
  useNow();
  return (
    <ul>
      {rows.map((it) => (
        <li key={`${it.repo}#${it.number}`} className="border-b border-line last:border-0">
          <Link to={`/item/${it.repo}/${it.number}`} className="block px-4 py-2.5 active:bg-ink/[0.05]">
            <div className="flex items-center gap-2 text-xs text-ink/55">
              <StateIcon it={it} />
              <span className="code">
                {it.repo}#{it.number}
              </span>
              <span className="truncate">{it.author}</span>
              <span className="num ml-auto shrink-0">{it.updatedAt ? `${ago(it.updatedAt)} ago` : ""}</span>
            </div>
            <div className="mt-1 text-sm font-medium leading-5">{it.title}</div>
            {it.snippet && it.snippet.field !== "title" && (
              <div className="mt-1 line-clamp-2">
                <SnippetText s={it.snippet} />
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <SettledBadge s={it.settled} />
              {it.settled.flags.length > 0 && <Flags flags={it.settled.flags} />}
              {it.stage && <span className="text-2xs text-ink/55">{STAGE[it.stage]}</span>}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export const itemsModule: FeatureModule = {
  id: "items",
  permission: "viewer",
  nav: { label: "Items", icon: ListIcon, to: "/items", group: "work", order: 2 },
  commands: [{ id: "go-items", keys: "g i", label: "Go to items", group: "Go to" }],
  routes: [{ path: "items", view: { id: "items", title: "Items", panels: [{ id: "main", title: "Items", component: ItemsView, defaultSize: 100 }] } }],
};
