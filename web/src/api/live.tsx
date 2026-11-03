import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Emits the topics that changed; null means "unknown, refresh everything". Returns a stop function. */
export type LiveStatus = "connecting" | "open" | "down";
export type LiveSource = (emit: (topics: string[] | null) => void, status: (s: LiveStatus) => void) => () => void;

const LiveStatusContext = createContext<LiveStatus>("connecting");
export const useLiveStatus = () => useContext(LiveStatusContext);

/** Refetches the active queries that read any of `topics`. */
export function invalidateTopics(qc: QueryClient, topics: string[] | null): void {
  const changed = topics && new Set(topics);
  void qc.invalidateQueries({
    predicate: (q) => {
      const read = q.meta?.topics as string[] | null | undefined;
      return !changed || !read || read.some((t) => changed.has(t));
    },
  });
}

/**
 * The server's event stream (GET /api/live). The browser reconnects by itself; every
 * connection starts with the current counter of each topic, and the topics whose counter
 * differs from the last one seen here are invalidated, so changes made while the stream was
 * down are not lost. The first connection only records the counters.
 */
export function eventSource(url = "/api/live"): LiveSource {
  return (emit, status) => {
    let seen: Record<string, number> | null = null;
    const es = new EventSource(url);
    const merge = (seqs: Record<string, number>) => {
      const changed = seen ? Object.keys(seqs).filter((t) => seqs[t] !== seen![t]) : [];
      seen = { ...seen, ...seqs };
      return changed;
    };
    es.addEventListener("hello", (e) => {
      const changed = merge((JSON.parse((e as MessageEvent<string>).data) as { seqs: Record<string, number> }).seqs);
      if (changed.length) emit(changed);
      status("open");
    });
    es.addEventListener("change", (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as { topics: string[]; seqs: Record<string, number> };
      merge(d.seqs);
      emit(d.topics);
    });
    es.onerror = () => status(es.readyState === EventSource.CLOSED ? "down" : "connecting");
    return () => es.close();
  };
}

/** The mock API has no server: any mock write refreshes every query. */
export const mockSource = (subscribe: (fn: () => void) => () => void): LiveSource => (emit, status) => {
  status("open");
  return subscribe(() => emit(null));
};

/** One stream per tab. Hidden tabs still mark queries stale; TanStack refetches them on focus. */
export function LiveProvider({ source, children }: { source: LiveSource; children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  useEffect(() => {
    return source((topics) => invalidateTopics(qc, topics), setStatus);
  }, [qc, source]);
  return <LiveStatusContext.Provider value={status}>{children}</LiveStatusContext.Provider>;
}
