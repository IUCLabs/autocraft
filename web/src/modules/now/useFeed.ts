import { useCallback, useEffect, useRef, useState } from "react";
import type { NowEntry, NowFeed } from "../../api/types";

const overlaps = (a: NowEntry, b: NowEntry) => a.ids.some((id) => b.ids.includes(id));
const newestFirst = (a: NowEntry, b: NowEntry) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1);

/**
 * The feed of work. Entries shown never leave or reorder: a refreshed head only updates an entry in place when it covers some of
 * the same events (a job that ended, a group that grew), and entries that are new wait in `pending` until the caller lets them in.
 * Older pages append.
 */
export function useFeed(head: NowFeed | undefined, loadOlder: (before: string) => Promise<NowFeed>, held: boolean) {
  const [feed, setFeed] = useState<NowEntry[]>([]);
  const [pending, setPending] = useState<NowEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const feedRef = useRef(feed);
  const pendingRef = useRef(pending);
  feedRef.current = feed;
  pendingRef.current = pending;

  useEffect(() => {
    if (!head) return;
    if (!started.current) {
      started.current = true;
      setFeed(head.entries);
      setCursor(head.nextCursor);
      return;
    }
    const inPlace = (list: NowEntry[], e: NowEntry) => {
      const i = list.findIndex((x) => overlaps(x, e));
      if (i < 0) return false;
      if (JSON.stringify(list[i]) !== JSON.stringify(e)) list[i] = e;
      return true;
    };
    const f = [...feedRef.current];
    const p = [...pendingRef.current];
    const fresh = head.entries.filter((e) => !inPlace(f, e) && !inPlace(p, e));
    setFeed(f);
    if (fresh.length) setPending([...p, ...fresh].sort(newestFirst));
    else setPending(p);
  }, [head]);

  const flush = useCallback(() => {
    if (!pendingRef.current.length) return;
    setFeed([...pendingRef.current, ...feedRef.current]);
    setPending([]);
  }, []);
  useEffect(() => {
    if (!held && pending.length) flush();
  }, [held, pending, flush]);

  const more = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const r = await loadOlder(cursor);
      setFeed((cur) => [...cur, ...r.entries.filter((e) => !cur.some((x) => overlaps(x, e)))]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, loadOlder]);

  return { feed, pending, flush, hasMore: cursor !== null, loading, error, more };
}
