import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDownIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  CopyIcon,
  EyeIcon,
  GitMergeIcon,
  LockIcon,
  SplitIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import type { Decision, DecisionKind, DecisionOption } from "../../api/types";
import { Avatar } from "../../ui/Avatar";
import { Hud } from "../../ui/Hud";
import { Kbd } from "../../ui/Kbd";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { KIND_LABEL } from "./state";

export const KIND_ICON: Record<DecisionKind, LucideIcon> = {
  scope: TargetIcon,
  duplicate: CopyIcon,
  close: CircleSlashIcon,
  merge: GitMergeIcon,
  split: SplitIcon,
  other: CircleHelpIcon,
};

export function KindTag({ kind, batch }: { kind: DecisionKind; batch?: number }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="inline-flex h-[18px] items-center gap-1 border border-line px-1.5 font-mono text-2xs uppercase tracking-[0.1em] text-ink/70">
      <Icon className="text-[10px]" />
      {KIND_LABEL[kind]}
      {batch ? <span className="text-ink">×{batch}</span> : null}
    </span>
  );
}

export function ClaimPill({ claim, compact }: { claim: Decision["claim"]; compact?: boolean }) {
  if (!claim) return null;
  return (
    <span className="inline-flex h-[18px] items-center gap-1.5 border border-warn/40 bg-warn/10 pl-0.5 pr-1.5 text-2xs text-warn" title={`${claim.login} opened this ${ago(claim.since, false)}`}>
      <Avatar login={claim.login} size={14} />
      {compact ? <EyeIcon className="text-[10px]" /> : <span className="font-mono">{claim.login} is looking · {ago(claim.since)}</span>}
    </span>
  );
}

export function Facts({ facts, compact }: { facts: string[]; compact?: boolean }) {
  return (
    <ul className="grid gap-px border border-line bg-line">
      {facts.slice(0, 5).map((f, i) => {
        const [k, ...rest] = f.split(": ");
        const keyed = rest.length > 0 && k.length < 22;
        return (
          <li key={i} className={cn("flex items-baseline gap-3 bg-panel px-3 font-mono text-xs", compact ? "min-h-[26px] py-[4px]" : "min-h-[30px] py-[5px]")}>
            {keyed ? (
              <>
                <span className="w-[112px] shrink-0 uppercase tracking-[0.06em] text-ink/45">{k}</span>
                <span className="text-ink/90">{rest.join(": ")}</span>
              </>
            ) : (
              <span className="text-ink/90">{f}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OptionButtons({
  options,
  recommended,
  onPick,
  readOnly,
  verb,
  phone,
}: {
  options: DecisionOption[];
  recommended: string;
  onPick: (key: string) => void;
  /** Reason the reader can't act; the options are listed but inert. */
  readOnly?: string | null;
  /** Caption on each button, e.g. "Propose" for maintainers. */
  verb?: string;
  phone?: boolean;
}) {
  if (readOnly)
    return (
      <div className="border border-dashed border-line-strong">
        <div className="flex items-center gap-2 border-b border-dashed border-line px-3 py-2.5 text-sm text-ink/75">
          <LockIcon className="shrink-0 text-xs text-ink/50" /> {readOnly}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2.5" aria-label="Options">
          {options.map((o, i) => (
            <li key={o.key} className="flex items-center gap-1.5 font-mono text-xs text-ink/55">
              <span className="text-ink/35">{i + 1}</span> {o.label}
              {o.key === recommended && <span className="border border-line px-1 text-[9px] uppercase tracking-[0.12em]">rec</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className={cn("grid gap-2", !phone && options.length > 2 ? "grid-cols-2" : "grid-cols-1", !phone && options.length === 2 && "grid-cols-2")} role="group" aria-label="Answer">
      {options.map((o, i) => {
        const rec = o.key === recommended;
        return (
          <button
            key={o.key}
            onClick={() => onPick(o.key)}
            aria-keyshortcuts={String(i + 1)}
            className={cn(
              "group relative flex min-h-[52px] items-center gap-3 border px-3 py-2 text-left transition-colors duration-fast",
              rec ? "border-ink bg-ink text-inv hover:bg-ink/90" : "border-line bg-ink/[0.04] hover:border-line-strong hover:bg-ink/[0.08]",
            )}
          >
            <span className={cn("flex size-6 shrink-0 items-center justify-center border font-mono text-xs", rec ? "border-inv/30" : "border-line text-ink/60")}>{i + 1}</span>
            <span className="min-w-0 flex-1">
              {verb && <span className={cn("block font-mono text-[10px] uppercase leading-3 tracking-[0.14em]", rec ? "text-inv/60" : "text-accent-ink")}>{verb}</span>}
              <span className="block text-[15px] font-semibold leading-5 tracking-[-0.01em]">{o.label}</span>
              {o.hint && !phone && !verb && <span className={cn("block truncate text-xs", rec ? "text-inv/65" : "text-ink/50")}>{o.hint}</span>}
            </span>
            {rec && <span className="shrink-0 border border-inv/40 px-1 font-mono text-[9px] font-bold uppercase leading-[14px] tracking-[0.12em]">Rec</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Disclosure({ title, count, children, defaultOpen, hotkey }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean; hotkey?: string }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section className="border-t border-line">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-11 w-full items-center gap-2 rounded-none text-left text-ink/70 hover:text-ink">
        <ChevronDownIcon className={cn("text-xs transition-transform duration-fast", !open && "-rotate-90")} />
        <Hud className="text-inherit">{title}</Hud>
        {count !== undefined && <span className="font-mono text-2xs text-ink/40">{count}</span>}
        {hotkey && <Kbd keys={hotkey} className="ml-auto opacity-60" />}
      </button>
      {open && <div className="pb-4 animate-fadeIn">{children}</div>}
    </section>
  );
}

const WANT_TONE = { yes: "text-ok", no: "text-bad", unclear: "text-warn" };

export function ClassifierLines({ d }: { d: Decision }) {
  if (!d.classifications.length) return <p className="text-sm text-ink/50">Not classified yet.</p>;
  return (
    <table className="w-full text-left text-xs">
      <tbody>
        {d.classifications.map((c) => (
          <tr key={c.classifier} className="border-b border-line last:border-0">
            <td className="w-16 py-1.5 align-top font-mono uppercase tracking-[0.08em] text-ink/50">{c.classifier}</td>
            <td className="w-32 py-1.5 align-top font-mono">{c.typeLabel}</td>
            <td className={cn("w-16 py-1.5 align-top font-mono", WANT_TONE[c.want])}>want {c.want}</td>
            <td className="py-1.5 align-top text-ink/65">{c.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RelatedList({ d }: { d: Decision }) {
  if (!d.related.length) return <p className="text-sm text-ink/50">No related items.</p>;
  return (
    <ul className="grid gap-1">
      {d.related.map((r) => (
        <li key={`${r.repo}#${r.number}`} className="flex items-baseline gap-2 text-sm">
          <span className="w-24 shrink-0 font-mono text-2xs uppercase tracking-[0.08em] text-ink/45">{r.relation.replace(/-/g, " ")}</span>
          <Link to={`/item/${r.repo}/${r.number}`} className="ref shrink-0 text-accent-ink hover:underline">
            {r.repo}#{r.number}
          </Link>
          <span className="truncate text-ink/75">{r.title}</span>
        </li>
      ))}
    </ul>
  );
}
