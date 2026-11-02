import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronRightIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  CopyIcon,
  GitMergeIcon,
  LockIcon,
  SplitIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import type { Decision, DecisionKind, DecisionOption } from "../../api/types";
import { Avatar } from "../../ui/Avatar";
import { Kbd } from "../../ui/Kbd";
import { Count } from "../../ui/Heading";
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
    <span className="inline-flex h-5 items-center gap-1 rounded-full border border-line-strong px-2 text-2xs font-medium text-ink/75">
      <Icon className="text-[11px] text-ink/55" />
      {KIND_LABEL[kind]}
      {batch ? <span className="text-ink/55">· batch of {batch}</span> : null}
    </span>
  );
}

export function ClaimPill({ claim, compact }: { claim: Decision["claim"]; compact?: boolean }) {
  if (!claim) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-warn" title={`${claim.login} opened this ${ago(claim.since, false)}`}>
      <Avatar login={claim.login} size={16} />
      {!compact && (
        <span>
          {claim.login} is viewing · {ago(claim.since)}
        </span>
      )}
    </span>
  );
}

/** Facts arrive as short strings; "key: value" ones become key-value rows, the rest get a key from their shape. */
function factKey(f: string): [string, string] {
  const m = f.match(/^([a-z][a-z ]{1,20}): (.+)$/i);
  if (m) return [m[1][0].toUpperCase() + m[1].slice(1), m[2]];
  if (/^[+−-]?\d/.test(f) || /^\d+ PRs/.test(f)) return ["Size", f];
  if (/^CI\b|checks|CI /.test(f)) return ["Checks", f];
  if (/^(issue|draft)/.test(f)) return ["Item", f];
  return ["Note", f];
}

const DIFF = /([+][\d,]+\s*[−-][\d,]+)/;

export function Facts({ facts }: { facts: string[]; compact?: boolean }) {
  return (
    <dl className="grid grid-cols-[104px_1fr] gap-x-3 gap-y-1.5 text-sm">
      {facts.slice(0, 5).map((f, i) => {
        const [k, v] = factKey(f);
        const parts = v.split(DIFF);
        return (
          <div key={i} className="contents">
            <dt className="text-ink/50">{k}</dt>
            <dd className="min-w-0 text-ink/90">
              {parts.map((p, j) =>
                DIFF.test(p) ? (
                  <span key={j} className="code">
                    <span className="text-ok">{p.split(/\s+/)[0]}</span> <span className="text-bad">{p.split(/\s+/)[1]}</span>
                  </span>
                ) : (
                  <span key={j}>{p}</span>
                ),
              )}
            </dd>
          </div>
        );
      })}
    </dl>
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
  /** Prefix on each button label, e.g. "Propose" for maintainers. */
  verb?: string;
  phone?: boolean;
}) {
  if (readOnly)
    return (
      <div className="rounded-md border border-line bg-ink/[0.02]">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm text-ink/75">
          <LockIcon className="shrink-0 text-ink/45" /> {readOnly}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs text-ink/55" aria-label="Options">
          {options.map((o) => (
            <li key={o.key}>
              {o.label}
              {o.key === recommended && <span className="ml-1 text-accent-ink">(recommended)</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="grid gap-1.5" role="group" aria-label="Answer">
      {options.map((o, i) => {
        const rec = o.key === recommended;
        return (
          <button
            key={o.key}
            onClick={() => onPick(o.key)}
            aria-keyshortcuts={String(i + 1)}
            className={cn(
              "group flex items-center gap-2.5 rounded-md border px-3 text-left transition-colors duration-fast",
              phone ? "min-h-[48px] py-2" : "min-h-[40px] py-1.5",
              rec ? "border-accent bg-accent text-white hover:bg-accent/90" : "border-line-strong bg-raised hover:border-ink/30 hover:bg-ink/[0.04]",
            )}
          >
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 text-sm font-medium leading-5">
                {verb && <span className={rec ? "text-white/75" : "text-ink/55"}>{verb}: </span>}
                {o.label}
              </span>
              {o.hint && !phone && <span className={cn("truncate text-xs", rec ? "text-white/75" : "text-ink/50")}>{o.hint}</span>}
            </span>
            {rec && <span className="shrink-0 rounded-full bg-white/20 px-1.5 text-2xs font-medium leading-[18px]">Recommended</span>}
            {!phone && (
              <kbd className={cn("shrink-0 rounded-sm border px-1 text-[11px] leading-4", rec ? "border-white/35 text-white/80" : "border-line-strong text-ink/45")}>{i + 1}</kbd>
            )}
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
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-9 w-full items-center gap-1.5 rounded-none text-left text-sm font-medium text-ink/75 hover:text-ink">
        <ChevronRightIcon className={cn("text-ink/45 transition-transform duration-fast", open && "rotate-90")} />
        {title}
        <Count n={count} />
        {hotkey && <Kbd keys={hotkey} className="ml-auto" />}
      </button>
      {open && <div className="pb-3 pl-5 animate-fadeIn">{children}</div>}
    </section>
  );
}

const WANT_TONE = { yes: "text-ok", no: "text-bad", unclear: "text-warn" };

export function ClassifierLines({ d }: { d: Decision }) {
  if (!d.classifications.length) return <p className="text-sm text-ink/50">Not classified yet.</p>;
  return (
    <table className="w-full text-left text-sm">
      <tbody>
        {d.classifications.map((c) => (
          <tr key={c.classifier} className="border-b border-line last:border-0">
            <td className="w-16 py-1.5 align-top font-medium">{c.classifier}</td>
            <td className="w-32 py-1.5 align-top text-ink/80">{c.typeLabel}</td>
            <td className={cn("w-20 py-1.5 align-top", WANT_TONE[c.want])}>want {c.want}</td>
            <td className="py-1.5 align-top text-ink/60">{c.reason}</td>
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
          <span className="w-24 shrink-0 text-xs text-ink/50">{r.relation.replace(/-/g, " ")}</span>
          <Link to={`/item/${r.repo}/${r.number}`} className="code shrink-0 text-accent-ink hover:underline">
            {r.repo}#{r.number}
          </Link>
          <span className="truncate text-ink/75">{r.title}</span>
        </li>
      ))}
    </ul>
  );
}
