import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApi, useQuery } from "../../api/client";
import type { Decision, DecisionFilter, DecisionKind } from "../../api/types";

export const KIND_LABEL: Record<DecisionKind, string> = {
  scope: "Scope",
  duplicate: "Duplicate",
  close: "Close",
  merge: "Merge",
  split: "Split",
  other: "Other",
};
export const KINDS = Object.keys(KIND_LABEL) as DecisionKind[];

/** Filters live in the URL so a link reproduces the view. */
export function useDecisionFilter() {
  const [sp, setSp] = useSearchParams();
  const filter: DecisionFilter = useMemo(
    () => ({
      repo: sp.get("repo")?.split(",").filter(Boolean),
      kind: sp.get("kind")?.split(",").filter(Boolean) as DecisionKind[] | undefined,
      minAge: sp.get("age") ? Number(sp.get("age")) : undefined,
      mine: sp.get("mine") === "1",
      status: sp.get("tab") === "answered" ? "answered" : sp.get("tab") === "opinions" ? "opinions" : "open",
    }),
    [sp],
  );
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  return { filter, update, search: sp.toString() };
}

/** The first page of the list; `loadMore` appends the next one. A refetch starts over from the first page. */
export function useDecisionList() {
  const { filter, search } = useDecisionFilter();
  const api = useApi();
  const q = useQuery(`decisions?${search}`, (a) => a.decisions.list(filter));
  const [extra, setExtra] = useState<{ decisions: Decision[]; next: string | null }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setExtra(undefined), [q.data]);
  const next = extra ? extra.next : (q.data?.next ?? null);
  const loadMore = useCallback(() => {
    if (!next || busy) return;
    setBusy(true);
    api.decisions.list({ ...filter, after: next }).then(
      (p) => setExtra((e) => ({ decisions: [...(e?.decisions ?? []), ...p.decisions], next: p.next })),
      () => undefined,
    ).finally(() => setBusy(false));
  }, [api, filter, next, busy]);
  const data = q.data && { ...q.data, decisions: [...q.data.decisions, ...(extra?.decisions ?? [])] };
  return { ...q, data, hasMore: next !== null, loadMore, loadingMore: busy };
}

/** Kind, then repo, then oldest first: the order the list shows and j/k walks. */
export function ordered(ds: Decision[]): Decision[] {
  return [...ds].sort(
    (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.repo.localeCompare(b.repo) || a.askedAt.localeCompare(b.askedAt),
  );
}

/**
 * The decision the user opened themselves (a click, j/k, the pager). Automatic selection
 * (the first one on arrival, the next one after an answer) does not count, so a digit key
 * never answers a decision the user has not chosen.
 */
export const userSelection: { id: string | undefined } = { id: undefined };

export function useSelection() {
  const params = useParams();
  const navigate = useNavigate();
  const { search } = useDecisionFilter();
  const id = params.id ? decodeURIComponent(params.id) : undefined;
  const go = useCallback(
    (next: string | undefined, auto = false) => {
      userSelection.id = auto ? undefined : next;
      navigate(`/decisions${next ? `/${encodeURIComponent(next)}` : ""}${search ? `?${search}` : ""}`);
    },
    [navigate, search],
  );
  return { id, go };
}

// ---- view-local state shared by the list, detail and thread panels ----

interface Local {
  checked: Set<string>;
  /** Decisions answered in this session, kept visible as a one-line confirmation. */
  justAnswered: { id: string; label: string; ref: string }[];
  notes: Record<string, string>;
  /** The option picked in the Workflow box, by decision id (checked batches: ids joined with +). */
  picks: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
}
let local: Local = { checked: new Set(), justAnswered: [], notes: {}, picks: {}, overrides: {} };
const subs = new Set<() => void>();
const set = (fn: (l: Local) => Local) => {
  local = fn(local);
  subs.forEach((f) => f());
};
export const useLocal = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => local,
  );
export const localActions = {
  toggle(id: string) {
    set((l) => {
      const checked = new Set(l.checked);
      checked.has(id) ? checked.delete(id) : checked.add(id);
      return { ...l, checked };
    });
  },
  clearChecked: () => set((l) => ({ ...l, checked: new Set() })),
  setPick: (key: string, option: string | null) =>
    set((l) => {
      const picks = { ...l.picks };
      option ? (picks[key] = option) : delete picks[key];
      return { ...l, picks };
    }),
  setNote: (id: string, note: string) => set((l) => ({ ...l, notes: { ...l.notes, [id]: note } })),
  setOverride: (id: string, ref: string, answer: string | null) =>
    set((l) => {
      const cur = { ...(l.overrides[id] ?? {}) };
      answer ? (cur[ref] = answer) : delete cur[ref];
      return { ...l, overrides: { ...l.overrides, [id]: cur } };
    }),
  answered: (entries: { id: string; label: string; ref: string }[]) =>
    set((l) => ({ ...l, justAnswered: [...entries, ...l.justAnswered.filter((x) => !entries.some((e) => e.id === x.id))], checked: new Set() })),
  forget: (id: string) => set((l) => ({ ...l, justAnswered: l.justAnswered.filter((x) => x.id !== id) })),
};

export const refOf = (d: Pick<Decision, "repo" | "number" | "items">) => (d.number === null ? `${d.repo} · ${d.items.length} items` : `${d.repo}#${d.number}`);

/** Answer one or more decisions and remember them for undo. */
export function useAnswer() {
  const api = useApi();
  return useCallback(
    async (ds: Decision[], key: string) => {
      const entries = [];
      for (const d of ds) {
        const overrides = local.overrides[d.id] ?? {};
        await api.decisions.answer(d.id, {
          answer: key,
          note: local.notes[d.id] || undefined,
          exceptions: Object.entries(overrides).map(([ref, answer]) => {
            const [repo, n] = ref.split("#");
            return { repo, number: Number(n), answer };
          }),
        });
        entries.push({ id: d.id, ref: refOf(d), label: d.options.find((o) => o.key === key)?.label ?? key });
      }
      localActions.answered(entries);
    },
    [api],
  );
}

export function useUndo() {
  const api = useApi();
  return useCallback(
    async (id?: string) => {
      const target = id ?? local.justAnswered[0]?.id;
      if (!target) return;
      await api.decisions.undo(target);
      localActions.forget(target);
    },
    [api],
  );
}

/** The option key waiting for its confirming pick; it lapses after four seconds. */
export function useArmed() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, setArmed] as const;
}
