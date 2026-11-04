// Home page: one feed of units of work, running and finished, with what is wrong in a strip above it.
import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, BroadcastIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { useNow } from "../../lib/useNow";
import { useScrollAnchor } from "../../lib/useScrollAnchor";
import { EntryRow } from "../../ui/molecules/EntryRow";
import { HealthStrip } from "../../ui/organisms/HealthStrip";
import { Block, ErrorLine, Page } from "../admin/parts";
import { useFeed } from "./useFeed";

/** After the last scroll or pointer move over the feed, new entries keep waiting this long. */
const IDLE_MS = 4000;

const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
};

function NowView(_: ViewProps) {
  const api = useApi();
  const q = useQuery("now", (a) => a.now());
  const d = q.data;
  useNow(d?.entries.some((e) => e.state === "running") ? 1000 : undefined);

  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const active = useRef(0);
  const [over, setOver] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [, tick] = useState(0);
  const idle = Date.now() - active.current >= IDLE_MS;
  const f = useFeed(d, (before) => api.nowFeed(before), over || !atTop || !idle);
  useScrollAnchor(list, f.feed);

  // New entries wait while the reader is down the list, over the feed or just moved; this re-checks once the wait is over.
  const waiting = f.pending.length > 0;
  useEffect(() => {
    if (!waiting || idle) return;
    const t = setTimeout(() => tick((n) => n + 1), IDLE_MS);
    return () => clearTimeout(t);
  }, [waiting, idle]);

  const { flush } = f;
  useEffect(() => {
    const sp = scrollParent(box.current);
    if (!sp) return;
    const onScroll = () => {
      active.current = Date.now();
      const top = sp.scrollTop <= 0;
      setAtTop(top);
      if (top) flush();
    };
    sp.addEventListener("scroll", onScroll, { passive: true });
    return () => sp.removeEventListener("scroll", onScroll);
  }, [flush]);

  const { hasMore, loading, more } = f;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, more, f.feed.length]);

  const toTop = () => {
    flush();
    scrollParent(box.current)?.scrollTo({ top: 0 });
  };

  return (
    <Page title="Now">
      <ErrorLine error={q.error && !d ? q.error.message : null} className="mt-3" />
      <div ref={box} className="mx-auto mt-4 max-w-3xl space-y-3" onPointerEnter={() => { active.current = Date.now(); setOver(true); }} onPointerLeave={() => { active.current = Date.now(); setOver(false); }}>
        <div className="min-h-8">{d && <HealthStrip health={d.health} />}</div>
        <p className="h-4 truncate text-xs text-ink/55">{d && d.alsoRunning.length > 0 ? `Also running: ${d.alsoRunning.join(", ").toLowerCase()}` : null}</p>
        {waiting && (
          <div className="sticky top-2 z-20 !mt-0 h-0 overflow-visible text-center">
            <button type="button" onClick={toTop} className="inline-flex h-8 items-center gap-1 rounded-full border border-accent-ink/40 bg-panel px-3 text-xs font-medium text-accent-ink shadow-md max-md:h-11">
              <ArrowUpIcon aria-hidden /> {f.pending.length} new
            </button>
          </div>
        )}
        <Block flush title="Now">
          {!d ? (
            <div className="h-96" aria-hidden />
          ) : f.feed.length === 0 ? (
            <p className="p-4 text-sm text-ink/55">Nothing yet.</p>
          ) : (
            <ul ref={list}>
              {f.feed.map((e) => <EntryRow key={e.key} entry={e} />)}
              <li ref={sentinel} className="h-12 px-3 py-3 text-xs text-ink/50">{f.error ? `Could not load older entries: ${f.error}` : null}</li>
            </ul>
          )}
        </Block>
      </div>
    </Page>
  );
}

export const nowModule: FeatureModule = {
  id: "now",
  permission: "viewer",
  nav: { label: "Now", icon: BroadcastIcon, to: "/" },
  commands: [{ id: "go-now", keys: "g h", label: "Go to Now (home)", group: "Go to" }],
  routes: [{ path: "/", view: { id: "now", title: "Now", panels: [{ id: "main", title: "Now", component: NowView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.now(),
};
