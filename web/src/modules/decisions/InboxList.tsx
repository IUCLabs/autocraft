import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { CheckIcon, LockIcon, Undo2Icon } from "lucide-react";
import type { Decision, DecisionList } from "../../api/types";
import type { Command, ViewProps } from "../../registry/types";
import { decisionAccess } from "../../registry/permissions";
import { useHotkeys, useShortcutHelp } from "../../shell/keyboard";
import { Hud } from "../../ui/Hud";
import { cn } from "../../ui/cn";
import { ago, ageDays } from "../../lib/format";
import { ClaimPill, KIND_ICON } from "./parts";
import { KIND_LABEL, KINDS, localActions, ordered, useDecisionFilter, useDecisionList, useLocal, useSelection, useUndo } from "./state";

const SHORTCUTS: Command[] = [
  { id: "d-next", keys: "j", label: "Next decision", group: "Decisions" },
  { id: "d-prev", keys: "k", label: "Previous decision", group: "Decisions" },
  { id: "d-answer", keys: "1 – 4", label: "Answer with option", group: "Decisions" },
  { id: "d-note", keys: "n", label: "Write a note", group: "Decisions" },
  { id: "d-check", keys: "x", label: "Check for a batch answer", group: "Decisions" },
  { id: "d-undo", keys: "u", label: "Undo last answer", group: "Decisions" },
  { id: "d-approve", keys: "a", label: "Approve proposal (operators)", group: "Decisions" },
  { id: "d-reject", keys: "r", label: "Reject proposal (operators)", group: "Decisions" },
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
    j: () => go(list[Math.min(idx + 1, list.length - 1)]?.id),
    k: () => go(list[Math.max(idx - 1, 0)]?.id),
    x: () => cur && localActions.toggle(cur.id),
    u: () => void undo(),
    o: () => cur?.number != null && navigate(`/item/${cur.repo}/${cur.number}`),
    escape: () => localActions.clearChecked(),
    "g a": () => update({ tab: filter.status === "answered" ? null : "answered" }),
  });
}

export function InboxList({ user }: ViewProps) {
  const { data, loading } = useDecisionList();
  const { id, go } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  useInboxKeys(list);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [id]);
  // Open the oldest decision when nothing is selected, so the detail pane is never empty on arrival.
  useEffect(() => {
    if (!id && list.length && !loc.justAnswered.length) go(list[0].id);
  }, [id, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups: { kind: Decision["kind"]; items: Decision[] }[] = [];
  for (const d of list) {
    const g = groups.find((x) => x.kind === d.kind);
    g ? g.items.push(d) : groups.push({ kind: d.kind, items: [d] });
  }
  const oldest = data?.oldestAskedAt;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-lg leading-none">{data?.total ?? "–"}</span>
          <span className="text-sm text-ink/70">{data?.total === 1 ? "decision" : "decisions"}</span>
          {oldest && <span className="ml-auto font-mono text-2xs text-ink/45">oldest {ago(oldest)}</span>}
        </div>
        <div className="mt-1 truncate font-mono text-2xs text-ink/50">{summaryLine(data) || (loading ? "loading…" : "nothing matches")}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Decisions">
        {loc.justAnswered.slice(0, 3).map((a) => (
          <JustAnswered key={a.id} entry={a} />
        ))}
        {groups.map((g) => {
          const Icon = KIND_ICON[g.kind];
          return (
            <div key={g.kind}>
              <div className="sticky top-0 z-[1] flex h-7 items-center gap-1.5 border-b border-line bg-panel px-4">
                <Icon className="text-[10px] text-ink/50" />
                <Hud className="text-2xs">{KIND_LABEL[g.kind]}</Hud>
                <span className="font-mono text-2xs text-ink/40">{g.items.length}</span>
              </div>
              {g.items.map((d) => (
                <Row key={d.id} d={d} active={d.id === id} checked={loc.checked.has(d.id)} canAnswer={decisionAccess(user, [d.repo]).mode !== "read"} onOpen={() => go(d.id)} activeRef={d.id === id ? activeRef : undefined} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ d, active, checked, canAnswer, onOpen, activeRef }: { d: Decision; active: boolean; checked: boolean; canAnswer: boolean; onOpen: () => void; activeRef?: React.Ref<HTMLButtonElement> }) {
  const rec = d.options.find((o) => o.key === d.recommended);
  const age = ago(d.askedAt);
  const old = ageDays(d.askedAt) >= 2;
  return (
    <div className={cn("group relative flex border-b border-line", active ? "bg-ink/[0.07]" : "hover:bg-ink/[0.035]")}>
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-ink" />}
      <label className="flex w-9 shrink-0 cursor-pointer items-start justify-center pt-[11px]" title="Check for a batch answer (x)">
        <input type="checkbox" checked={checked} onChange={() => localActions.toggle(d.id)} className="peer sr-only" aria-label={`Check ${d.title}`} />
        <span className={cn("flex size-3.5 items-center justify-center border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent-ink", checked ? "border-ink bg-ink text-inv" : "border-line-strong opacity-40 group-hover:opacity-100")}>
          {checked && <CheckIcon className="text-[9px]" strokeWidth={3} />}
        </span>
      </label>
      <button ref={activeRef} role="option" aria-selected={active} onClick={onOpen} className="min-w-0 flex-1 rounded-none py-2 pr-3 text-left">
        <div className="flex items-center gap-2">
          <span className="ref truncate text-ink/60">{d.number === null ? d.repo : `${d.repo}#${d.number}`}</span>
          {d.number === null && <span className="shrink-0 border border-line px-1 font-mono text-[9px] uppercase leading-[13px] tracking-[0.1em] text-ink/70">batch ×{d.items.length}</span>}
          {d.proposals.some((p) => p.status === "pending") && (
            <span className="shrink-0 border border-accent-ink/50 bg-accent/10 px-1 font-mono text-[9px] uppercase leading-[13px] tracking-[0.1em] text-accent-ink">
              proposal
            </span>
          )}
          {!canAnswer && <LockIcon className="shrink-0 text-[10px] text-ink/40" aria-label="You can't answer this one" />}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <ClaimPill claim={d.claim} compact />
            <span className={cn("font-mono text-2xs", old ? "text-warn" : "text-ink/40")}>{age}</span>
          </span>
        </div>
        <div className={cn("mt-0.5 truncate text-sm", active ? "text-ink" : "text-ink/85")}>{d.title}</div>
        {rec && (
          <div className="mt-0.5 truncate font-mono text-2xs text-ink/40">
            <span className="text-ink/30">rec</span> {rec.label}
          </div>
        )}
      </button>
    </div>
  );
}

function JustAnswered({ entry }: { entry: { id: string; label: string; ref: string } }) {
  const undo = useUndo();
  return (
    <div className="flex h-9 items-center gap-2 border-b border-line bg-ok/[0.06] pl-4 pr-2 animate-fadeIn">
      <CheckIcon className="shrink-0 text-xs text-ok" />
      <span className="ref shrink-0 text-ink/70">{entry.ref}</span>
      <span className="truncate text-xs text-ink/60">→ {entry.label}</span>
      <button onClick={() => void undo(entry.id)} className="ml-auto flex h-7 shrink-0 items-center gap-1 px-2 font-mono text-2xs uppercase tracking-[0.1em] text-ink/60 hover:bg-ink/5 hover:text-ink">
        <Undo2Icon className="text-[10px]" /> Undo
      </button>
    </div>
  );
}
