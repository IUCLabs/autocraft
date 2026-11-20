import { CaretRightIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { cn } from "../../ui/cn";

/** A chevron row that shows its children when opened. `summary` sits after the title, muted. */
export function Fold({ title, summary, children, className, open: initial = false }: { title: ReactNode; summary?: ReactNode; children: ReactNode; className?: string; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex min-h-7 items-center gap-1.5 text-sm text-ink/80 hover:text-ink max-md:min-h-11">
        <CaretRightIcon aria-hidden className={cn("shrink-0 text-ink/50 transition-transform duration-fast", open && "rotate-90")} />
        {title}
        {summary !== undefined && <span className="text-ink/55">{summary}</span>}
      </button>
      {open && children}
    </div>
  );
}
