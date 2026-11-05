import { SparkleIcon } from "@phosphor-icons/react";
import type { Item, TraceEvent } from "../../api/types";
import { TimelineEvent } from "../../ui/molecules/TimelineEvent";
import { timelineIcon } from "../../ui/molecules/timelineIcon";
import { HeadGroup } from "../../ui/organisms/HeadGroup";
import { callGroupSummary, eventCost, groupByHead, groupCalls, groupCost, pushedBy } from "../../lib/trace";
import { TraceEventBody } from "./TraceEventBody";

export const hashEvent = () => new URLSearchParams(window.location.hash.slice(1)).get("event");

/** Pipeline events as timeline rows grouped by head commit, with runs of model calls of one step folded into one row. */
export function PipelineRows({ events, all, item, open, toggle }: {
  events: TraceEvent[];
  /** Every loaded event, to find who pushed a head. */
  all: TraceEvent[];
  item: Item;
  open: Set<string>;
  toggle: (id: string) => void;
}) {
  return (
    <>
      {groupByHead(events).map((g) => (
        <HeadGroup key={`${g.head}:${g.events[0]!.id}`} head={g.head} pushedBy={g.head ? pushedBy(all, g.head) : null}>
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
                  <TraceEventBody event={e} item={item} />
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
    </>
  );
}
