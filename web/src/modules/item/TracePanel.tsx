// The item's trace: Now/Next/Who header, filters and the event timeline grouped by head commit.
import { SparkleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { usePagedQuery } from "../../api/client";
import type { Item, ItemTrace, TraceEvent, TraceKind } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimelineEvent } from "../../ui/molecules/TimelineEvent";
import { TraceFilters } from "../../ui/molecules/TraceFilters";
import { HeadGroup } from "../../ui/organisms/HeadGroup";
import { TraceHeader } from "../../ui/organisms/TraceHeader";
import { callGroupSummary, eventCost, groupByHead, groupCalls, groupCost, pushedBy } from "../../lib/trace";
import { timelineIcon } from "../../ui/molecules/timelineIcon";
import { TraceEventBody } from "./TraceEventBody";

const PAGE = 50;
const dedupe = (events: TraceEvent[]) => {
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && seen.add(e.id));
};
const hashEvent = () => new URLSearchParams(window.location.hash.slice(1)).get("event");

/**
 * The trace request starts from the route's repo and number, beside the item request. The timeline shows once
 * the item is there too, so the header never pushes it down.
 */
export function TracePanel({ repo, number, it }: { repo: string; number: number; it?: Item }) {
  const [kinds, setKinds] = useState<TraceKind[]>([]);
  const [autocraftOnly, setAutocraftOnly] = useState(false);
  const filterKey = `${[...kinds].sort().join(",")}|${autocraftOnly ? 1 : 0}`;
  const key = `item-trace:${repo}#${number}:${filterKey}`;

  // Oldest first: a change event refetches every loaded page in order, so new events append at the bottom and "Load more" keeps its place.
  const q = usePagedQuery<ItemTrace>(
    key,
    async (a, cursor) => {
      const r = await a.itemTrace(repo, number, { kinds: kinds.length ? kinds : undefined, autocraftOnly, limit: PAGE, cursor });
      if ("unchanged" in r) throw new Error("unexpected empty answer");
      return r;
    },
    (p) => p.nextCursor,
  );
  const first = q.pages?.[0];
  const events = q.pages ? dedupe(q.pages.flatMap((p) => p.events)) : [];

  const [open, setOpen] = useState<Set<string>>(() => {
    const id = hashEvent();
    return new Set(id ? [id] : []);
  });
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  // A link with #event=<id> opens that row and scrolls to it once the row exists.
  const scrolled = useRef(false);
  useEffect(() => {
    const id = hashEvent();
    if (!id || scrolled.current) return;
    if (!events.some((e) => e.id === id)) {
      if (q.hasMore && !q.loadingMore) q.loadMore();
      return;
    }
    scrolled.current = true;
    document.getElementById(`event-${id}`)?.scrollIntoView({ block: "start" });
  }, [events, q.hasMore, q.loadingMore]);

  if (!it) return null;
  if (!first) return q.error ? <ErrorLine error={q.error.message} className="mt-4" /> : <div className="mt-4 h-24" aria-hidden />;
  const groups = groupByHead(events);
  return (
    <>
      <TraceHeader header={first.header} decisionHref={(id) => `/needs/decisions/${encodeURIComponent(id)}`} />
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
        <TraceFilters kinds={kinds} onKinds={setKinds} autocraftOnly={autocraftOnly} onAutocraftOnly={setAutocraftOnly} />
        <div className="mt-2 overflow-hidden rounded-md border border-line">
          {groups.length === 0 && <p className="px-3 py-3 text-sm text-ink/55">No events match.</p>}
          {groups.map((g) => (
            <HeadGroup key={`${g.head}:${g.events[0]!.id}`} head={g.head} pushedBy={g.head ? pushedBy(events, g.head) : null}>
              {groupCalls(g.events).map((r) => {
                const row = (e: TraceEvent) => {
                  const ic = timelineIcon(e);
                  return (
                  <TimelineEvent
                    key={e.id}
                    id={e.id}
                    Icon={ic.Icon}
                    iconLabel={ic.label}
                    iconTone={ic.ours ? "ours" : "person"}
                    at={e.at}
                    actor={e.actor.name}
                    actorTone={e.actor.type === "person" ? "person" : "ours"}
                    cost={eventCost(e)}
                    summary={e.summary}
                    open={open.has(e.id)}
                    onToggle={() => toggle(e.id)}
                  >
                    <TraceEventBody event={e} item={it} />
                  </TimelineEvent>
                  );
                };
                if (!r.calls) return row(r.event);
                const gid = `group:${r.event.id}`;
                return (
                  <TimelineEvent
                    key={gid}
                    id={gid}
                    Icon={SparkleIcon}
                    iconLabel="Model call"
                    iconTone="ours"
                    at={r.event.at}
                    actor={r.event.call?.step ?? r.event.actor.name}
                    actorTone="ours"
                    cost={groupCost(r.calls)}
                    summary={callGroupSummary(r.calls)}
                    open={r.calls.some((c) => c.id === hashEvent()) !== open.has(gid)}
                    onToggle={() => toggle(gid)}
                    flush
                  >
                    <ul className="overflow-hidden rounded-md border border-line bg-panel">{r.calls.map(row)}</ul>
                  </TimelineEvent>
                );
              })}
            </HeadGroup>
          ))}
        </div>
        <ErrorLine error={q.error?.message} className="mt-2" />
        {q.hasMore && (
          <div className="mt-2">
            <Button size="sm" disabled={q.loadingMore} onClick={q.loadMore} className="max-md:h-11">
              Load more
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
