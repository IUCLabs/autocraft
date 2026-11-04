import { Link } from "react-router-dom";
import { CubeIcon, GearIcon, GitMergeIcon, SparkleIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { NowRunning, NowRunningKind } from "../../api/types";
import { nowMs, num, span } from "../../lib/format";
import { itemPath } from "../../lib/links";
import { Badge } from "../atoms/Badge";
import { ItemRef } from "./ItemRef";

const ICON: Record<NowRunningKind, PhosphorIcon> = { "model-call": SparkleIcon, job: GearIcon, task: CubeIcon, batch: GitMergeIcon };

/** Where a row leads: the item's timeline at the row's event, else the run, job, task or batch page. */
export const rowHref = (r: Pick<NowRunning, "items" | "event" | "detail">): string => {
  const first = r.items[0];
  return first && r.event ? `${itemPath(first.repo, first.number)}#event=${encodeURIComponent(r.event)}` : r.detail;
};

/** One thing in progress: what it is, how long, the latest progress line, and the items it works on. The row is the link; item links sit above it. */
export function RunningRow({ row }: { row: NowRunning }) {
  const Icon = ICON[row.kind];
  const more = row.itemCount - row.items.length;
  return (
    <li className="relative flex gap-2.5 border-b border-line px-3 py-2 last:border-0 hover:bg-ink/[0.03] max-md:min-h-11">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel text-ink/60">
        <Icon className="text-[11px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link to={rowHref(row)} className="text-sm font-medium after:absolute after:inset-0">
            {row.step}
          </Link>
          {row.what && <Badge tone={row.kind === "model-call" ? "accent" : "neutral"}>{row.what}</Badge>}
          {row.state === "queued" && <Badge>Queued</Badge>}
          <span className="num ml-auto text-xs text-ink/60">{span(nowMs() - Date.parse(row.startedAt))}</span>
        </div>
        {row.items.length > 0 && (
          <div className="mt-1 flex flex-col items-start gap-0.5">
            {row.items.map((i) => (
              <ItemRef key={`${i.repo}#${i.number}`} repo={i.repo} number={i.number} kind={i.kind} state={i.state} title={i.title} size="sm" className="relative z-10 w-fit max-w-full" />
            ))}
            {more > 0 && <span className="text-xs text-ink/50">+{num(more)} more</span>}
          </div>
        )}
        {row.items.length === 0 && row.repo && <p className="mt-1 text-xs text-ink/55">{row.repo}</p>}
        {row.progress && <p className="mt-1 text-xs text-ink/50 [overflow-wrap:anywhere]">{row.progress}</p>}
        {row.children.length > 0 && (
          <ul className="mt-1.5 ml-1 border-l border-line pl-3">
            {row.children.map((c) => (
              <ChildRow key={c.key} row={c} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** A model call or build task of a job, under the job's row, with its own elapsed time and link. */
function ChildRow({ row }: { row: NowRunning }) {
  const Icon = ICON[row.kind];
  return (
    <li className="relative flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded py-1 hover:bg-ink/[0.04] max-md:min-h-11">
      <Icon className="shrink-0 text-ink/55" aria-hidden />
      <Link to={rowHref(row)} className="text-xs font-medium after:absolute after:inset-0">
        {row.kind === "task" ? "Build task" : row.step}
      </Link>
      {row.what && <Badge tone={row.kind === "model-call" ? "accent" : "neutral"}>{row.what}</Badge>}
      {row.state === "queued" && <Badge>Queued</Badge>}
      <span className="num ml-auto text-xs text-ink/60">{span(nowMs() - Date.parse(row.startedAt))}</span>
      {row.progress && <p className="w-full text-xs text-ink/50 [overflow-wrap:anywhere]">{row.progress}</p>}
    </li>
  );
}
