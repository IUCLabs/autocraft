// The item's trace: Now/Next/Who header, filters and the event timeline grouped by head commit.
import { useEffect, useRef, useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { Item, ItemTrace, TraceEvent, TraceKind } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimelineEvent } from "../../ui/molecules/TimelineEvent";
import { TraceFilters } from "../../ui/molecules/TraceFilters";
import { HeadGroup } from "../../ui/organisms/HeadGroup";
import { TraceHeader } from "../../ui/organisms/TraceHeader";
import { callGroupSummary, groupByHead, groupCalls, pushedBy, TRACE_KIND } from "../../lib/trace";
import { TraceEventBody } from "./TraceEventBody";

const PAGE = 50;
const hashEvent = () => new URLSearchParams(window.location.hash.slice(1)).get("event");

/**
 * The trace request starts from the route's repo and number, beside the item request. The timeline shows once
 * the item is there too, so the header never pushes it down.
 */
export function TracePanel({ repo, number, it }: { repo: string; number: number; it?: Item }) {
  const api = useApi();
  const [kinds, setKinds] = useState<TraceKind[]>([]);
  const [autocraftOnly, setAutocraftOnly] = useState(false);
  const filterKey = `${[...kinds].sort().join(",")}|${autocraftOnly ? 1 : 0}`;
  const key = `item-trace:${repo}#${number}:${filterKey}`;

  // The last full answer per key: a `since` that still matches returns it unchanged, so a pushed refresh of an idle item costs one small reply.
  const last = useRef<{ key: string; trace: ItemTrace } | null>(null);
  const q = useQuery<ItemTrace>(key, async (a) => {
    const prev = last.current?.key === key ? last.current.trace : null;
    const r = await a.itemTrace(repo, number, { kinds: kinds.length ? kinds : undefined, autocraftOnly, limit: PAGE, since: prev?.stamp });
    if ("unchanged" in r && prev) return prev;
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    last.current = { key, trace: r };
    return r;
  });
  const first = q.data;

  const [older, setOlder] = useState<{ key: string; events: TraceEvent[]; cursor: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const olderNow = older?.key === filterKey ? older : null;
  const cursor = olderNow ? olderNow.cursor : (first?.nextCursor ?? null);
  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const r = await api.itemTrace(repo, number, { kinds: kinds.length ? kinds : undefined, autocraftOnly, limit: PAGE, cursor });
      if ("unchanged" in r) return;
      setOlder({ key: filterKey, events: [...(olderNow?.events ?? []), ...r.events], cursor: r.nextCursor });
    } catch (e) {
      setOlderError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const ids = new Set(first?.events.map((e) => e.id));
  const events = first ? [...first.events, ...(olderNow?.events ?? []).filter((e) => !ids.has(e.id))] : [];

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
    if (!id || scrolled.current || !events.some((e) => e.id === id)) return;
    scrolled.current = true;
    document.getElementById(`event-${id}`)?.scrollIntoView({ block: "start" });
  }, [events]);

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
                const row = (e: TraceEvent) => (
                  <TimelineEvent
                    key={e.id}
                    id={e.id}
                    Icon={TRACE_KIND[e.kind].Icon}
                    at={e.at}
                    actor={e.actor.name}
                    actorTone={e.actor.type === "person" ? "person" : "ours"}
                    summary={e.summary}
                    open={open.has(e.id)}
                    onToggle={() => toggle(e.id)}
                  >
                    <TraceEventBody event={e} item={it} />
                  </TimelineEvent>
                );
                if (!r.calls) return row(r.event);
                const gid = `group:${r.event.id}`;
                return (
                  <TimelineEvent
                    key={gid}
                    id={gid}
                    Icon={TRACE_KIND[r.event.kind].Icon}
                    at={r.event.at}
                    actor={r.event.call?.step ?? r.event.actor.name}
                    actorTone="ours"
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
        <ErrorLine error={olderError} className="mt-2" />
        {cursor && (
          <div className="mt-2">
            <Button size="sm" disabled={loadingOlder} onClick={() => void loadOlder()} className="max-md:h-11">
              Load older
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
