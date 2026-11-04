import { useState } from "react";
import { Link } from "react-router-dom";
import { CaretDownIcon, CheckCircleIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import type { NowHealth, NowProblem } from "../../api/types";
import { cn } from "../cn";
import { TimeAgo } from "../atoms/TimeAgo";

const TONE: Record<NowProblem["tone"], { Icon: typeof WarningIcon; cls: string }> = {
  bad: { Icon: WarningCircleIcon, cls: "border-bad/40 bg-bad/10 text-bad" },
  warn: { Icon: WarningIcon, cls: "border-warn/40 bg-warn/10 text-warn" },
};

/** Problems keep one place in the strip whatever order they arrive in. */
const AREAS: NowProblem["area"][] = ["pipeline", "runner", "sync", "breaker", "limit", "account", "jev", "main-ci", "jobs"];
const place = (p: NowProblem) => AREAS.indexOf(p.area);

/** What is wrong, one chip per problem linking to where it is fixed; one line when nothing is. On phones the chips fold into one "N problems" line. */
export function HealthStrip({ health }: { health: NowHealth }) {
  const healthy = health.problems.length === 0;
  const [open, setOpen] = useState(false);
  const worst = health.problems.some((p) => p.tone === "bad") ? "bad" : "warn";
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2" role="status">
      {!healthy && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn("flex h-11 w-full items-center gap-1.5 rounded-md border px-2.5 text-sm md:hidden", TONE[worst].cls)}>
          {(() => { const { Icon } = TONE[worst]; return <Icon aria-hidden />; })()}
          <span className="text-ink">{health.problems.length} problem{health.problems.length === 1 ? "" : "s"}</span>
          <CaretDownIcon className={cn("ml-auto", open && "rotate-180")} aria-hidden />
        </button>
      )}
      {healthy && (
        <span className="flex h-8 items-center gap-1.5 rounded-md border border-ok/40 bg-ok/10 px-2.5 text-sm text-ok">
          <CheckCircleIcon weight="fill" aria-hidden /> All healthy
        </span>
      )}
      {[...health.problems].sort((a, b) => place(a) - place(b) || (a.id < b.id ? -1 : 1)).map((p) => {
        const { Icon, cls } = TONE[p.tone];
        return (
          <Link key={p.id} to={p.to} className={cn(!open && "max-md:hidden", "flex min-h-8 max-w-full items-start gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:brightness-110 max-md:min-h-11 max-md:items-center", cls)}>
            <Icon className="mt-0.5 shrink-0 max-md:mt-0" aria-hidden />
            <span className="min-w-0 break-words text-ink [overflow-wrap:anywhere]">{p.text}</span>
            {p.since && <TimeAgo iso={p.since} className="num ml-1 shrink-0 text-xs text-ink/50" />}
          </Link>
        );
      })}
    </div>
  );
}
