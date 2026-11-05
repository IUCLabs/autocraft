import type { ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon, GearSixIcon } from "@phosphor-icons/react";
import { cn } from "../cn";

/** A run of pipeline events folded into one disclosure row; `children` are the rows and render only while open. */
export function PipelineRun({ id, count, from, open, onToggle, children }: {
  id: string;
  count: number;
  /** Who and when the run covers, shown after the count. */
  from?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const Caret = open ? CaretDownIcon : CaretRightIcon;
  return (
    <li id={`event-${id}`} className="list-none">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={cn("flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink/60 transition-colors duration-fast hover:bg-ink/[0.04] max-md:min-h-11", open && "bg-ink/[0.03]")}
      >
        <GearSixIcon className="shrink-0 text-[13px] text-accent-ink" />
        <span className="font-medium">{count} pipeline {count === 1 ? "event" : "events"}</span>
        {from && <span className="min-w-0 truncate text-ink/45">{from}</span>}
        <Caret className="ml-auto shrink-0 text-ink/40" />
      </button>
      {open && <div className="mt-1 overflow-hidden rounded-md border border-line">{children}</div>}
    </li>
  );
}
