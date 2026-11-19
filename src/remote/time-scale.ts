// Test-only time scale for the user-local mode: AUTOCRAFT_REMOTE_TIME_SCALE (0.01 to 1, unset = 1) multiplies every window
// of the mode (leases, heartbeats, cool-offs, polls) so the load rig runs in minutes. The helper reads the same variable.
// The protocol constants (protocol.ts) keep their production values; the scale applies where they are used.

/** The scale in `raw`; throws on anything outside 0.01 to 1. */
export function parseTimeScale(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.01 || n > 1) throw new Error(`AUTOCRAFT_REMOTE_TIME_SCALE must be a number from 0.01 to 1 (test only), got "${raw}"`);
  return n;
}

export const TIME_SCALE = parseTimeScale(process.env.AUTOCRAFT_REMOTE_TIME_SCALE);

/** `ms` multiplied by the scale (whole milliseconds, at least 1). */
export const scaled = (ms: number): number => (TIME_SCALE === 1 ? ms : Math.max(1, Math.round(ms * TIME_SCALE)));
/** `s` seconds multiplied by the scale (fractions allowed). */
export const scaledS = (s: number): number => s * TIME_SCALE;
