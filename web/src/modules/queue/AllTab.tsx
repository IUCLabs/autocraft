// The All, Review, Fix and Verify tabs: open items in work-rank order with the next pipeline step.
import { QueueBadge } from "../../ui/molecules/QueueBadge";
import { Link } from "react-router-dom";
import type { QueueWorkRow, WorkBreakdown } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { cn } from "../../ui/cn";
import { LevelBadge } from "../../ui/atoms/PriorityBadge";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { FastMark } from "./fastTrack";
import { RowMenu } from "./RowMenu";

/** Size and reach in one line; the hover text names where each came from. */
function Breakdown({ b }: { b: WorkBreakdown }) {
  const parts: [string, string][] = [
    ["size", `${b.size} (${{ lines: "from changed lines", triage: "Fix triage's estimate", default: "not known yet, medium counts" }[b.sizeSource]})`],
    ...(b.security ? [["security", "a classifier raised the security flag: one level higher"] as [string, string]] : []),
    ...(b.rated === null ? [["unrated", "no priority yet: P2 counts"] as [string, string]] : []),
  ];
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink/60">
      {parts.map(([name, hint]) => (
        <span key={name} title={hint} className="relative z-10">
          {name}
        </span>
      ))}
    </span>
  );
}

function Title({ r }: { r: QueueWorkRow }) {
  return (
    <div className="flex items-start gap-1">
      <FastMark fast={r.fast} />
      <ItemRef repo={r.repo} number={r.number} kind={r.kind} state="open" title={r.title} stretch />
    </div>
  );
}

function NextBadge({ r }: { r: QueueWorkRow }) {
  // A queued next step shows as its place in line; the plain step otherwise.
  if (r.queue) return <QueueBadge slot={r.queue} repo={r.repo} number={r.number} className="relative z-10" />;
  const badge = <Badge tone={r.nextHref ? "warn" : "neutral"}>{r.next}</Badge>;
  return r.nextHref ? (
    <Link to={r.nextHref} className="relative z-10">
      {badge}
    </Link>
  ) : (
    badge
  );
}

function WorkMenu({ r }: { r: QueueWorkRow }) {
  return <RowMenu repo={r.repo} number={r.number} fast={r.fast} held={r.held} pr={r.kind === "pr"} />;
}

function TableRow({ r, n, on }: { r: QueueWorkRow; n: number; on: boolean }) {
  return (
    <tr data-item={`${r.repo}:${r.number}`} className={cn("relative border-b border-line align-top last:border-0 hover:bg-ink/[0.03]", on && "bg-accent/10")}>
      <td className="num px-3 py-2 text-xs text-ink/45">{n}</td>
      <td className="px-3 py-2">
        <Title r={r} />
      </td>
      <td className="relative z-10 px-3 py-2" title={`Sort key ${r.score}, reach ${r.breakdown.reach}`}>
        <LevelBadge level={r.level} />
      </td>
      <td className="px-3 py-2 text-xs text-ink/70">{r.label ?? <span className="text-ink/35">not settled</span>}</td>
      <td className="num px-3 py-2 text-xs">{r.size}</td>
      <td className="px-3 py-2">
        <Breakdown b={r.breakdown} />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-1.5">
            <NextBadge r={r} />
            {r.held && <Badge tone="warn">Held</Badge>}
          </span>
          <WorkMenu r={r} />
        </div>
      </td>
    </tr>
  );
}

/** `highlight` is the Queue page's `item` parameter (`repo:number`): that row is marked and scrolled to by the page. */
export function WorkTable({ rows, highlight }: { rows: QueueWorkRow[]; highlight?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs text-ink/55">
          <tr className="border-b border-line text-left">
            <th className="h-8 w-[44px] px-3 font-medium">#</th>
            <th className="px-3 font-medium">Item</th>
            <th className="w-[70px] px-3 font-medium">Level</th>
            <th className="w-[110px] px-3 font-medium">Type</th>
            <th className="w-[60px] px-3 font-medium">Size</th>
            <th className="w-[160px] px-3 font-medium">Notes</th>
            <th className="w-[220px] px-3 font-medium">Next step</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <TableRow key={`${r.repo}#${r.number}`} r={r} n={i + 1} on={highlight === `${r.repo}:${r.number}`} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ r, n, on }: { r: QueueWorkRow; n: number; on: boolean }) {
  return (
    <li data-item={`${r.repo}:${r.number}`} className={cn("relative border-b border-line px-4 py-2.5 last:border-0", on && "bg-accent/10")}>
      <div className="flex items-start gap-2 text-xs text-ink/55">
        <span className="num mt-0.5">{n}.</span>
        <FastMark fast={r.fast} />
        <ItemRef repo={r.repo} number={r.number} kind={r.kind} state="open" title={r.title} stretch className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5">
          <LevelBadge level={r.level} />
          <WorkMenu r={r} />
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink/60">
        <NextBadge r={r} />
        {r.held && <Badge tone="warn">Held</Badge>}
        <span>{r.label ?? "not settled"}</span>
        <span className="num">{r.size}</span>
      </div>
      <div className="mt-1">
        <Breakdown b={r.breakdown} />
      </div>
    </li>
  );
}

export function WorkCards({ rows, highlight }: { rows: QueueWorkRow[]; highlight?: string }) {
  return (
    <ul>
      {rows.map((r, i) => (
        <Card key={`${r.repo}#${r.number}`} r={r} n={i + 1} on={highlight === `${r.repo}:${r.number}`} />
      ))}
    </ul>
  );
}
