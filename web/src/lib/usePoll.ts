import { useEffect, useRef } from "react";

/** Calls `refetch` every `ms` while the tab is visible. */
export function usePoll(refetch: () => void, ms: number) {
  const ref = useRef(refetch);
  ref.current = refetch;
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
