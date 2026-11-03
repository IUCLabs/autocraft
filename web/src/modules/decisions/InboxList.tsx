import { useEffect, useRef } from "react";
import { QueueBadge } from "../../ui/QueueBadge";
import { useNavigate } from "react-router-dom";
import { CheckIcon, ArrowUUpLeftIcon, UsersIcon } from "@phosphor-icons/react";
import type { Decision, DecisionList } from "../../api/types";
import type { Command, ViewProps } from "../../registry/types";
import { useHotkeys, useShortcutHelp } from "../../shell/keyboard";
import { Count } from "../../ui/Heading";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ago, ageDays } from "../../lib/format";
import { RefLink } from "../../ui/RefLink";
import { ClaimPill, KIND_ICON } from "./parts";
import { KIND_LABEL, KINDS, localActions, ordered, useDecisionFilter, useDecisionList, useLocal, useSelection, useUndo } from "./state";
import { useNow } from "../../lib/useNow";
import { itemPath } from "../../lib/links";

const SHORTCUTS: Command[] = [
  { id: "d-next", keys: "j", label: "Next decision", group: "Decisions" },
  { id: "d-prev", keys: "k", label: "Previous decision", group: "Decisions" },
  { id: "d-answer", keys: "1 – 4", label: "Select a Workflow option (only after you opened the decision; it never submits)", group: "Decisions" },
  { id: "d-confirm", keys: "1 – 4 again, Enter", label: "Confirm an option that writes to GitHub (Esc cancels)", group: "Decisions" },
  { id: "d-note", keys: "n", label: "Write the Workflow note", group: "Decisions" },
  { id: "d-check", keys: "x", label: "Check for a batch answer", group: "Decisions" },
  { id: "d-undo", keys: "u", label: "Undo last answer", group: "Decisions" },
  { id: "d-open", keys: "o", label: "Open the item page", group: "Decisions" },
  { id: "d-tab", keys: "g a", label: "Waiting / answered tab", group: "Decisions" },
];

export function summaryLine(data: DecisionList | undefined) {
  if (!data) return "";
  const parts = KINDS.filter((k) => data.byKind[k]).map((k) => `${data.byKind[k]} ${KIND_LABEL[k].toLowerCase()}`);
  return parts.join(" · ");
}

export function useInboxKeys(list: Decision[]) {
  const { id, go } = useSelection();
  const { filter, update } = useDecisionFilter();
  const undo = useUndo();
  const navigate = useNavigate();
  const idx = list.findIndex((d) => d.id === id);
  const cur = list[idx];
  useShortcutHelp(SHORTCUTS);
  useHotkeys({
    j: () => go(list[Math.min(idx + 1, list.length - 1)]),
    k: () => go(list[Math.max(idx - 1, 0)]),
    x: () => cur && localActions.toggle(cur.id),
    u: () => void undo(),
    o: () => cur?.number != null && navigate(itemPath(cur.repo, cur.number)),
    escape: () => localActions.clearChecked(),
    "g a": () => update({ tab: filter.status === "answered" ? null : "answered" }),
  });
}

export function InboxList({ user }: ViewProps) {
  useNow();
  const { data, loading, hasMore, loadMore, loadingMore } = useDecisionList();
  const { id, go, byLink } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  useInboxKeys(list);
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [id]);
  // Open the oldest decision when nothing is selected, so the detail pane is never empty on arrival.
  useEffect(() => {
    if (!id && !byLink && list.length && !loc.justAnswered.length) go(list[0], true);
  }, [id, byLink, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups: { kind: Decision["kind"]; items: Decision[] }[] = [];
  for (const d of list) {
    const g = groups.find((x) => x.kind === d.kind);
    g ? g.items.push(d) : groups.push({ kind: d.kind, items: [d] });
  }
  const oldest = data?.oldestAskedAt;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-xs">
        <span className="num shrink-0 whitespace-nowrap font-semibold text-ink">{data?.total ?? "–"} decisions</span>
        <span className="truncate text-ink/50">{summaryLine(data) || (loading ? "loading…" : "nothing matches")}</span>
        {oldest && <span className="ml-auto shrink-0 text-ink/50">oldest {ago(oldest)}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Decisions">
        {loc.justAnswered.slice(0, 3).map((a) => (
          <JustAnswered key={a.id} entry={a} />
        ))}
        {groups.map((g) => {
          const Icon = KIND_ICON[g.kind];
          return (
            <div key={g.kind}>
              <div className="sticky top-0 z-[1] flex h-8 items-center gap-1.5 border-b border-line bg-bg px-4 text-xs font-semibold text-ink/70">
                <Icon className="text-[12px] text-ink/45" />
                {KIND_LABEL[g.kind]}
                <Count n={g.items.length} />
              </div>
              {g.items.map((d) => (
                <Row key={d.id} d={d} active={d.id === id} checked={loc.checked.has(d.id)} mine={d.opinions.find((o) => o.login === user.login)?.option ?? undefined} onOpen={() => go(d)} activeRef={d.id === id ? activeRef : undefined} />
              ))}
            </div>
          );
        })}
        {hasMore && data && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-ink/55">
            <span className="num">
              {data.decisions.length} of {data.total}
            </span>
            <button className="chip" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ d, active, checked, mine, onOpen, activeRef }: { d: Decision; active: boolean; checked: boolean; mine?: string; onOpen: () => void; activeRef?: React.Ref<HTMLDivElement> }) {
  useNow();
  const old = ageDays(d.askedAt) >= 2;
  const opinions = d.opinions.length;
  return (
    <div className={cn("group relative flex border-b border-line", active ? "bg-accent/[0.08]" : "hover:bg-ink/[0.03]")}>
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <label className="flex w-9 shrink-0 cursor-pointer items-start justify-center pt-[11px]" title="Select for a batch answer (x)">
        <input type="checkbox" checked={checked} onChange={() => localActions.toggle(d.id)} className="peer sr-only" aria-label={`Select ${d.title}`} />
        <span className={cn("flex size-3.5 items-center justify-center rounded-sm border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent-ink", checked ? "border-accent bg-accent text-white" : "border-line-strong opacity-50 group-hover:opacity-100")}>
          {checked && <CheckIcon className="text-[10px]" weight="bold" />}
        </span>
      </label>
      <div ref={activeRef} role="option" tabIndex={0} aria-selected={active} onClick={onOpen} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } }} className="min-w-0 flex-1 cursor-pointer rounded-none py-2 pr-3 text-left">
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 break-words text-sm", active ? "font-medium text-ink" : "text-ink/90")}>{d.title}</span>
          <span className={cn("num shrink-0 text-xs", old ? "text-warn" : "text-ink/45")} title={`asked ${ago(d.askedAt, false)}`}>
            {ago(d.askedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink/50">
          {d.number === null ? <span className="code shrink-0 text-[11.5px]">{d.repo}</span> : <RefLink repo={d.repo} number={d.number} stop className="shrink-0 text-[11.5px] text-ink/50" />}
          {d.number === null && <span className="shrink-0">· {d.items.length} items</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {opinions > 0 && (
              <span className={cn("inline-flex items-center gap-0.5", mine && "text-accent-ink")} title={`picked by ${opinions}${mine ? ", including you" : ""}`}>
                <UsersIcon className="text-[11px]" />
                <span className="num">{opinions}</span>
              </span>
            )}
            {d.number !== null && <QueueBadge slot={d.queue} repo={d.repo} number={d.number} />}
            <ClaimPill claim={d.claim} compact />
          </span>
        </div>
      </div>
    </div>
  );
}

function JustAnswered({ entry }: { entry: { id: string; label: string; ref: string } }) {
  const undo = useUndo();
  return (
    <div className="flex h-9 items-center gap-2 border-b border-line bg-ok/[0.06] pl-4 pr-2 text-xs animate-fadeIn">
      <CheckIcon className="shrink-0 text-ok" />
      <span className="code shrink-0 text-ink/70">{entry.ref}</span>
      <span className="truncate text-ink/60">→ {entry.label}</span>
      <Button size="sm" variant="ghost" icon={ArrowUUpLeftIcon} className="ml-auto" onClick={() => void undo(entry.id)}>
        Undo
      </Button>
    </div>
  );
}
