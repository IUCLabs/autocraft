// Workable: the one way to show a PR or an issue in a list. A table whose rows are items: the item (lead, icon, repo#number, title and a
// line below it) in the first column, the page's own columns after it, and an optional detail that opens under the row. Rows sit in groups
// with a header (title, count, hint and a control). On a phone the header hides and a row's cells wrap under the item.
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { ItemKind, ItemState } from "../../api/types";
import { ItemRef } from "../molecules/ItemRef";
import { num } from "../../lib/format";
import { cn } from "../cn";

export interface WorkableColumn {
  id: string;
  label: ReactNode;
  /** A CSS grid track, e.g. `120px`. */
  width: string;
  /** Header tooltip. */
  hint?: string;
  align?: "start" | "end";
  /** Shown only on wide screens (xl and up) and on a phone, where cells wrap; left out in between so the item keeps its room. */
  wide?: boolean;
}

export interface WorkableItem {
  repo: string;
  number: number;
  kind?: ItemKind | null;
  state?: ItemState | null;
  draft?: boolean;
  title: string | null | undefined;
}

const Columns = createContext<WorkableColumn[]>([]);

/** The item column never gets narrower than this; below the table's full width it scrolls sideways. */
const ITEM_MIN = 280;
const GAP = 16;
const PAD = 32;

/** Item column, then the page's columns. */
const template = (cols: WorkableColumn[]) => [`minmax(${ITEM_MIN}px,1fr)`, ...cols.map((c) => c.width)].join(" ");
/** The width the columns need: the item minimum, every column, the gaps and the row padding. Widths given in px count; others count 0. */
const minWidth = (cols: WorkableColumn[]) => ITEM_MIN + PAD + cols.reduce((s, c) => s + (parseFloat(c.width) || 0) + GAP, 0);
const grid = "md:grid md:grid-cols-[var(--wk-cols-md)] xl:grid-cols-[var(--wk-cols)] md:gap-x-4";
const narrow = (cols: WorkableColumn[]) => cols.filter((c) => !c.wide);

export function WorkableTable({ columns, label, itemLabel = "Item", children, className }: { columns: WorkableColumn[]; label: string; itemLabel?: string; children: ReactNode; className?: string }) {
  return (
    <Columns.Provider value={columns}>
      <div className={cn("overflow-x-auto rounded-md border border-line", className)}>
      <div role="table" aria-label={label} style={{ "--wk-cols": template(columns), "--wk-cols-md": template(narrow(columns)), "--wk-min": `${minWidth(columns)}px`, "--wk-min-md": `${minWidth(narrow(columns))}px` } as CSSProperties} className="text-sm md:min-w-[var(--wk-min-md)] xl:min-w-[var(--wk-min)]">
        <div role="row" className={cn(grid, "border-b border-line bg-ink/[0.03] px-4 py-1.5 text-xs font-medium text-ink/55 max-md:hidden")}>
          <span role="columnheader" className="pl-8">
            {itemLabel}
          </span>
          {columns.map((c) => (
            <span key={c.id} role="columnheader" title={c.hint} className={cn(c.align === "end" && "text-right", c.wide && "max-xl:hidden")}>
              {c.label}
            </span>
          ))}
        </div>
        {children}
      </div>
      </div>
    </Columns.Provider>
  );
}

/** A group of rows under a header bar; nothing renders when it has no rows. */
export function WorkableGroup({ title, count, hint, dot, aside, children, id }: { title: ReactNode; count?: number; hint?: ReactNode; dot?: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div role="rowgroup" id={id} className="border-b border-line last:border-0">
      <div role="row" className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line bg-ink/[0.04] px-4 py-1.5">
        <span role="rowheader" className="inline-flex items-center gap-2 text-sm font-semibold">
          {dot && <span className={cn("size-2 rounded-full", dot)} aria-hidden />}
          {title}
        </span>
        {count !== undefined && <span className="num rounded-full bg-ink/[0.07] px-1.5 text-2xs text-ink/70">{num(count)}</span>}
        {hint && <span className="text-xs text-ink/50">{hint}</span>}
        {aside && <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * One item. `lead` is a short mark before the icon in a fixed slot (a merge position; null keeps the slot empty so titles line up); `sub` is a line under the title; `cells` fill the table's columns
 * by id; `detail` opens under the row by its caret. The item link covers the row, so controls in cells need `relative z-10`.
 */
export function WorkableRow({ item, lead, sub, cells, detail, highlight, dataItem }: {
  item: WorkableItem;
  lead?: ReactNode;
  sub?: ReactNode;
  cells: Record<string, ReactNode>;
  detail?: ReactNode;
  highlight?: boolean;
  dataItem?: string;
}) {
  const columns = useContext(Columns);
  const [open, setOpen] = useState(false);
  return (
    <div role="row" data-item={dataItem} className={cn("relative border-b border-line px-4 py-2 last:border-0 hover:bg-ink/[0.03]", highlight && "bg-accent/10")}>
      <div className={cn(grid, "items-start max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2.5 max-md:gap-y-1.5")}>
        <div role="cell" className="flex min-w-0 items-start gap-1.5 max-md:basis-full">
          <span className="flex w-6 shrink-0 justify-end pt-px">
            {detail ? (
              <button type="button" aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} onClick={() => setOpen(!open)} className="relative z-10 mt-0.5 text-ink/40 hover:text-ink max-md:-m-3 max-md:p-3">
                <CaretRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              </button>
            ) : null}
          </span>
          {lead !== undefined && <span className="flex w-10 shrink-0 justify-end pt-px">{lead}</span>}
          <div className="min-w-0 flex-1">
            <ItemRef repo={item.repo} number={item.number} kind={item.kind} state={item.state} draft={item.draft} title={item.title} stretch />
            {sub && <div className="mt-0.5 pl-6 text-2xs text-ink/55">{sub}</div>}
          </div>
        </div>
        {columns.map((c) => {
          const v = cells[c.id];
          return (
            <div key={c.id} role="cell" className={cn("min-w-0 md:pt-0.5", c.align === "end" && "md:flex md:justify-end", c.wide && "md:max-xl:hidden", v == null && "max-md:hidden", c.align === "end" && "max-md:ml-auto")}>
              {v ?? <span className="text-ink/30">–</span>}
            </div>
          );
        })}
      </div>
      {detail && open && <div className="mt-2 pl-8 md:pr-4">{detail}</div>}
    </div>
  );
}
