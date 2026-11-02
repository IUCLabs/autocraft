import { useCallback, useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, CircleAlertIcon } from "lucide-react";
import type { Role } from "../../api/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";

/** Scrolling page body with the app's content width. */
export function Page({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-5 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          {sub && <span className="text-sm text-ink/55">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Block({ title, aside, children, className, flush }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-md border border-line", className)}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <div className="ml-auto text-xs text-ink/50">{aside}</div>}
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        "h-8 min-w-0 rounded border border-line bg-sunken px-2.5 text-sm outline-none placeholder:text-ink/40 focus:border-accent/60 max-md:h-11",
        className,
      )}
    />
  );
}

export const selectCls = "h-8 rounded border border-line bg-sunken px-1.5 text-sm max-md:h-11";

export function ErrorLine({ error, className }: { error: string | null | undefined; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn("flex items-center gap-1.5 text-sm text-bad", className)}>
      <CircleAlertIcon className="shrink-0" />
      {error}
    </p>
  );
}

/** Runs a write and keeps its error message for display. */
export function useWrite() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
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

export function SortTh<K extends string>({
  k,
  sort,
  onSort,
  children,
  right,
  className,
}: {
  k?: K;
  sort?: { k: K; desc: boolean };
  onSort?: (k: K) => void;
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  const active = k !== undefined && sort?.k === k;
  return (
    <th className={cn("h-8 whitespace-nowrap px-3 font-medium", right ? "text-right" : "text-left", className)} aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}>
      {k !== undefined && onSort ? (
        <button onClick={() => onSort(k)} className={cn("inline-flex items-center gap-1", active ? "text-ink" : "text-ink/55 hover:text-ink")}>
          {children}
          {active ? sort!.desc ? <ArrowDownIcon className="text-[11px]" /> : <ArrowUpIcon className="text-[11px]" /> : <ChevronsUpDownIcon className="text-[11px] opacity-50" />}
        </button>
      ) : (
        <span className="text-ink/55">{children}</span>
      )}
    </th>
  );
}

export function Pager({ offset, limit, total, onOffset }: { offset: number; limit: number; total: number; onOffset: (o: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs text-ink/55">
      <span className="num">
        {num(offset + 1)}–{num(Math.min(total, offset + limit))} of {num(total)}
      </span>
      <Button size="sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>
        Previous
      </Button>
      <Button size="sm" disabled={offset + limit >= total} onClick={() => onOffset(offset + limit)}>
        Next
      </Button>
    </div>
  );
}

export const ROLE_LABEL: Record<Role, string> = { operator: "Operator", maintainer: "Maintainer", viewer: "Viewer" };
export const ROLES: Role[] = ["operator", "maintainer", "viewer"];

/** "2026-11-02 10:40" in UTC. */
export const when = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "–");

/** A destructive action that takes a second click within four seconds. */
export function ConfirmButton({ label, confirmLabel, loading, onConfirm, className }: { label: string; confirmLabel: string; loading?: boolean; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant={armed ? "destructive" : "ghost"}
      loading={loading}
      className={cn("max-md:h-11", className)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
