import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApi, usePagedQuery, useQuery } from "../../api/client";
import { decisionPath, parseDecisionRoute } from "../../lib/links";
import type { Decision, DecisionFilter, DecisionKind } from "../../api/types";

export const KIND_LABEL: Record<DecisionKind, string> = {
  scope: "Scope",
  duplicate: "Duplicates",
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
      status: sp.get("tab") === "answered" ? "answered" : sp.get("tab") === "backlog" ? "backlog" : sp.get("tab") === "snoozed" ? "snoozed" : sp.get("tab") === "opinions" ? "opinions" : "open",
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

/** The loaded pages of the list; `loadMore` appends the next one. A change refetches every loaded page. */
export function useDecisionList() {
  const { filter, search } = useDecisionFilter();
  const q = usePagedQuery(`decisions?${search}`, (a, after) => a.decisions.list({ ...filter, after }), (p) => p.next);
  const last = q.pages?.[q.pages.length - 1];
  const data = last && { ...last, decisions: q.pages!.flatMap((p) => p.decisions) };
  return { data, error: q.error, loading: q.loading, refetch: q.refetch, hasMore: q.hasMore, loadMore: q.loadMore, loadingMore: q.loadingMore };
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
  const { data: loaded } = useDecisionList();
  const route = parseDecisionRoute({ id: params.id, repo: params.repo, n: params.n, kind: params.kind });
  const byItem = route.by === "item" ? route : undefined;
  const found = useQuery(`decision:for:${byItem ? `${byItem.repo}#${byItem.number}:${byItem.kind ?? ""}` : ""}`, (a) => (byItem ? a.decisions.forItem(byItem.repo, byItem.number, byItem.kind as DecisionKind | undefined) : Promise.resolve(null)), { enabled: !!byItem });
  const id = route.by === "id" ? route.id : byItem && !found.loading ? found.data?.id : undefined;
  const go = useCallback(
    (next: Pick<Decision, "id" | "repo" | "number" | "kind" | "answer"> | undefined, auto = false) => {
      userSelection.id = auto ? undefined : next?.id;
      navigate(decisionPath(next, { search, siblings: loaded?.decisions }));
    },
    [navigate, search, loaded],
  );
  /** True while a repo/number link has not resolved yet, and when it resolved to nothing: the list must not pick another decision. */
  const byLink = !!byItem;
  return { id, go, byLink, item: byItem, missing: !!byItem && !found.loading && !found.data };
}

/** The decision with this id when the open list does not hold it (a link to an answered one, or to another tab's). */
export function usePinned(id: string | undefined, inList: boolean) {
  const d = useQuery(`decision:${id ?? ""}`, (a) => (id ? a.decisions.get(id) : Promise.reject(new Error("no decision"))), { enabled: !!id && !inList }).data;
  return d && d.id === id ? d : undefined;
}

// ---- view-local state shared by the list, detail and thread panels ----

export interface AnswerEntry {
  id: string;
  label: string;
  ref: string;
  /** From the answer's response; the live value comes from the decision itself. */
  undoable: boolean;
}

const NOTICE_MS = 8000;
const ERROR_MS = 4000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

interface Local {
  checked: Set<string>;
  /** The latest answer, shown as a short notice with Undo; it expires after `NOTICE_MS` or at the next answer. */
  justAnswered: AnswerEntry[];
  /** The server's refusal of the last Undo, shown briefly next to the decision it concerns. */
  undoError: { id: string; message: string } | null;
  notes: Record<string, string>;
  /** The option picked in the Workflow box, by decision id (checked batches: ids joined with +). */
  picks: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
}
let local: Local = { checked: new Set(), justAnswered: [], undoError: null, notes: {}, picks: {}, overrides: {} };
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
  answered(entries: AnswerEntry[]) {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => set((l) => ({ ...l, justAnswered: [] })), NOTICE_MS);
    set((l) => ({ ...l, justAnswered: entries, undoError: null, checked: new Set() }));
  },
  forget: (id: string) => set((l) => ({ ...l, justAnswered: l.justAnswered.filter((x) => x.id !== id) })),
  /** Shows the refusal, then drops it and the notice of that decision. */
  undoFailed(id: string, message: string) {
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => set((l) => ({ ...l, undoError: null, justAnswered: l.justAnswered.filter((x) => x.id !== id) })), ERROR_MS);
    set((l) => ({ ...l, undoError: { id, message } }));
  },
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
        const res = await api.decisions.answer(d.id, {
          answer: key,
          textsHash: d.optionTexts?.find((t) => t.option === key)?.hash,
          note: local.notes[d.id] || undefined,
          exceptions: Object.entries(overrides).map(([ref, answer]) => {
            const [repo, n] = ref.split("#");
            return { repo, number: Number(n), answer };
          }),
        });
        entries.push({ id: d.id, ref: refOf(d), label: d.options.find((o) => o.key === key)?.label ?? key, undoable: res?.undoable ?? true });
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
      try {
        await api.decisions.undo(target);
        localActions.forget(target);
      } catch (e) {
        localActions.undoFailed(target, e instanceof Error ? e.message : "Could not undo");
      }
    },
    [api],
  );
}

/** Whether Undo still works for a decision: the live decision when loaded, else what the answer returned. */
export function useUndoable(id: string, fallback: boolean): boolean {
  const d = useQuery(`decision:${id}`, (a) => a.decisions.get(id)).data;
  return d && d.id === id ? d.undoable : fallback;
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
