let now = () => Date.now();
/** The mock's fixtures are dated around a frozen moment, so screenshots stay stable; it sets the clock to match. */
export function setClock(fn: () => number) {
  now = fn;
}

export function ago(isoTime: string, short = true): string {
  const s = Math.max(0, (now() - Date.parse(isoTime)) / 1000);
  const [n, u] = s < 60 ? [s, "s"] : s < 3600 ? [s / 60, "m"] : s < 86400 ? [s / 3600, "h"] : [s / 86400, "d"];
  const v = Math.floor(n);
  if (short) return `${v}${u}`;
  const word = { s: "second", m: "minute", h: "hour", d: "day" }[u]!;
  return `${v} ${word}${v === 1 ? "" : "s"} ago`;
}

export const num = (n: number) => n.toLocaleString("en");
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

export const ageDays = (isoTime: string) => (now() - Date.parse(isoTime)) / 86400_000;

/** The current time in ms on the app's clock (frozen in the mock). */
export const nowMs = () => now();

/** "2 h 40 m" / "35 m" / "3 d 4 h" for a span in ms. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1 m";
  if (m < 60) return `${m} m`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} m`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
