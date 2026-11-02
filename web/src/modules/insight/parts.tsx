import type { ReactNode } from "react";
import { cn } from "../../ui/cn";

export function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-raised/40 px-4 py-3">
      <div className="text-xs text-ink/55">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink/50">{sub}</div>}
    </div>
  );
}

export function Block({ title, aside, children, className, flush }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-md border border-line", className)}>
      <div className="flex min-h-10 items-center gap-2 border-b border-line px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="ml-auto text-xs text-ink/50">{aside}</span>}
      </div>
      <div className={flush ? "overflow-x-auto" : "p-4"}>{children}</div>
    </section>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink/60">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-7 rounded border border-line bg-sunken px-1.5 text-xs text-ink">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export const Th = ({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <th className={cn("h-8 whitespace-nowrap px-3 font-medium text-ink/55", right ? "text-right" : "text-left", className)}>{children}</th>
);

/** One decimal, for rates where whole percents hide the differences. */
export const rate = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : "–");

/** A thin horizontal bar filled to `frac`. */
export function RateBar({ frac, className }: { frac: number; className?: string }) {
  return (
    <div className={cn("h-2 w-24 overflow-hidden rounded-sm bg-ink/[0.07]", className)} aria-hidden>
      <div className="h-full bg-c1" style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }} />
    </div>
  );
}
