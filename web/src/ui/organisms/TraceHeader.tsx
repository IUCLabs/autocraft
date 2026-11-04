import { Link } from "react-router-dom";
import type { ItemTraceHeader } from "../../api/types";
import { Badge } from "../atoms/Badge";
import { TimeAgo } from "../atoms/TimeAgo";
import { nextLabel, shortSha } from "../../lib/trace";

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 py-2 md:px-4 md:first:pl-0 md:last:pr-0">
      <div className="text-xs font-semibold text-ink/55">{label}</div>
      <div className="mt-0.5 text-sm leading-5">{children}</div>
    </div>
  );
}

/** Now, Next and Who in words, from the trace header. */
export function TraceHeader({ header, decisionHref }: { header: ItemTraceHeader; decisionHref: (id: string) => string }) {
  const { now, next, who } = header;
  const people = who.assignees;
  return (
    <div className="mt-4 grid grid-cols-1 divide-y divide-line rounded-md border border-line px-4 md:grid-cols-3 md:divide-x md:divide-y-0">
      <Cell label="Now">
        <p className="break-words">{now.text}</p>
        {(now.state || now.plannedAt) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink/55">
            {now.state && <Badge>{now.state}</Badge>}
            {now.head && <span className="code">{shortSha(now.head)}</span>}
            {now.plannedAt && <TimeAgo iso={now.plannedAt} short={false} className="num" />}
          </p>
        )}
        {now.reasons.length > 0 && <p className="mt-0.5 text-xs text-ink/60">{now.reasons.join("; ")}</p>}
      </Cell>
      <Cell label="Next">
        {next.length === 0 ? (
          <span className="text-ink/55">Nothing due.</span>
        ) : (
          <ol className="list-inside list-decimal">
            {next.map((a, i) => (
              <li key={`${a.kind}${i}`}>
                {nextLabel(a.kind)}
                {a.head && <span className="code text-xs text-ink/55"> at {shortSha(a.head)}</span>}
              </li>
            ))}
          </ol>
        )}
      </Cell>
      <Cell label="Who">
        <p>{who.autocraftAssigned ? "AutoCraft" : people.length ? people.join(", ") : "Nobody assigned"}</p>
        {who.openDecisions.map((d) => (
          <p key={d.id} className="mt-0.5">
            <Link to={decisionHref(d.id)} className="text-accent-ink hover:underline">
              Open {d.kind} decision: {d.question}
            </Link>
          </p>
        ))}
        {who.holds.map((h) => (
          <p key={h.at} className="mt-0.5 text-ink/70">
            On hold by {h.by} <TimeAgo iso={h.at} short={false} className="num text-xs text-ink/50" />
          </p>
        ))}
      </Cell>
    </div>
  );
}
