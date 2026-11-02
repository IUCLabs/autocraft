// Hand-drawn SVG/HTML charts in the ArtCraft idiom: hairline axes, square
// marks, mono labels. Colours come from the --st-c* slots (validated for
// colour-vision separation on both theme surfaces).
import { useLayoutEffect, useRef, useState } from "react";
import type { Done, Funnel } from "../../api/types";
import { cn } from "../../ui/cn";
import { num, pct } from "../../lib/format";

export const OUTCOMES: { key: keyof Funnel; label: string; cls: string }[] = [
  { key: "take", label: "Taken", cls: "bg-c1" },
  { key: "hold", label: "Held", cls: "bg-c2" },
  { key: "close", label: "To close", cls: "bg-c3" },
  { key: "batched", label: "In a batch", cls: "bg-c4" },
  { key: "waiting", label: "Waiting for a decision", cls: "bg-c5" },
];

export const DONE_PARTS: { key: keyof Done; label: string; cls: string }[] = [
  { key: "mergedByPipeline", label: "Merged by pipeline", cls: "bg-c1" },
  { key: "closedByPipeline", label: "Closed by pipeline", cls: "bg-c2" },
  { key: "closedByOthers", label: "Closed by others", cls: "bg-ink/35" },
];

function Legend({ items }: { items: { label: string; cls: string; value?: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-xs text-ink/70">
          <span className={cn("size-2", i.cls)} />
          {i.label}
          {i.value !== undefined && <span className="font-mono text-ink">{num(i.value)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Stacked bar with 2px surface gaps between segments and a hover readout. */
export function StackBar({ parts, height = 10, total }: { parts: { label: string; cls: string; value: number }[]; height?: number; total?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="relative">
      <div className="flex gap-[2px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {parts.map((p, i) => (
          <div
            key={p.label}
            className={cn("h-full transition-opacity duration-fast", p.cls, hover !== null && hover !== i && "opacity-40")}
            style={{ width: `${(p.value / sum) * 100}%` }}
            onMouseEnter={() => setHover(i)}
            role="img"
            aria-label={`${p.label}: ${num(p.value)}`}
          />
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-8 left-0 z-10 whitespace-nowrap border border-line bg-raised px-2 py-1 font-mono text-2xs">
          {parts[hover].label} · {num(parts[hover].value)} · {pct(parts[hover].value, sum)}
        </div>
      )}
    </div>
  );
}

export function DoneSplit({ done }: { done: Done }) {
  const parts = DONE_PARTS.map((p) => ({ ...p, value: done[p.key] }));
  return (
    <div>
      <StackBar parts={parts} height={12} />
      <div className="mt-3">
        <Legend items={parts} />
      </div>
    </div>
  );
}

/** Funnel for open items: the three filter steps as bars, then how the reviewed ones split. */
export function FunnelChart({ f }: { f: Funnel }) {
  const steps = [
    { label: "Open", value: f.open, note: "" },
    { label: "Classified", value: f.classified, note: pct(f.classified, f.open) },
    { label: "Reviewed", value: f.reviewed, note: pct(f.reviewed, f.open) },
  ];
  const outcome = OUTCOMES.map((o) => ({ ...o, value: f[o.key] }));
  const routed = outcome.reduce((a, o) => a + o.value, 0);
  return (
    <div>
      <div className="space-y-2">
        {steps.map((s) => (
          <div key={s.label} className="grid grid-cols-[76px_1fr_64px] md:grid-cols-[96px_1fr_88px] items-center gap-3">
            <span className="hud text-2xs text-ink/60">{s.label}</span>
            <div className="h-7 bg-ink/[0.05]">
              <div className="h-full bg-ink/80" style={{ width: `${(s.value / f.open) * 100}%` }} />
            </div>
            <span className="text-right font-mono text-sm">
              {num(s.value)}
              {s.note && <span className="ml-1.5 text-2xs text-ink/45">{s.note}</span>}
            </span>
          </div>
        ))}
        <div className="grid grid-cols-[76px_1fr_64px] md:grid-cols-[96px_1fr_88px] items-center gap-3">
          <span className="hud text-2xs text-ink/60">Routed</span>
          <div className="h-7" style={{ width: `${Math.max((f.reviewed / f.open) * 100, 45)}%` }}>
            <StackBar parts={outcome} height={28} total={Math.max(routed, f.reviewed)} />
          </div>
          <span className="text-right font-mono text-sm">{num(routed)}</span>
        </div>
      </div>
      <div className="mt-4 md:pl-[108px]">
        <Legend items={outcome} />
      </div>
    </div>
  );
}

/** Items done per hour, last 24 h: single-hue columns with an average line and hover readout. */
export function Throughput({ perHour, nowIso }: { perHour: number[]; nowIso: string }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real pixel width so axis text stays at its type size.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const Hh = 150;
  const pad = { l: 28, r: 4, t: 8, b: 20 };
  const max = Math.ceil(Math.max(...perHour) / 20) * 20;
  const avg = perHour.reduce((a, b) => a + b, 0) / perHour.length;
  const bw = (W - pad.l - pad.r) / perHour.length;
  const y = (v: number) => pad.t + (Hh - pad.t - pad.b) * (1 - v / max);
  const endHour = new Date(nowIso).getUTCHours();
  const hourOf = (i: number) => (endHour - (perHour.length - 1 - i) + 24) % 24;
  return (
    <div className="relative w-full overflow-hidden" ref={box}>
      <svg width={W} height={Hh} viewBox={`0 0 ${W} ${Hh}`} className="block" role="img" aria-label={`Items done per hour, last 24 hours, average ${Math.round(avg)}`} onMouseLeave={() => setHover(null)}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--st-line)" strokeDasharray={t === 0 ? undefined : "2 3"} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-current font-mono text-[10px] text-ink/45">
              {t}
            </text>
          </g>
        ))}
        {perHour.map((v, i) => {
          const x = pad.l + i * bw;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={pad.t} width={bw} height={Hh - pad.t - pad.b} fill="transparent" />
              <rect x={x + bw * 0.18} y={y(v)} width={bw * 0.64} height={y(0) - y(v)} fill="var(--st-c1)" opacity={hover === null || hover === i ? 1 : 0.45} />
              {i % (W < 500 ? 8 : 4) === 0 && (
                <text x={x + bw / 2} y={Hh - 6} textAnchor="middle" className="fill-current font-mono text-[10px] text-ink/45">
                  {String(hourOf(i)).padStart(2, "0")}:00
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(avg)} y2={y(avg)} stroke="rgb(var(--st-fg-rgb))" strokeOpacity={0.7} strokeDasharray="4 3" />
        <text x={pad.l + 4} y={y(avg) - 4} textAnchor="start" className="fill-current font-mono text-[10px] text-ink/75">
          avg {Math.round(avg)}
        </text>
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 border border-line bg-raised px-2 py-1 font-mono text-2xs" style={{ left: `calc(${((pad.l + hover * bw) / W) * 100}% - 20px)` }}>
          {String(hourOf(hover)).padStart(2, "0")}:00 UTC · {perHour[hover]} done
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const W = 72;
  const H = 18;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - min) / (max - min || 1)) * (H - 4)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className={className} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
