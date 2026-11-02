import type { PriorityInfo } from "../api/types";
import { Badge, type Tone } from "./Badge";

const TONE: Record<PriorityInfo["impact"], Tone> = { critical: "bad", high: "warn", normal: "neutral", low: "neutral" };

/** Impact class and score of an item; nothing before the item was rated. */
export function PriorityBadge({ p }: { p: PriorityInfo | null | undefined }) {
  if (!p) return null;
  return (
    <span title={p.reason ?? `Rated by ${p.model}`}>
      <Badge tone={TONE[p.impact]}>
        {p.impact} · {p.score}
      </Badge>
    </span>
  );
}
