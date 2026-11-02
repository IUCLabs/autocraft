// Inline SVG charts. Every mark carries a <title> so hover shows its value;
// the numbers are also printed beside the bars, so nothing relies on hover.
import { esc, num } from "./layout.ts";

export type Bar = { label: string; value: number; href?: string; cls?: string };

// Horizontal bars with the label above each bar and the value at its end.
// Fits 360 px: the SVG scales to the container width.
export function hbars(bars: Bar[], title: string): string {
  const W = 600, rowH = 40, barH = 14;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const h = bars.length * rowH + 4;
  const rows = bars.map((b, i) => {
    const y = i * rowH;
    const w = Math.max(b.value > 0 ? 3 : 0, (b.value / max) * (W - 90));
    const label = `<text x="0" y="${y + 14}">${esc(b.label)}</text>`;
    const bar = `<rect class="bar${b.cls ? ` ${b.cls}` : ""}" x="0" y="${y + 20}" width="${w.toFixed(1)}" height="${barH}" rx="3"><title>${esc(b.label)}: ${num(b.value)}</title></rect>`;
    const val = `<text x="${(w + 6).toFixed(1)}" y="${y + 32}">${num(b.value)}</text>`;
    const g = label + bar + val;
    return b.href ? `<a href="${esc(b.href)}">${g}</a>` : g;
  }).join("");
  return `<svg class=chart viewBox="0 0 ${W} ${h}" role=img aria-label="${esc(title)}">${rows}</svg>`;
}

// One stacked bar split into parts, with a legend; used for done-by-whom.
export function stacked(parts: { label: string; value: number; cls: string }[], title: string): string {
  const W = 600, H = 22;
  const total = parts.reduce((s, x) => s + x.value, 0);
  let x = 0;
  const rects = total === 0 ? `<rect x="0" y="0" width="${W}" height="${H}" rx="3" class="grid" fill="none"/>` : parts.map((p) => {
    const w = (p.value / total) * W;
    const r = w > 0 ? `<rect class="bar ${p.cls}" x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 2).toFixed(1)}" height="${H}" rx="3"><title>${esc(p.label)}: ${num(p.value)}</title></rect>` : "";
    x += w;
    return r;
  }).join("");
  const legend = parts.map((p) => `<span><i class="sw-${p.cls}"></i>${esc(p.label)} ${num(p.value)}</span>`).join("");
  return `<svg class=chart viewBox="0 0 ${W} ${H}" role=img aria-label="${esc(title)}">${rects}</svg><div class=legend>${legend}</div>`;
}

// A single-series line chart with a y axis from zero and first/last day labels.
export function line(days: string[], values: number[], title: string): string {
  const W = 600, H = 180, L = 44, B = 22, T = 8;
  const max = Math.max(1, ...values);
  const xs = (i: number) => L + (days.length <= 1 ? 0 : (i / (days.length - 1)) * (W - L - 8));
  const ys = (v: number) => T + (1 - v / max) * (H - T - B);
  const pts = values.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const grid = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line class=grid x1="${L}" x2="${W - 8}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"/><text x="${L - 6}" y="${(ys(v) + 4).toFixed(1)}" text-anchor="end">${num(v)}</text>`;
  }).join("");
  // wide invisible hit targets per day carry the hover value
  const step = days.length <= 1 ? W : (W - L - 8) / (days.length - 1);
  const hits = values.map((v, i) => `<rect x="${(xs(i) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${H - T - B}" fill="transparent"><title>${esc(days[i])}: ${num(v)} open</title></rect>`).join("");
  const xl = days.length ? `<text x="${L}" y="${H - 6}">${esc(days[0])}</text><text x="${W - 8}" y="${H - 6}" text-anchor="end">${esc(days[days.length - 1])}</text>` : "";
  return `<svg class=chart viewBox="0 0 ${W} ${H}" role=img aria-label="${esc(title)}">${grid}<polyline class=line points="${pts}"/>${xl}${hits}</svg>`;
}

export function sparkline(values: number[], label: string): string {
  const W = 90, H = 24;
  if (!values.length) return "";
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => `${(values.length <= 1 ? 0 : (i / (values.length - 1)) * W).toFixed(1)},${(2 + (1 - (v - min) / span) * (H - 4)).toFixed(1)}`).join(" ");
  return `<svg class=chart width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role=img aria-label="${esc(label)}"><polyline class=line points="${pts}"/><title>${esc(label)}</title></svg>`;
}
