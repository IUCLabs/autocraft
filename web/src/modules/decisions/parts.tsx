import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronRightIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  CopyIcon,
  GitMergeIcon,
  CheckIcon,
  UsersIcon,
  StarIcon,
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

/**
 * The answer options. For an operator a pick answers; for everyone else it sets
 * their opinion (`mine`), which they can change. Each option shows its tally.
 */
export function OptionButtons({
  options,
  recommended,
  onPick,
  mode,
  mine,
  tally,
  layout = "list",
}: {
  options: DecisionOption[];
  recommended: string;
  onPick: (key: string) => void;
  mode: "answer" | "opinion";
  mine?: string | null;
  tally?: Record<string, number>;
  /** "row" for the desktop decision bar, "list" for stacked full-width buttons. */
  layout?: "row" | "list";
}) {
  return (
    <div className={cn("grid gap-1.5", layout === "row" && options.length > 1 && "grid-cols-2")} role="group" aria-label={mode === "answer" ? "Answer" : "Your opinion"}>
      {options.map((o, i) => {
        const rec = o.key === recommended;
        const picked = mine === o.key;
        const filled = mode === "answer" ? rec : picked;
        const n = tally?.[o.key] ?? 0;
        return (
          <button
            key={o.key}
            onClick={() => onPick(o.key)}
            aria-keyshortcuts={String(i + 1)}
            aria-pressed={mode === "opinion" ? picked : undefined}
            title={`${o.hint ? o.hint + " " : ""}(${i + 1})`}
            className={cn(
              "group flex items-center gap-2 rounded-md border text-left transition-colors duration-fast",
              layout === "row" ? "h-8 px-2.5" : "min-h-[44px] px-3 py-1.5",
              filled ? "border-accent bg-accent text-white hover:bg-accent/90" : rec ? "border-accent/60 bg-raised hover:bg-accent/[0.06]" : "border-line-strong bg-raised hover:border-ink/30 hover:bg-ink/[0.04]",
            )}
          >
            {picked && <CheckIcon className="text-[13px]" />}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.label}</span>
            {layout === "list" && o.hint && <span className={cn("hidden truncate text-xs sm:inline", filled ? "text-white/75" : "text-ink/50")}>{o.hint}</span>}
            {rec &&
              (layout === "row" ? (
                <StarIcon className={cn("text-[12px]", filled ? "text-white/85" : "text-accent-ink")} aria-label="Recommended" />
              ) : (
                <span className={cn("shrink-0 rounded-full px-1.5 text-2xs font-medium leading-[18px]", filled ? "bg-white/20" : "bg-accent/15 text-accent-ink")}>Recommended</span>
              ))}
            {n > 0 && (
              <span className={cn("num shrink-0 text-xs", filled ? "text-white/80" : "text-ink/50")} title={`${n} ${n === 1 ? "opinion" : "opinions"}`}>
                <UsersIcon className="mr-0.5 text-[11px]" />
                {n}
              </span>
            )}
            <kbd className={cn("hidden shrink-0 rounded-sm border px-1 text-[11px] leading-4", layout === "list" && "md:inline", filled ? "border-white/35 text-white/80" : "border-line-strong text-ink/45")}>{i + 1}</kbd>
          </button>
        );
      })}
    </div>
  );
}

/** Opinions from everyone, newest first, with GitHub permission badges. Operators can adopt one. */
export function OpinionList({ d, onAdopt, me }: { d: Decision; onAdopt?: (opinionId: string) => void; me: string }) {
  if (!d.opinions.length) return <p className="text-sm text-ink/50">No opinions yet.</p>;
  const label = (k: string) => d.options.find((o) => o.key === k)?.label ?? k;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
      {d.opinions.map((o) => (
        <li key={o.id} className="flex items-start gap-2.5 px-3 py-2">
          <Avatar login={o.login} size={20} className="mt-0.5" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="font-semibold">{o.login === me ? "You" : o.login}</span>
              <span
                className={cn("rounded-full border px-1.5 text-2xs leading-4", o.permission === "write" ? "border-ok/40 text-ok" : "border-line-strong text-ink/50")}
                title={o.permission === "write" ? `Has write access to ${d.repo}` : `No write access to ${d.repo}`}
              >
                {o.permission === "write" ? "write" : "no write"}
              </span>
              {o.option ? (
                <>
                  <span className="text-ink/55">picks</span>
                  <span className="font-medium">{label(o.option)}</span>
                </>
              ) : (
                <span className="text-ink/55">commented</span>
              )}
              <span className="text-xs text-ink/45">· {ago(o.at)} ago</span>
            </div>
            {o.note && <p className="mt-0.5 text-ink/70">{o.note}</p>}
          </div>
          {onAdopt && o.option && (
            <button onClick={() => onAdopt(o.id)} className="shrink-0 rounded border border-line-strong px-2 py-0.5 text-xs font-medium hover:border-accent/60 hover:text-accent-ink" title={`Answer "${label(o.option)}" and credit ${o.login}`}>
              Adopt
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function tallyOf(d: Decision) {
  const t: Record<string, number> = {};
  for (const o of d.opinions) if (o.option) t[o.option] = (t[o.option] ?? 0) + 1;
  return t;
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
