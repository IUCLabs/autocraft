import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { ChevronLeftIcon, ChevronRightIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import type { ViewProps } from "../../registry/types";
import { cn } from "../../ui/cn";
import { DecisionBody } from "./DecisionDetail";
import { useInboxKeys, summaryLine } from "./InboxList";
import { DecisionsToolbar } from "./Toolbar";
import { ordered, useDecisionFilter, useDecisionList, useLocal, useSelection, useUndo } from "./state";

/** Phone flow: one decision per screen with previous/next, filters in a sheet. */
export function PhoneInbox(props: ViewProps) {
  const { data } = useDecisionList();
  const { filter } = useDecisionFilter();
  const { id, go } = useSelection();
  const loc = useLocal();
  const undo = useUndo();
  const [sheet, setSheet] = useState(false);
  const list = ordered(data?.decisions ?? []);
  useInboxKeys(list);
  const idx = list.findIndex((d) => d.id === id);
  const d = list[idx];
  const active = (filter.kind?.length ?? 0) + (filter.repo?.length ?? 0) + (filter.minAge ? 1 : 0) + (filter.mine ? 1 : 0);
  const last = loc.justAnswered[0];

  useEffect(() => {
    if (!id && list.length) go(list[0].id);
  }, [id, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="num shrink-0 text-sm font-semibold">{data?.total ?? "–"} decisions</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink/50">{summaryLine(data)}</span>
        <button onClick={() => setSheet(true)} className={cn("chip h-8", active > 0 && "border-accent/50 text-accent-ink")} aria-label="Filters">
          <SlidersHorizontalIcon className="text-[11px]" />
          {active > 0 ? active : "Filter"}
        </button>
      </div>
      {last && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-ok/[0.07] px-4 animate-fadeIn">
          <span className="code shrink-0 text-ink/70">{last.ref}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink/60">→ {last.label}</span>
          <button onClick={() => void undo()} className="flex h-10 items-center px-2 text-sm font-medium text-accent-ink">
            Undo
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">
        {d ? <DecisionBody key={d.id} d={d} user={props.user} phone onAnswered={() => go(list[idx + 1]?.id ?? list[idx - 1]?.id)} /> : <p className="py-16 text-center text-sm text-ink/60">Nothing waiting.</p>}
      </div>
      <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-line bg-bg">
        <button disabled={idx <= 0} onClick={() => go(list[idx - 1]?.id)} className="flex h-12 items-center gap-1 rounded-none px-3 text-sm text-ink/70 disabled:opacity-30">
          <ChevronLeftIcon /> Prev
        </button>
        <span className="num text-xs text-ink/55">{idx >= 0 ? `${idx + 1} of ${list.length}` : ""}</span>
        <button disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1]?.id)} className="flex h-12 items-center justify-end gap-1 rounded-none px-3 text-sm font-medium text-ink disabled:opacity-30">
          Next <ChevronRightIcon />
        </button>
      </div>
      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fadeIn" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 rounded-t-lg border-t border-line-strong bg-raised px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 animate-rise">
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="text-md font-semibold">Filter decisions</Dialog.Title>
              <Dialog.Close className="flex size-11 items-center justify-center text-ink/60" aria-label="Close">
                <XIcon />
              </Dialog.Close>
            </div>
            <DecisionsToolbar {...props} phone />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
