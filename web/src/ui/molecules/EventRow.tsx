import { Link } from "react-router-dom";
import { GitMergeIcon, PencilSimpleIcon, QuestionIcon, WarningIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { NowEvent, NowEventKind } from "../../api/types";
import { itemPath } from "../../lib/links";
import { cn } from "../cn";
import { TimeAgo } from "../atoms/TimeAgo";
import { ItemRef } from "./ItemRef";

const ICON: Record<NowEventKind, PhosphorIcon> = { write: PencilSimpleIcon, merge: GitMergeIcon, decision: QuestionIcon, failure: WarningIcon };

/** One thing that happened, in the running row's style. The row opens the item's timeline at the event, else the detail page. */
export function EventRow({ ev }: { ev: NowEvent }) {
  const Icon = ICON[ev.kind];
  const href = ev.item && ev.event ? `${itemPath(ev.item.repo, ev.item.number)}#event=${encodeURIComponent(ev.event)}` : (ev.detail ?? (ev.item ? itemPath(ev.item.repo, ev.item.number) : null));
  const text = <span className="block break-words text-sm leading-5 [overflow-wrap:anywhere]">{ev.summary}</span>;
  return (
    <li className="relative flex gap-2.5 border-b border-line px-3 py-2 last:border-0 hover:bg-ink/[0.03] max-md:min-h-11">
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-panel", ev.kind === "failure" ? "border-bad/40 text-bad" : "border-line-strong text-ink/60")}>
        <Icon className="text-[11px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {href ? (
          <Link to={href} className="block after:absolute after:inset-0">
            {text}
          </Link>
        ) : (
          text
        )}
        {ev.item && <ItemRef repo={ev.item.repo} number={ev.item.number} kind={ev.item.kind} state={ev.item.state} title={ev.item.title} size="sm" className="relative z-10 mt-1 w-fit max-w-full" />}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink/55">
          <span>{ev.actor}</span>
          <TimeAgo iso={ev.at} className="num" />
        </span>
      </div>
    </li>
  );
}
