// Home page: one feed of units of work, oldest at the top and newest at the bottom like a chat log, with what is wrong in a strip above it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon, BroadcastIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { useNow } from "../../lib/useNow";
import { EntryRow } from "../../ui/molecules/EntryRow";
import { HealthStrip } from "../../ui/organisms/HealthStrip";
import { ErrorLine } from "../admin/parts";
import { useFeed } from "./useFeed";

/** After the last scroll, wheel, touch or key press, new entries keep waiting this long. */
const IDLE_MS = 4000;
const BOTTOM_PX = 4;

function NowView(_: ViewProps) {
  const api = useApi();
  const q = useQuery("now", (a) => a.now());
  const d = q.data;
  useNow(d?.entries.some((e) => e.state === "running") ? 1000 : undefined);

  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const top = useRef<HTMLLIElement>(null);
  const active = useRef(0);
  const force = useRef(false);
  const moved = useRef(false);
  const prev = useRef({ height: 0, oldest: "", newest: "" });
  const [atBottom, setAtBottom] = useState(true);
  const [, tick] = useState(0);
  const idle = Date.now() - active.current >= IDLE_MS;
  const f = useFeed(d, (before) => api.nowFeed(before), !atBottom || !idle);
  // The feed is newest first; it reads oldest first, like a chat log.
  const rows = [...f.feed].reverse();
  const oldest = f.feed[f.feed.length - 1]?.key ?? "";
  const newest = f.feed[0]?.key ?? "";

  // Older entries land above the reader: keep what is on screen where it is. New ones land below: stay at the bottom if there.
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const p = prev.current;
    const forced = force.current;
    force.current = false;
    const wasBottom = forced || !moved.current || p.height === 0 || sc.scrollTop + sc.clientHeight >= p.height - BOTTOM_PX;
    // Until the reader moves, the view stays at the bottom whatever loads; after that older entries must not shift it.
    if (p.oldest && oldest !== p.oldest && moved.current && !forced) sc.scrollTop += sc.scrollHeight - p.height;
    else if (wasBottom) sc.scrollTop = sc.scrollHeight;
    prev.current = { height: sc.scrollHeight, oldest, newest };
  }, [f.feed, oldest, newest]);

  // A running entry grows or ends in place; at the bottom the view follows it.
  useEffect(() => {
    const ul = list.current;
    const sc = scroller.current;
    if (!ul || !sc) return;
    const ro = new ResizeObserver(() => {
      // The old height is the last one seen, so this tells whether the reader was at the bottom before the change.
      if (sc.scrollTop + sc.clientHeight >= prev.current.height - BOTTOM_PX) sc.scrollTop = sc.scrollHeight;
      prev.current.height = sc.scrollHeight;
    });
    ro.observe(ul);
    return () => ro.disconnect();
  }, [rows.length > 0]);

  const waiting = f.pending.length > 0;
  useEffect(() => {
    if (!waiting || idle) return;
    const t = setTimeout(() => tick((n) => n + 1), IDLE_MS);
    return () => clearTimeout(t);
  }, [waiting, idle]);

  const { flush } = f;
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const touch = () => { active.current = Date.now(); moved.current = true; };
    const onScroll = () => {
      active.current = Date.now();
      const bottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight <= BOTTOM_PX;
      setAtBottom(bottom);
      if (bottom) flush();
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) sc.addEventListener(ev, touch, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) sc.removeEventListener(ev, touch);
    };
  }, [flush]);

  const { hasMore, loading, more } = f;
  useEffect(() => {
    const el = top.current;
    const sc = scroller.current;
    if (!el || !sc || !hasMore || loading) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { root: sc, rootMargin: "400px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, more, oldest]);

  const toBottom = () => {
    force.current = true;
    active.current = 0;
    flush();
    const sc = scroller.current;
    if (sc) sc.scrollTop = sc.scrollHeight;
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-4 pt-5 md:px-6">
      <h1 className="text-xl font-semibold">Now</h1>
      <ErrorLine error={q.error && !d ? q.error.message : null} className="mt-3" />
      <div className="mt-3 min-h-8">{d && <HealthStrip health={d.health} />}</div>
      <p className="mt-2 h-4 truncate text-xs text-ink/55">{d && d.alsoRunning.length > 0 ? `Also running: ${d.alsoRunning.join(", ").toLowerCase()}` : null}</p>
      <div className="relative mb-3 mt-2 min-h-0 flex-1 overflow-hidden rounded-md border border-line bg-panel">
        <div ref={scroller} className="h-full overflow-y-auto [overflow-anchor:none]">
          {!d ? null : rows.length === 0 ? (
            <p className="p-4 text-sm text-ink/55">Nothing yet.</p>
          ) : (
            <ul ref={list}>
              <li ref={top} className="h-8 px-3 py-2 text-xs text-ink/50">{f.error ? `Could not load older entries: ${f.error}` : null}</li>
              {rows.map((e) => <EntryRow key={e.key} entry={e} />)}
            </ul>
          )}
        </div>
        {waiting && (
          <button type="button" onClick={toBottom} className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1 rounded-full border border-accent-ink/40 bg-panel px-3 text-xs font-medium text-accent-ink shadow-md max-md:h-11">
            {f.pending.length} new <ArrowDownIcon aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

export const nowModule: FeatureModule = {
  id: "now",
  permission: "viewer",
  nav: { label: "Now", icon: BroadcastIcon, to: "/" },
  commands: [{ id: "go-now", keys: "g h", label: "Go to Now (home)", group: "Go to" }],
  routes: [{ path: "/", view: { id: "now", title: "Now", phone: NowView, panels: [{ id: "main", title: "Now", component: NowView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.now(),
};
