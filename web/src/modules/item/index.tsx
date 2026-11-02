import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CircleDotIcon, GitPullRequestIcon, CheckIcon, XIcon, LoaderIcon, MinusIcon, ArrowUpRightIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { CiState, Classification, Item, Stage, Tier } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Slot } from "../../registry/Slot";
import { Avatar } from "../../ui/Avatar";
import { Badge, type Tone } from "../../ui/Badge";
import { Hud, RegMarks } from "../../ui/Hud";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { KindTag } from "../decisions/parts";
import { useIsPhone } from "../../shell/useMedia";

function useItem(params: ViewProps["params"]) {
  const repo = params.repo!;
  const n = Number(params.number);
  return useQuery(`item:${repo}#${n}`, (api) => api.item(repo, n));
}

const TIER: Record<Tier, [string, Tone]> = {
  whitelisted: ["whitelisted", "ok"],
  not: ["not whitelisted", "neutral"],
  "override-allow": ["override: allow", "accent"],
  "override-deny": ["override: deny", "bad"],
};

const CI_ICON: Record<CiState, [typeof CheckIcon, string]> = {
  passing: [CheckIcon, "text-ok"],
  failing: [XIcon, "text-bad"],
  pending: [LoaderIcon, "text-warn"],
  none: [MinusIcon, "text-ink/40"],
};

export const sizeBucket = (lines: number) => (lines <= 50 ? "S" : lines <= 300 ? "M" : lines <= 1000 ? "L" : "XL");

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-t border-line px-6 py-5", className)}>
      <div className="mb-3 flex items-baseline gap-2">
        <Hud as="h2">{title}</Hud>
        {aside && <span className="ml-auto font-mono text-2xs text-ink/45">{aside}</span>}
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
      <Header it={it} />
      <MetaGrid it={it} />
      <Section title="Classifier verdicts" aside={agreement(it.classifications)}>
        <Verdicts cls={it.classifications} />
      </Section>
      <Section title="Stage timeline" aside={`${it.stages.length} events`}>
        <Timeline it={it} />
      </Section>
      {it.files.length > 0 && (
        <Section title="Files" aside={`${it.files.length} changed`}>
          <Files it={it} />
        </Section>
      )}
    </div>
  );
}

function Header({ it }: { it: Item }) {
  const Icon = it.kind === "pr" ? GitPullRequestIcon : CircleDotIcon;
  return (
    <div className="px-6 pb-5 pt-6">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn("text-sm", it.state === "merged" ? "text-c4" : it.state === "closed" ? "text-bad" : "text-ok")} />
        <span className="ref text-ink/70">
          {it.repo}#{it.number}
        </span>
        <Badge tone={it.state === "open" ? "ok" : it.state === "merged" ? "accent" : "bad"}>{it.state}</Badge>
        {it.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        <a href={`https://github.com/storytold/${it.repo}/${it.kind === "pr" ? "pull" : "issues"}/${it.number}`} className="ml-auto inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-[0.1em] text-ink/50 hover:text-ink" rel="noreferrer" target="_blank">
          GitHub <ArrowUpRightIcon className="text-[10px]" />
        </a>
      </div>
      <h1 className="mt-3 text-balance font-display text-xl text-ink md:text-2xl">{it.title}</h1>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3">
      <Hud className="block text-2xs">{label}</Hud>
      <div className="mt-1.5 min-w-0">{children}</div>
    </div>
  );
}

function MetaGrid({ it }: { it: Item }) {
  const [tierLabel, tierTone] = TIER[it.tier];
  const total = it.additions + it.deletions;
  const passing = it.ciChecks.filter((c) => c.state === "passing").length;
  const [CiIcon, ciCls] = CI_ICON[it.ci];
  return (
    <div className="relative mx-6 mb-6">
      <RegMarks />
      <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
        <Cell label="Author">
          <div className="flex items-center gap-2">
            <Avatar login={it.author} size={20} />
            <span className="truncate text-sm font-semibold">{it.author}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={tierTone}>{tierLabel}</Badge>
            <span className="font-mono text-2xs text-ink/50">
              {it.authorMerged} merged · {it.authorClosedUnmerged} closed
            </span>
          </div>
        </Cell>
        <Cell label="Size">
          {it.kind === "pr" ? (
            <>
              <div className="flex items-baseline gap-2 font-mono text-sm">
                <span className="text-ok">+{num(it.additions)}</span>
                <span className="text-bad">−{num(it.deletions)}</span>
                <span className="ml-auto border border-line px-1 text-2xs text-ink/70">{sizeBucket(total)}</span>
              </div>
              <div className="mt-2 flex h-1 gap-px">
                <span className="bg-ok" style={{ flex: it.additions || 0.0001 }} />
                <span className="bg-bad" style={{ flex: it.deletions || 0.0001 }} />
              </div>
              <div className="mt-1.5 font-mono text-2xs text-ink/50">{it.files.length} files</div>
            </>
          ) : (
            <span className="text-sm text-ink/60">issue</span>
          )}
        </Cell>
        <Cell label="CI">
          <div className={cn("flex items-center gap-1.5 text-sm font-semibold", ciCls)}>
            <CiIcon /> {it.ci}
          </div>
          {it.ciChecks.length > 0 && (
            <div className="mt-2 flex gap-0.5" aria-label={`${passing} of ${it.ciChecks.length} checks passing`}>
              {it.ciChecks.map((c) => (
                <span key={c.name} title={`${c.name}: ${c.state}`} className={cn("h-1.5 flex-1", c.state === "passing" ? "bg-ok" : c.state === "failing" ? "bg-bad" : "bg-warn")} />
              ))}
            </div>
          )}
          <div className="mt-1.5 font-mono text-2xs text-ink/50">{it.ciChecks.length ? `${passing} of ${it.ciChecks.length} checks` : "no checks"}</div>
        </Cell>
        <Cell label="Mergeable">
          <div className={cn("text-sm font-semibold", it.mergeable === "clean" ? "text-ok" : it.mergeable === "conflicts" ? "text-bad" : "text-ink/50")}>{it.mergeable === "clean" ? "clean" : it.mergeable}</div>
          <div className="mt-1.5 font-mono text-2xs text-ink/50">opened {ago(it.createdAt)} ago</div>
          <div className="font-mono text-2xs text-ink/50">updated {ago(it.updatedAt)} ago</div>
        </Cell>
      </div>
    </div>
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
  if (phone)
    return (
      <ul className="grid gap-px border border-line bg-line">
        {cls.map((c) => (
          <li key={c.classifier} className="bg-panel px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="hud text-ink">{c.classifier}</span>
              <span className={cn("font-mono text-xs", c.typeLabel !== typeMaj && "text-warn")}>{c.typeLabel}</span>
              <span className={cn("font-mono text-xs", WANT[c.want], c.want !== wantMaj && "underline decoration-warn")}>want {c.want}</span>
              <span className="ml-auto font-mono text-2xs text-ink/40">{ago(c.at)}</span>
            </div>
            {c.reference && <div className="mt-1 font-mono text-2xs text-ink/55">ref: {c.reference}</div>}
            <p className="mt-1 text-sm leading-5 text-ink/75">{c.reason}</p>
          </li>
        ))}
      </ul>
    );
  const rows: { label: string; render: (c: Classification) => ReactNode; off?: (c: Classification) => boolean }[] = [
    { label: "Type", render: (c) => c.typeLabel, off: (c) => c.typeLabel !== typeMaj },
    { label: "Want", render: (c) => <span className={WANT[c.want]}>{c.want}</span>, off: (c) => c.want !== wantMaj },
    { label: "Reference", render: (c) => c.reference ?? <span className="text-ink/35">none</span> },
    { label: "Topics", render: (c) => c.topics },
    { label: "Reason", render: (c) => <span className="font-sans text-sm leading-5 text-ink/75">{c.reason}</span> },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-left">
        <thead>
          <tr>
            <th className="w-[92px]" />
            {cls.map((c) => (
              <th key={c.classifier} className="border-b border-line-strong pb-2 pr-4 align-bottom">
                <span className="hud text-ink">{c.classifier}</span>
                <span className="ml-2 font-mono text-2xs font-normal text-ink/40">{ago(c.at)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line last:border-0">
              <th className="py-2 pr-3 align-top font-mono text-2xs font-normal uppercase tracking-[0.1em] text-ink/45">{r.label}</th>
              {cls.map((c) => (
                <td key={c.classifier} className={cn("relative py-2 pr-4 align-top font-mono text-xs", r.off?.(c) && "text-warn")}>
                  {r.off?.(c) && <span className="absolute -left-2 top-[13px] size-1 bg-warn" aria-label="disagrees" />}
                  {r.render(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STAGE_WORDS: Record<Stage, string> = {
  classified: "Classified",
  reviewed: "Reviewed",
  take: "Taken",
  hold: "Held",
  close: "Marked to close",
  "needs-decision": "Waiting for a decision",
  batched: "Put in a batch",
  merged: "Merged by the pipeline",
  closed: "Closed by the pipeline",
  "fixed-by-us": "Fixed by us",
};

function Timeline({ it }: { it: Item }) {
  return (
    <ol className="relative ml-1.5 border-l border-line">
      {it.stages.map((s, i) => {
        const last = i === it.stages.length - 1;
        return (
          <li key={i} className="relative pb-3 pl-5 last:pb-0">
            <span className={cn("absolute -left-[4.5px] top-[6px] size-2 border", last ? "border-warn bg-warn" : "border-line-strong bg-panel")} />
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className={cn("text-sm", last ? "font-semibold text-ink" : "text-ink/80")}>{STAGE_WORDS[s.stage]}</span>
              <span className="font-mono text-2xs text-ink/50">by {s.by}</span>
              {s.note && <span className="font-mono text-2xs text-ink/40">· {s.note}</span>}
              <span className="ml-auto font-mono text-2xs text-ink/40">{ago(s.at)} ago</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Files({ it }: { it: Item }) {
  const max = Math.max(...it.files.map((f) => f.additions + f.deletions), 1);
  return (
    <ul>
      {it.files.slice(0, 12).map((f) => (
        <li key={f.path} className="flex h-7 items-center gap-3 border-b border-line last:border-0">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink/80">{f.path}</span>
          <span className="w-12 shrink-0 text-right font-mono text-2xs text-ok">+{f.additions}</span>
          <span className="w-10 shrink-0 text-right font-mono text-2xs text-bad">−{f.deletions}</span>
          <span className="flex h-1 w-24 shrink-0 gap-px">
            <span className="bg-ok" style={{ width: `${(f.additions / max) * 100}%` }} />
            <span className="bg-bad" style={{ width: `${(f.deletions / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
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
    <div className="h-full overflow-y-auto bg-panel">
      <div className="flex h-10 items-center border-b border-line px-5 pr-10">
        <Hud>Decisions</Hud>
        <span className="ml-2 font-mono text-2xs text-ink/45">{ds?.length ?? 0}</span>
      </div>
      <div className="space-y-2 p-4">
        {ds?.length === 0 && <p className="text-sm text-ink/50">No decisions about this item.</p>}
        {ds?.map((d) => (
          <Link key={d.id} to={`/decisions/${encodeURIComponent(d.id)}`} className="block border border-line p-3 transition-colors duration-fast hover:border-line-strong hover:bg-ink/[0.03]">
            <div className="flex items-center gap-2">
              <KindTag kind={d.kind} />
              <span className="ml-auto font-mono text-2xs text-ink/45">{d.answer ? `answered ${ago(d.answeredAt!)} ago` : `waiting ${ago(d.askedAt)}`}</span>
            </div>
            <p className="mt-2 text-sm leading-5">{d.question}</p>
            {d.answer ? (
              <div className="mt-2 flex items-center gap-1.5 font-mono text-2xs text-ok">
                <CheckIcon className="text-[10px]" /> {d.options.find((o) => o.key === d.answer)?.label} · {d.answeredBy}
              </div>
            ) : (
              <div className="mt-2 font-mono text-2xs text-warn">rec: {d.options.find((o) => o.key === d.recommended)?.label}</div>
            )}
            {!d.answer &&
              d.proposals
                .filter((p) => p.status === "pending")
                .map((p) => (
                  <div key={p.id} className="mt-1 font-mono text-2xs text-accent-ink">
                    proposal: {p.login} → {d.options.find((o) => o.key === p.option)?.label}
                  </div>
                ))}
          </Link>
        ))}
      </div>
      <div className="flex h-10 items-center border-y border-line px-5">
        <Hud>Linked and duplicates</Hud>
        <span className="ml-2 font-mono text-2xs text-ink/45">{it.related.length}</span>
      </div>
      <ul className="p-4">
        {it.related.length === 0 && <li className="text-sm text-ink/50">None found.</li>}
        {it.related.map((r) => (
          <li key={`${r.repo}#${r.number}`} className="border-b border-line py-2 last:border-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xs uppercase tracking-[0.08em] text-ink/45">{r.relation.replace(/-/g, " ")}</span>
              <Badge tone={r.state === "open" ? "ok" : "neutral"} className="ml-auto">
                {r.state}
              </Badge>
            </div>
            <Link to={`/item/${r.repo}/${r.number}`} className="mt-1 block text-sm hover:underline">
              <span className="ref mr-1.5 text-accent-ink">#{r.number}</span>
              {r.title}
            </Link>
          </li>
        ))}
      </ul>
      {it.ciChecks.length > 0 && (
        <>
          <div className="flex h-10 items-center border-y border-line px-5">
            <Hud>Checks</Hud>
          </div>
          <ul className="p-4 pt-2">
            {it.ciChecks.map((c) => {
              const [I, cls] = CI_ICON[c.state];
              return (
                <li key={c.name} className="flex h-7 items-center gap-2 font-mono text-xs">
                  <I className={cn("text-[11px]", cls)} />
                  <span className="flex-1 text-ink/80">{c.name}</span>
                  <span className="text-2xs text-ink/40">{c.minutes}m</span>
                </li>
              );
            })}
          </ul>
        </>
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
          { id: "main", title: "Item", component: ItemMain, defaultSize: 68, minSize: 45 },
          { id: "side", title: "Decisions and links", component: ItemSide, defaultSize: 32, minSize: 20, maxSize: 45, collapsible: true },
        ],
      },
    },
  ],
};
