import { DropdownMenu } from "radix-ui";
import { ChevronDownIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { DecisionKind } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { cn } from "../../ui/cn";
import { KIND_LABEL, KINDS, useDecisionFilter } from "./state";

const AGES = [
  { v: "", label: "Any age" },
  { v: "1", label: "Older than 1 day" },
  { v: "2", label: "Older than 2 days" },
  { v: "3", label: "Older than 3 days" },
];

export function DecisionsToolbar(props: ViewProps & { phone?: boolean }) {
  const { phone } = props;
  const { filter, update } = useDecisionFilter();
  const { data: open } = useQuery("count:open", (api) => api.decisions.list({ status: "open" }));
  const { data: answered } = useQuery("count:answered", (api) => api.decisions.list({ status: "answered" }));
  const { data: proposals } = useQuery("count:proposals", (api) => api.decisions.list({ status: "proposals" }));
  const tabs = [
    { t: "open" as const, label: "Waiting", n: open?.total },
    // Operators approve proposals; everyone else sees them on the cards.
    ...(props.user.role === "operator" ? [{ t: "proposals" as const, label: "Proposals", n: proposals?.total }] : []),
    { t: "answered" as const, label: "Answered", n: answered?.total },
  ];
  const kinds = filter.kind ?? [];
  const toggleKind = (k: DecisionKind) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    update({ kind: next.length ? next.join(",") : null });
  };

  return (
    <div className={cn("flex items-center gap-x-4 gap-y-2", phone ? "flex-wrap" : "flex-nowrap")}>
      <div role="tablist" aria-label="Status" className="flex shrink-0 border border-line">
        {tabs.map(({ t, label, n }) => (
          <button
            key={t}
            role="tab"
            aria-selected={filter.status === t}
            onClick={() => update({ tab: t === "open" ? null : t })}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-none px-3 font-mono text-xs font-semibold uppercase tracking-[0.12em]",
              filter.status === t ? "bg-ink text-inv" : t === "proposals" && n ? "text-accent-ink hover:text-ink" : "text-ink/60 hover:text-ink",
            )}
          >
            {label}
            <span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>
      <div className={cn("flex items-center gap-1", phone ? "flex-wrap" : "min-w-0 overflow-x-auto scrollbar-none")}>
        {KINDS.map((k) => (
          <button key={k} className="filter-tab" data-active={kinds.includes(k)} aria-pressed={kinds.includes(k)} onClick={() => toggleKind(k)}>
            {KIND_LABEL[k]}
            {open?.byKind[k] ? <span className="opacity-55">{open.byKind[k]}</span> : null}
          </button>
        ))}
      </div>
      <div className={cn("flex items-center gap-2", !phone && "ml-auto")}>
        <RepoPicker selected={filter.repo ?? []} onChange={(r) => update({ repo: r.length ? r.join(",") : null })} />
        <Picker label={AGES.find((a) => a.v === String(filter.minAge ?? ""))?.label ?? "Any age"} items={AGES} onPick={(v) => update({ age: v || null })} />
        <button className="filter-tab" data-active={!!filter.mine} aria-pressed={!!filter.mine} onClick={() => update({ mine: filter.mine ? null : "1" })} title="Only repos where you have write access">
          My repos
        </button>
      </div>
    </div>
  );
}

const menuCls = "z-50 max-h-[60vh] min-w-[200px] overflow-y-auto border border-line bg-raised py-1 shadow-[0_12px_40px_rgba(0,0,0,0.4)] animate-rise";
const itemCls = "flex h-8 cursor-default items-center gap-2.5 px-3 text-sm outline-none data-[highlighted]:bg-ink/5";

function Picker({ label, items, onPick }: { label: string; items: { v: string; label: string }[]; onPick: (v: string) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="filter-tab">
        {label} <ChevronDownIcon className="text-[10px]" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuCls}>
          {items.map((i) => (
            <DropdownMenu.Item key={i.v} onSelect={() => onPick(i.v)} className={itemCls}>
              {i.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RepoPicker({ selected, onChange }: { selected: string[]; onChange: (r: string[]) => void }) {
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const label = selected.length === 0 ? "All repos" : selected.length === 1 ? selected[0] : `${selected.length} repos`;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="filter-tab" data-active={selected.length > 0}>
        {label} <ChevronDownIcon className="text-[10px]" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuCls}>
          {selected.length > 0 && (
            <DropdownMenu.Item onSelect={() => onChange([])} className={cn(itemCls, "text-ink/60")}>
              Clear
            </DropdownMenu.Item>
          )}
          {repos?.map((r) => (
            <DropdownMenu.CheckboxItem
              key={r}
              checked={selected.includes(r)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(c) => onChange(c ? [...selected, r] : selected.filter((x) => x !== r))}
              className={cn(itemCls, "font-mono text-xs")}
            >
              <span className="flex size-3 items-center justify-center border border-line-strong">
                <DropdownMenu.ItemIndicator>
                  <span className="block size-1.5 bg-ink" />
                </DropdownMenu.ItemIndicator>
              </span>
              {r}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
