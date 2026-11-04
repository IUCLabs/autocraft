// Home page: one timeline of units of work, newest at the top like a social feed, with the health problems in the app header.
import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { useNow } from "../../lib/useNow";
import { EntryRow } from "../../ui/molecules/EntryRow";
import { ErrorLine } from "../admin/parts";
import { useFeed } from "./useFeed";

/** Pull distance (after resistance) that releases into a refresh. */
const THRESHOLD = 64;
const MAX_PULL = 110;
/** The pulled distance is this share of the finger's. */
const RESISTANCE = 0.45;
/** Time the refetched head gets to arrive before waiting entries are let in. */
const REFRESH_MS = 700;

export function NowView(_: ViewProps) {
  const api = useApi();
  const q = useQuery("now", (a) => a.now());
  const d = q.data;
  useNow(d?.entries.some((e) => e.state === "running") ? 1000 : undefined);

  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLLIElement>(null);
  const f = useFeed(d, (before) => api.nowFeed(before));
  const { flush } = f;
  const { refetch } = q;

  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const refresh = () => {
    refreshingRef.current = true;
    setRefreshing(true);
    setPull(THRESHOLD * 0.75);
    refetch();
    setTimeout(() => {
      flush();
      refreshingRef.current = false;
      setRefreshing(false);
      setPull(0);
    }, REFRESH_MS);
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Pull to refresh on touch: only a gesture that starts at the very top and moves down.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let startY: number | null = null;
    let dist = 0;
    const onStart = (e: TouchEvent) => {
      startY = sc.scrollTop <= 0 && !refreshingRef.current ? e.touches[0]!.clientY : null;
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0 || sc.scrollTop > 0) {
        if (dist > 0) { dist = 0; setPull(0); setDragging(false); }
        return;
      }
      if (e.cancelable) e.preventDefault();
      dist = Math.min(MAX_PULL, dy * RESISTANCE);
      setDragging(true);
      setPull(dist);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      setDragging(false);
      if (dist >= THRESHOLD) refreshRef.current();
      else setPull(0);
      dist = 0;
    };
    sc.addEventListener("touchstart", onStart, { passive: true });
    sc.addEventListener("touchmove", onMove, { passive: false });
    sc.addEventListener("touchend", onEnd);
    sc.addEventListener("touchcancel", onEnd);
    return () => {
      sc.removeEventListener("touchstart", onStart);
      sc.removeEventListener("touchmove", onMove);
      sc.removeEventListener("touchend", onEnd);
      sc.removeEventListener("touchcancel", onEnd);
    };
  }, [d !== undefined]);

  // Older pages load as the end of the list nears.
  const { hasMore, loading, more } = f;
  const last = f.feed[f.feed.length - 1]?.key ?? "";
  useEffect(() => {
    const el = bottom.current;
    const sc = scroller.current;
    if (!el || !sc || !hasMore || loading) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { root: sc, rootMargin: "0px 0px 400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, more, last]);

  const toTop = () => {
    flush();
    scroller.current?.scrollTo({ top: 0 });
  };

  const waiting = f.pending.length > 0;
  return (
    <div className="relative h-full">
      <div ref={scroller} className="h-full overflow-y-auto overscroll-y-contain">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center" style={{ transform: `translateY(${pull - 36}px)`, transition: dragging ? "none" : "transform 200ms ease-out", opacity: Math.min(1, pull / 24) }} aria-hidden>
          <span className="flex size-8 items-center justify-center rounded-full border border-line bg-panel text-ink/70 shadow-md">
            {refreshing ? <CircleNotchIcon className="animate-spin" /> : <ArrowDownIcon style={{ transform: `rotate(${pull >= THRESHOLD ? 180 : 0}deg)`, transition: "transform 150ms" }} />}
          </span>
        </div>
        <div className="mx-auto max-w-3xl" style={{ transform: pull ? `translateY(${pull}px)` : undefined, transition: dragging ? "none" : "transform 200ms ease-out" }}>
          <ErrorLine error={q.error && !d ? q.error.message : null} className="m-3" />
          {!d ? null : f.feed.length === 0 ? (
            <p className="p-4 text-sm text-ink/55">Nothing yet.</p>
          ) : (
            <ul>
              {d.alsoRunning.length > 0 && <li className="truncate px-3 py-2 text-xs text-ink/55">{`Also running: ${d.alsoRunning.join(", ").toLowerCase()}`}</li>}
              {f.feed.map((e) => <EntryRow key={e.key} entry={e} />)}
              <li ref={bottom} className="h-8 px-3 py-2 text-xs text-ink/50">{f.error ? `Could not load older entries: ${f.error}` : null}</li>
            </ul>
          )}
        </div>
      </div>
      {waiting && pull === 0 && (
        <button type="button" onClick={toTop} className="absolute left-1/2 top-3 z-20 inline-flex h-8 -translate-x-1/2 items-center gap-1 rounded-full border border-accent-ink/40 bg-panel px-3 text-xs font-medium text-accent-ink shadow-md max-md:h-11">
          <ArrowUpIcon aria-hidden /> {f.pending.length} new
        </button>
      )}
    </div>
  );
}
