import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react";
import type { ViewProps } from "../../registry/types";
import { cn } from "../../ui/cn";
import { AnswerNotice } from "./AnswerNotice";
import { DecisionBody, NoDecision } from "./DecisionDetail";
import { useInboxKeys, summaryLine } from "./InboxList";
import { DecisionsToolbar } from "./Toolbar";
import { ordered, useDecisionFilter, useDecisionList, useLocal, usePinned, useSelection } from "./state";

/** Phone flow: one decision per screen with previous/next, filters in a sheet. */
export function PhoneInbox(props: ViewProps) {
  const { data } = useDecisionList();
  const { filter } = useDecisionFilter();
  const { id, go, byLink, item, missing } = useSelection();
  const loc = useLocal();
  const [sheet, setSheet] = useState(false);
  const list = ordered(data?.decisions ?? []);
  useInboxKeys(list);
  const idx = list.findIndex((d) => d.id === id);
  const pinned = usePinned(id, idx >= 0);
  const d = list[idx] ?? pinned;
  const active = (filter.kind?.length ?? 0) + (filter.repo?.length ?? 0) + (filter.minAge ? 1 : 0) + (filter.mine ? 1 : 0);

  useEffect(() => {
    if (!id && !byLink && list.length) go(list[0], true);
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
      {loc.justAnswered.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="shrink-0 border-b border-line px-4" />
      ))}
      <div className="flex min-h-0 flex-1 flex-col">
        {d ? <DecisionBody key={d.id} d={d} user={props.user} phone onAnswered={() => go(list[idx + 1] ?? list[idx - 1], true)} pager={{ pos: `${idx + 1} of ${list.length}`, prev: idx > 0 ? () => go(list[idx - 1]) : undefined, next: idx < list.length - 1 ? () => go(list[idx + 1]) : undefined }} /> : missing && item ? <NoDecision repo={item.repo} number={item.number} /> : <p className="py-16 text-center text-sm text-ink/60">Nothing waiting.</p>}
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
