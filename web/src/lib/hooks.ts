import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Runs a write and keeps its error message for display. `latestOnly`: when writes overlap, only the latest one started sets or
 * clears the error and the busy key, so an older write that fails after a newer one started does not leave its error behind.
 */
export function useWrite({ latestOnly = false }: { latestOnly?: boolean } = {}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback(async (key: string, f: () => Promise<unknown>) => {
    const n = ++seq.current;
    const mine = () => !latestOnly || n === seq.current;
    setBusy(key);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      if (mine()) setError((e as Error).message);
      return false;
    } finally {
      if (mine()) setBusy(null);
    }
  }, [latestOnly]);
  return { busy, error, setError, run };
}

/** URL search params as a flat record, with an updater that drops empty values. */
export function useUrlState() {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => Object.fromEntries(sp), [sp]);
  const update = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  return { state, update } as { state: Record<string, string | undefined>; update: typeof update };
}
