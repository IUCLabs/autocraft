import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  CircleDotIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  CheckIcon,
  XIcon,
  LoaderIcon,
  MinusIcon,
  TagIcon,
  SparklesIcon,
  FlagIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "../../api/client";
import type { CiState, Classification, Item, Stage, Tier } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Slot } from "../../registry/Slot";
import { Avatar } from "../../ui/Avatar";
import { RefLink } from "../../ui/RefLink";
import { Badge, type Tone } from "../../ui/Badge";
import { Count } from "../../ui/Heading";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { KindTag, tallyOf } from "../decisions/parts";
import { Markdown, Collapsible } from "../../ui/Markdown";
import { useIsPhone } from "../../shell/useMedia";
import { SettledBadge } from "../items";

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

const CI_ICON: Record<CiState, [LucideIcon, string]> = {
  passing: [CheckIcon, "text-ok"],
  failing: [XIcon, "text-bad"],
  pending: [LoaderIcon, "text-warn"],
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

function ItemMain({ params }: ViewProps) {
  const { data: it } = useItem(params);
  if (!it) return <div className="p-6 text-ink/50">Loading…</div>;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-4 pb-12 pt-5 md:px-6">
        <Header it={it} />
        <Properties it={it} />
        {it.body && (
          <Section title="Description">
            <div className="rounded-md border border-line px-4 py-3">
              <Collapsible lines={25}>
                <Markdown source={it.body} />
              </Collapsible>
            </div>
          </Section>
        )}
        <Section title="Classifier verdicts" aside={agreement(it.classifications)}>
          <Verdicts cls={it.classifications} />
        </Section>
        <Section title="Timeline">
          <Timeline it={it} />
        </Section>
        {it.files.length > 0 && (
          <Section title="Files changed" aside={`${it.files.length} files`}>
            <Files it={it} />
          </Section>
        )}
      </div>
    </div>
  );
}

function StatePill({ it }: { it: Item }) {
  const [Icon, label, cls]: [LucideIcon, string, string] =
    it.state === "merged" ? [GitMergeIcon, "Merged", "bg-merged"] : it.state === "closed" ? [CircleSlashIcon, "Closed", "bg-bad"] : [it.kind === "pr" ? GitPullRequestIcon : CircleDotIcon, "Open", "bg-[#238636]"];
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-white", cls)}>
      <Icon className="text-[14px]" /> {label}
    </span>
  );
}

function Header({ it }: { it: Item }) {
  return (
    <div className="border-b border-line pb-4">
      <h1 className="text-xl font-semibold text-ink">
        {it.title}{" "}
        <RefLink repo={it.repo} number={it.number} kind={it.kind} className="font-normal">
          {it.repo}#{it.number}
        </RefLink>
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink/60">
        <StatePill it={it} />
        <span className="inline-flex items-center gap-1.5">
          <Avatar login={it.author} size={18} />
          <span>
            <span className="font-medium text-ink">{it.author}</span> opened {ago(it.createdAt)} ago in <span className="code text-ink/80">{it.repo}</span>
          </span>
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
  const [tierLabel, tierTone] = TIER[it.tier];
  const total = it.additions + it.deletions;
  const passing = it.ciChecks.filter((c) => c.state === "passing").length;
  const [CiIcon, ciCls] = CI_ICON[it.ci];
  return (
    <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-4 text-sm md:grid-cols-[96px_1fr_96px_1fr]">
      <Prop label="Author">
        <span className="font-medium">{it.author}</span>
        <Badge tone={tierTone}>{tierLabel}</Badge>
        <span className="text-xs text-ink/50">
          {it.authorMerged} merged · {it.authorClosedUnmerged} closed unmerged
        </span>
      </Prop>
      <Prop label="Type">
        <SettledBadge s={it.settled} detail />
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
            <span className="text-ink/60">{it.files.length} files</span>
            <Badge>{sizeBucket(total)}</Badge>
          </>
        ) : (
          <span className="text-ink/60">Issue</span>
        )}
      </Prop>
      <Prop label="Checks">
        <span className={cn("inline-flex items-center gap-1 font-medium", ciCls)}>
          <CiIcon /> {it.ci === "none" ? "No checks" : it.ci[0].toUpperCase() + it.ci.slice(1)}
        </span>
        {it.ciChecks.length > 0 && (
          <span className="text-ink/55">
            {passing} of {it.ciChecks.length} passed
          </span>
        )}
      </Prop>
      <Prop label="Mergeable">
        <span className={cn("font-medium", it.mergeable === "clean" ? "text-ok" : it.mergeable === "conflicts" ? "text-bad" : "text-ink/55")}>
          {it.mergeable === "clean" ? "No conflicts" : it.mergeable === "conflicts" ? "Has conflicts" : "Unknown"}
        </span>
      </Prop>
      <Prop label="Labels">
        {it.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </Prop>
      <Prop label="Updated">
        <span className="text-ink/80">{ago(it.updatedAt, false)}</span>
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

const WANT: Record<string, string> = { yes: "text-ok", no: "text-bad", unclear: "text-warn" };

function Verdicts({ cls }: { cls: Classification[] }) {
  const phone = useIsPhone();
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
              <span className="ml-auto text-xs text-ink/45">{ago(c.at)}</span>
            </div>
            {c.reference && <div className="mt-0.5 text-xs text-ink/55">Reference: {c.reference}</div>}
            <p className="mt-1 text-sm text-ink/70">{c.reason}</p>
          </li>
        ))}
      </ul>
    );
  const rows: { label: string; render: (c: Classification) => ReactNode; off?: (c: Classification) => boolean }[] = [
    { label: "Type", render: (c) => c.typeLabel, off: (c) => c.typeLabel !== typeMaj },
    { label: "Want", render: (c) => <span className={WANT[c.want]}>{c.want}</span>, off: (c) => c.want !== wantMaj },
    { label: "Reference", render: (c) => c.reference ?? <span className="text-ink/35">none</span> },
    { label: "Topics", render: (c) => c.topics },
    { label: "Reason", render: (c) => <span className="text-ink/70">{c.reason}</span> },
  ];
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-ink/[0.03]">
          <tr className="border-b border-line">
            <th className="w-[96px] px-3 py-2" />
            {cls.map((c) => (
              <th key={c.classifier} className="px-3 py-2 font-semibold">
                {c.classifier} <span className="ml-1 text-xs font-normal text-ink/45">{ago(c.at)} ago</span>
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

const STAGE: Record<Stage, [string, LucideIcon]> = {
  classified: ["Classified", TagIcon],
  reviewed: ["Reviewed", SparklesIcon],
  take: ["Taken", CircleCheckIcon],
  hold: ["Held", MinusIcon],
  close: ["Marked to close", CircleSlashIcon],
  "needs-decision": ["Waiting for a decision", FlagIcon],
  batched: ["Put in a batch", FlagIcon],
  merged: ["Merged by the pipeline", GitMergeIcon],
  closed: ["Closed by the pipeline", CircleSlashIcon],
  "fixed-by-us": ["Fixed by us", CircleCheckIcon],
};

function Timeline({ it }: { it: Item }) {
  return (
    <ol className="relative">
      <span className="absolute bottom-3 left-[11px] top-3 w-px bg-line-strong" aria-hidden />
      {it.stages.map((s, i) => {
        const last = i === it.stages.length - 1;
        const [label, Icon] = STAGE[s.stage];
        return (
          <li key={i} className="relative flex items-center gap-3 py-1.5">
            <span className={cn("z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border", last ? "border-warn/50 bg-warn/15 text-warn" : "border-line-strong bg-panel text-ink/55")}>
              <Icon className="text-[12px]" />
            </span>
            <span className="min-w-0 flex-1 text-sm">
              <span className={cn(last ? "font-medium text-ink" : "text-ink/85")}>{label}</span> <span className="text-ink/55">by {s.by}</span>
              {s.note && <span className="text-ink/45"> · {s.note}</span>}
            </span>
            <span className="shrink-0 text-xs text-ink/45">{ago(s.at)} ago</span>
          </li>
        );
      })}
    </ol>
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

function ItemSide(props: ViewProps) {
  const { data: it } = useItem(props.params);
  const { data: ds } = useQuery(`item-decisions:${props.params.repo}#${props.params.number}`, async (api) => {
    const all = await Promise.all([api.decisions.list({ status: "open" }), api.decisions.list({ status: "answered" })]);
    return all.flatMap((l) => l.decisions).filter((d) => d.repo === props.params.repo && (d.number === Number(props.params.number) || d.items.some((i) => i.number === Number(props.params.number))));
  });
  if (!it) return null;
  return (
    <div className="h-full overflow-y-auto pt-1">
      <SideSection title="Decisions" count={ds?.length}>
        {ds?.length === 0 && <p className="text-sm text-ink/50">No decisions about this item.</p>}
        <div className="space-y-2">
          {ds?.map((d) => (
            <Link key={d.id} to={`/decisions/${encodeURIComponent(d.id)}`} className="block rounded-md border border-line p-2.5 transition-colors duration-fast hover:border-line-strong hover:bg-ink/[0.03]">
              <div className="flex items-center gap-2">
                <KindTag kind={d.kind} />
                <span className="ml-auto text-xs text-ink/50">{d.answer ? `answered ${ago(d.answeredAt!)} ago` : `waiting ${ago(d.askedAt)}`}</span>
              </div>
              <p className="mt-1.5 text-sm font-medium leading-5">{d.question}</p>
              {d.answer ? (
                <div className="mt-1 flex items-center gap-1 text-xs text-ok">
                  <CheckIcon /> {d.options.find((o) => o.key === d.answer)?.label} · {d.answeredBy}
                </div>
              ) : (
                <div className="mt-1 text-xs text-ink/55">Recommended: {d.options.find((o) => o.key === d.recommended)?.label}</div>
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
              <RefLink repo={r.repo} number={r.number} className="mr-1.5">
                #{r.number}
              </RefLink>
              <Link to={`/item/${r.repo}/${r.number}`} className="hover:underline">
                {r.title}
              </Link>
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
                  <span className="num text-xs text-ink/45">{c.minutes}m</span>
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

export const itemModule: FeatureModule = {
  id: "item",
  permission: "viewer",
  routes: [
    {
      path: "item/:repo/:number",
      view: {
        id: "item",
        title: "Item",
        panels: [
          { id: "main", title: "Item", component: ItemMain, defaultSize: 72, minSize: 45 },
          { id: "side", title: "Decisions and links", component: ItemSide, defaultSize: 28, minSize: 20, maxSize: 45, collapsible: true },
        ],
      },
    },
  ],
};
