// The project scope: one repo every list in the app is narrowed to, or null for every repo.
// The server applies it from the `x-autocraft-scope` header, so views need not pass it.
import { useSyncExternalStore } from "react";

export const SCOPE_HEADER = "x-autocraft-scope";
const KEY = "autocraft:scope";

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

let scope = read();
const listeners = new Set<() => void>();

export const getScope = (): string | null => scope;

/** Sets the scope; listeners (the query cache, the picker) hear of it only when it changed. */
export function setScope(next: string | null): void {
  if (next === scope) return;
  scope = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: the scope lasts until the page reloads */
  }
  listeners.forEach((fn) => fn());
}

export function onScopeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useScope(): string | null {
  return useSyncExternalStore(onScopeChange, getScope);
}
