import { Link } from "react-router-dom";
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import type { NowHealth, NowProblem } from "../../api/types";
import { cn } from "../cn";
import { TimeAgo } from "../atoms/TimeAgo";

const TONE: Record<NowProblem["tone"], { Icon: typeof WarningIcon; cls: string }> = {
  bad: { Icon: WarningCircleIcon, cls: "border-bad/40 bg-bad/10 text-bad" },
  warn: { Icon: WarningIcon, cls: "border-warn/40 bg-warn/10 text-warn" },
  info: { Icon: InfoIcon, cls: "border-line-strong text-ink/70" },
};

/** What is wrong, one chip per problem linking to where it is fixed; one line when nothing is. */
export function HealthStrip({ health }: { health: NowHealth }) {
  const healthy = health.problems.every((p) => p.tone === "info");
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      {healthy && (
        <span className="flex h-8 items-center gap-1.5 rounded-md border border-ok/40 bg-ok/10 px-2.5 text-sm text-ok">
          <CheckCircleIcon weight="fill" aria-hidden /> All healthy
        </span>
      )}
      {health.problems.map((p) => {
        const { Icon, cls } = TONE[p.tone];
        return (
          <Link key={p.id} to={p.to} className={cn("flex min-h-8 max-w-full items-start gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:brightness-110 max-md:min-h-11 max-md:items-center", cls)}>
            <Icon className="mt-0.5 shrink-0 max-md:mt-0" aria-hidden />
            <span className="min-w-0 break-words text-ink [overflow-wrap:anywhere]">{p.text}</span>
            {p.since && <TimeAgo iso={p.since} className="num ml-1 shrink-0 text-xs text-ink/50" />}
          </Link>
        );
      })}
    </div>
  );
}
