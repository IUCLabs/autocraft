import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { QueueBadge } from "../../ui/molecules/QueueBadge";
import { Link } from "react-router-dom";
import {
  RadioButtonIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  CheckIcon,
  XIcon,
  SpinnerIcon,
  MinusIcon,
  ProhibitIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import { Pending } from "../../ui/atoms/Pending";
import type { CiState, Classification, Item, Tier } from "../../api/types";
import { ItemPath } from "../flow/ItemPath";
import type { ViewProps } from "../../registry/types";
import { Slot } from "../../registry/Slot";
import { Avatar } from "../../ui/atoms/Avatar";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { ItemIcon } from "../../ui/atoms/ItemIcon";
import { ChatsCircleIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { FastMarkFor, FastToggle, HoldToggle } from "../queue/fastTrack";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { PriorityBadge } from "../../ui/atoms/PriorityBadge";
import { Count } from "../../ui/atoms/Heading";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { KindTag, tallyOf } from "../decisions/parts";
import { RecommendationLine } from "../../ui/molecules/RecommendationLine";
import { SettledBadge } from "../items/views";
import { useItemDecisions } from "./ItemDecisions";
import { ItemThread } from "./ItemThread";
import { PrWork } from "./PrWork";
import { useMedia } from "../../shell/useMedia";
import { Disclosure } from "../decisions/parts";
import { useNow } from "../../lib/useNow";
import { decisionPath, githubItemUrl } from "../../lib/links";

function useItem(params: ViewProps["params"]) {
  const repo = params.repo!;
  const n = Number(params.number);
  return useQuery(`item:${repo}#${n}`, (api) => api.item(repo, n));
}

const TIER: Record<Tier, [string, Tone]> = {
  whitelisted: ["Whitelisted", "ok"],
  not: ["Not whitelisted", "neutral"],
  "override-allow": ["Override: allow", "accent"],
  "override-deny": ["Override: deny", "bad"],
};

const CI_ICON: Record<CiState, [PhosphorIcon, string]> = {
  passing: [CheckIcon, "text-ok"],
  failing: [XIcon, "text-bad"],
  pending: [SpinnerIcon, "text-warn"],
  none: [MinusIcon, "text-ink/40"],
};

export const sizeBucket = (lines: number) => (lines <= 50 ? "S" : lines <= 300 ? "M" : lines <= 1000 ? "L" : "XL");

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-ink/50">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// Whether the item's right-hand panel is on screen (it unmounts while collapsed), so the main column can show the details itself otherwise.
let sideShown = 0;
const sideListeners = new Set<() => void>();
const sideSub = (f: () => void) => (sideListeners.add(f), () => void sideListeners.delete(f));
const setSide = (d: number) => {
  sideShown += d;
  sideListeners.forEach((f) => f());
};

export function ItemMain({ params }: ViewProps) {
  const { data: it, error } = useItem(params);
  const sideUp = useSyncExternalStore(sideSub, () => sideShown > 0);
  const wide = useMedia("(min-width: 1024px)") && sideUp;
  const repo = params.repo!;
  const number = Number(params.number);
  // The trace request starts with the item request, and the page keeps one tree, so the trace is not fetched again when the item arrives.
  return (
    <div className="md:h-full md:overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-4 pb-0 pt-5 md:px-6">
        {it ? <Header it={it} /> : <Pending error={error} />}
        {it && !wide && (
          <div className="mt-3">
            <Disclosure title="Details">
              <Details it={it} />
            </Disclosure>
          </div>
        )}
        <ItemThread repo={repo} number={number} it={it} />
      </div>
    </div>
  );
}

function Details({ it }: { it: Item }) {
  return (
    <>
      <ItemPath it={it} />
      <Properties it={it} />
      {!!it.discord?.count && (
        <Section title="Discord" aside={`${it.discord.count} ${it.discord.count === 1 ? "message" : "messages"}`}>
          <ul className="space-y-1">
            {it.discord.links.map((l) => (
              <li key={l.url} className="flex items-center gap-2 text-sm">
                <ChatsCircleIcon className="shrink-0 text-ink/45" aria-hidden />
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center text-accent-ink hover:underline max-md:min-h-11">
                  Message
                </a>
                <TimeAgo iso={l.at} className="text-xs text-ink/50" />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Classifier verdicts" aside={agreement(it.classifications)}>
        <Verdicts cls={it.classifications} stacked />
      </Section>
      <PrWork it={it} />
      {it.files.length > 0 && (
        <Section title="Files changed" aside={it.changedFiles !== null && it.changedFiles > it.files.length ? `first ${it.files.length} of ${it.changedFiles} files` : `${it.files.length} files`}>
          <Files it={it} />
        </Section>
      )}
    </>
  );
}

function StatePill({ it }: { it: Item }) {
  const [Icon, label, cls]: [PhosphorIcon, string, string] =
    it.state === "merged" ? [GitMergeIcon, "Merged", "bg-merged"] : it.state === "closed" ? [ProhibitIcon, "Closed", "bg-bad"] : [it.kind === "pr" ? GitPullRequestIcon : RadioButtonIcon, "Open", "bg-[#238636]"];
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-white", cls)}>
      <Icon className="text-[14px]" /> {label}
    </span>
  );
}

function Header({ it }: { it: Item }) {
  useNow();
  return (
    <div className="border-b border-line pb-4">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-sm text-ink/60">
        <FastMarkFor repo={it.repo} number={it.number} />
        <ItemIcon kind={it.kind} state={it.state} />
        <span className="code">{it.repo}#{it.number}</span>
      </div>
      <h1 className="text-xl font-semibold text-ink">{it.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink/60">
        <StatePill it={it} />
        {it.pipelineOn === false && <Badge>Pipeline off</Badge>}
        {!!it.discord?.count && <Badge icon={<ChatsCircleIcon className="text-[12px]" />}>Discord {it.discord.count}</Badge>}
        <span className="inline-flex items-center gap-1.5">
          <Avatar login={it.author} size={18} />
          <span>
            <span className="font-medium text-ink">{it.author}</span> opened <TimeAgo iso={it.createdAt} /> in <span className="code text-ink/80">{it.repo}</span>
          </span>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {it.state === "open" && <FastToggle repo={it.repo} number={it.number} />}
          {it.state === "open" && it.kind === "pr" && <HoldToggle repo={it.repo} number={it.number} />}
          <a
            href={githubItemUrl(it.repo, it.number, it.kind)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded border border-line-strong bg-raised px-2.5 text-xs font-medium text-ink transition-colors duration-fast hover:bg-ink/[0.06] max-md:h-11"
          >
            <GithubLogoIcon aria-hidden /> See in GitHub
          </a>
        </span>
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="py-1 text-ink/50">{label}</dt>
      <dd className="flex min-w-0 flex-wrap content-start items-center gap-x-2 gap-y-1 py-1">{children}</dd>
    </div>
  );
}

function Properties({ it }: { it: Item }) {
  useNow();
  const [tierLabel, tierTone] = TIER[it.tier];
  const total = it.additions + it.deletions;
  const passing = it.ciChecks.filter((c) => c.state === "passing").length;
  const [CiIcon, ciCls] = CI_ICON[it.ci];
  // The mirror records checks and mergeability only for open PRs; without them the rows are left out.
  const showCi = it.kind === "pr" && it.ci !== "none";
  const showMergeable = it.kind === "pr" && it.state === "open" && it.mergeable !== "unknown";
  return (
    <dl className="mt-4 grid grid-cols-[80px_1fr] gap-x-3 text-sm">
      <Prop label="Author">
        <span className="font-medium">{it.author}</span>
        <Badge tone={tierTone}>{tierLabel}</Badge>
        <span className="text-xs text-ink/50">
          {it.authorMerged} merged · {it.authorClosedUnmerged} closed unmerged
        </span>
      </Prop>
      <Prop label="Type">
        <SettledBadge s={it.settled} detail />
        <PriorityBadge p={it.priority} />
        <QueueBadge slot={it.queue} />
        {it.settled.flags.map((f) => (
          <Badge key={f} tone={f === "security" ? "bad" : "warn"}>
            {f}
          </Badge>
        ))}
      </Prop>
      <Prop label="Size">
        {it.kind === "pr" ? (
          <>
            <span className="code">
              <span className="text-ok">+{num(it.additions)}</span> <span className="text-bad">−{num(it.deletions)}</span>
            </span>
            {it.changedFiles !== null && (
              <span className="text-ink/60">
                {num(it.changedFiles)} {it.changedFiles === 1 ? "file" : "files"}
              </span>
            )}
            <Badge>{sizeBucket(total)}</Badge>
          </>
        ) : (
          <span className="text-ink/60">Issue</span>
        )}
      </Prop>
      {showCi && (
        <Prop label="Checks">
          <span className={cn("inline-flex items-center gap-1 font-medium", ciCls)}>
            <CiIcon /> {it.ci[0]!.toUpperCase() + it.ci.slice(1)}
          </span>
          {it.ciChecks.length > 0 && (
            <span className="text-ink/55">
              {passing} of {it.ciChecks.length} passed
            </span>
          )}
        </Prop>
      )}
      {showMergeable && (
        <Prop label="Mergeable">
          <span className={cn("font-medium", it.mergeable === "clean" ? "text-ok" : "text-bad")}>{it.mergeable === "clean" ? "No conflicts" : "Has conflicts"}</span>
        </Prop>
      )}
      <Prop label="Labels">
        {it.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </Prop>
      <Prop label="Updated">
        <span className="text-ink/80"><TimeAgo iso={it.updatedAt} /></span>
      </Prop>
    </dl>
  );
}

function majority<T>(xs: T[]) {
  const counts = new Map<T, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
}

function agreement(cls: Classification[]) {
  if (cls.length < 2) return "";
  const [, n] = majority(cls.map((c) => c.typeLabel));
  return n === cls.length ? "all agree on type" : `${n} of ${cls.length} agree on type`;
}

const likelihood = (p: number) => (p < 0.2 ? "unlikely" : p < 0.5 ? "possible" : p < 0.8 ? "likely" : "very likely");
const percent = (p: number) => `${Math.round(p * 100)}%`;

// Classifiers that score labels write "bugfix 0.84; security 0.03; needs decision 0.27":
// the chosen label's probability, then flag probabilities. Other reasons are prose.
function Reason({ reason }: { reason: string }) {
  const parts = reason.split(";").map((x) => /^\s*([a-z][a-z -]*?)\s+(0(?:\.\d+)?|1(?:\.0+)?)\s*$/i.exec(x));
  if (!parts.length || parts.some((m) => !m)) return <>{reason}</>;
  const [label, ...flags] = parts.map((m) => ({ name: m![1]!, p: Number(m![2]) }));
  return (
    <>
      <span>
        {label!.name} ({percent(label!.p)})
      </span>
      {flags.length > 0 && (
        <span className="block text-xs text-ink/55">
          {flags.map((f) => `${f.name[0]!.toUpperCase()}${f.name.slice(1)}: ${likelihood(f.p)} (${percent(f.p)})`).join(" · ")}
        </span>
      )}
    </>
  );
}

const WANT: Record<string, string> = { yes: "text-ok", no: "text-bad", unclear: "text-warn" };

function Verdicts({ cls }: { cls: Classification[]; stacked?: boolean }) {
  useNow();
  const phone = true;
  if (!cls.length) return <p className="text-sm text-ink/50">Not classified yet.</p>;
  const typeMaj = majority(cls.map((c) => c.typeLabel))[0];
  const wantMaj = majority(cls.map((c) => c.want))[0];
  const off = "rounded-sm bg-warn/15 px-1 text-warn";
  if (phone)
    return (
      <ul className="overflow-hidden rounded-md border border-line">
        {cls.map((c) => (
          <li key={c.classifier} className="border-b border-line px-3 py-2.5 last:border-0">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="font-semibold">{c.classifier}</span>
              <span className={cn(c.typeLabel !== typeMaj && off)}>{c.typeLabel}</span>
              <span className={cn(WANT[c.want], c.want !== wantMaj && off)}>want {c.want}</span>
              <span className="ml-auto text-xs text-ink/45"><TimeAgo iso={c.at} /></span>
            </div>
            {c.reference && <div className="mt-0.5 text-xs text-ink/55">Reference: {c.reference}</div>}
            <div className="mt-1 text-sm text-ink/70">
              <Reason reason={c.reason} />
            </div>
          </li>
        ))}
      </ul>
    );
  const rows: { label: string; render: (c: Classification) => ReactNode; off?: (c: Classification) => boolean }[] = [
    { label: "Type", render: (c) => c.typeLabel, off: (c) => c.typeLabel !== typeMaj },
    { label: "Want", render: (c) => <span className={WANT[c.want]}>{c.want}</span>, off: (c) => c.want !== wantMaj },
    { label: "Reference", render: (c) => c.reference ?? <span className="text-ink/35">none</span> },
    { label: "Reason", render: (c) => <span className="text-ink/70"><Reason reason={c.reason} /></span> },
  ];
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-ink/[0.03]">
          <tr className="border-b border-line">
            <th className="w-[96px] px-3 py-2" />
            {cls.map((c) => (
              <th key={c.classifier} className="px-3 py-2 font-semibold">
                {c.classifier} <span className="ml-1 text-xs font-normal text-ink/45"><TimeAgo iso={c.at} /></span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line last:border-0">
              <th className="px-3 py-2 align-top text-xs font-normal text-ink/50">{r.label}</th>
              {cls.map((c) => (
                <td key={c.classifier} className="px-3 py-2 align-top">
                  <span className={cn(r.off?.(c) && off)} title={r.off?.(c) ? "Disagrees with the majority" : undefined}>
                    {r.render(c)}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Files({ it }: { it: Item }) {
  const max = Math.max(...it.files.map((f) => f.additions + f.deletions), 1);
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {it.files.slice(0, 12).map((f) => (
            <tr key={f.path} className="border-b border-line last:border-0 hover:bg-ink/[0.03]">
              <td className="code max-w-0 truncate px-3 py-1.5 text-ink/85">{f.path}</td>
              <td className="code w-14 px-1 py-1.5 text-right text-ok">+{f.additions}</td>
              <td className="code w-12 px-1 py-1.5 text-right text-bad">−{f.deletions}</td>
              <td className="hidden w-28 px-3 py-1.5 sm:table-cell">
                <span className="flex h-1.5 gap-px overflow-hidden rounded-full bg-ink/[0.06]">
                  <span className="bg-ok" style={{ width: `${(f.additions / max) * 100}%` }} />
                  <span className="bg-bad" style={{ width: `${(f.deletions / max) * 100}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SideSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">
        {title} <Count n={count} />
      </h2>
      {children}
    </section>
  );
}

export function ItemSide(props: ViewProps) {
  useNow();
  const { data: it } = useItem(props.params);
  const { data: ds } = useItemDecisions(props.params.repo!, Number(props.params.number));
  const wide = useMedia("(min-width: 1024px)");
  const showing = wide && !!it;
  useEffect(() => {
    if (!showing) return;
    setSide(1);
    return () => setSide(-1);
  }, [showing]);
  if (!it) return null;
  return (
    <div className="h-full overflow-y-auto pt-1">
      {wide && (
        <div className="border-b border-line px-4 pb-4">
          <Details it={it} />
        </div>
      )}
      <SideSection title="Decisions" count={ds?.length}>
        {ds?.length === 0 && <p className="text-sm text-ink/50">No decisions about this item.</p>}
        <div className="space-y-2">
          {ds?.map((d) => (
            <Link key={d.id} to={decisionPath(d, { siblings: ds })} className="block rounded-md border border-line p-2.5 transition-colors duration-fast hover:border-line-strong hover:bg-ink/[0.03]">
              <div className="flex items-center gap-2">
                <KindTag kind={d.kind} />
                <span className="ml-auto text-xs text-ink/50">{d.answer ? <>answered <TimeAgo iso={d.answeredAt!} /></> : <>waiting <TimeAgo iso={d.askedAt} /></>}</span>
              </div>
              <p className="mt-1.5 text-sm font-medium leading-5">{d.question}</p>
              {d.answer ? (
                <div className="mt-1 flex items-center gap-1 text-xs text-ok">
                  <CheckIcon /> {d.options.find((o) => o.key === d.answer)?.label} · {d.answeredBy}
                </div>
              ) : (
                <div className="mt-1"><RecommendationLine d={d} /></div>
              )}
              {!d.answer && d.opinions.length > 0 && (
                <div className="mt-0.5 text-xs text-ink/55">
                  {d.opinions.length} {d.opinions.length === 1 ? "comment" : "comments"}:{" "}
                  {Object.entries(tallyOf(d))
                    .map(([k, n]) => `${d.options.find((o) => o.key === k)?.label} ${n}`)
                    .join(" · ")}
                </div>
              )}
            </Link>
          ))}
        </div>
      </SideSection>
      <SideSection title="Linked and duplicates" count={it.related.length}>
        {it.related.length === 0 && <p className="text-sm text-ink/50">None found.</p>}
        <ul className="space-y-2">
          {it.related.map((r) => (
            <li key={`${r.repo}#${r.number}`} className="text-sm">
              <div className="text-xs text-ink/50">{r.relation.replace(/-/g, " ")}</div>
              <ItemRef repo={r.repo} number={r.number} kind={r.kind} state={r.state} title={r.title} />
            </li>
          ))}
        </ul>
      </SideSection>
      {it.ciChecks.length > 0 && (
        <SideSection title="Checks" count={it.ciChecks.length}>
          <ul>
            {it.ciChecks.map((c) => {
              const [I, cls] = CI_ICON[c.state];
              return (
                <li key={c.name} className="flex h-7 items-center gap-2 text-sm">
                  <I className={cls} />
                  <span className="flex-1 text-ink/80">{c.name}</span>
                  {c.minutes !== null && <span className="num text-xs text-ink/45">{c.minutes}m</span>}
                </li>
              );
            })}
          </ul>
        </SideSection>
      )}
      <Slot name="item.side" {...props} />
    </div>
  );
}

