// Work score of an open item: pure functions, no I/O. It decides what the pipeline works on first.
//
//   score = priority + type points + size points + security points   (never below 0)
//
// The priority score (src/priority/score.ts, 0-100) carries most of the weight. The other parts move an item
// by at most a few tens of points, so a critical item stays ahead of a low one unless the low one is cheaper
// and of a better type. Smaller items score higher at equal priority because they are cheaper to finish.
// All weights are in RANK_WEIGHTS.

export const SIZES = ["S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

export const RANK_WEIGHTS = {
  /** Priority score used when the item has none: the middle of the normal band. */
  defaultPriority: 37,
  /** Points by settled type label. */
  type: { bugfix: 20, performance: 14, infra: 10, "missing feature": 8, "small extra": 2, "plugin candidate": 0 } as Record<string, number>,
  /** Points when the item has no settled type label. */
  unlabelledType: 5,
  /** Points by size. */
  size: { S: 12, M: 6, L: 0, XL: -10 } as Record<Size, number>,
  /** Size used when none is known: an issue before Fix triage, a PR without line counts. */
  defaultSize: "M" as Size,
  /** Added when a classifier raised the security flag (on top of the little it adds to the priority's reach). */
  security: 15,
  /** Changed lines up to which a PR is S, M and L; above the last it is XL. */
  sizeLines: [50, 300, 1000] as const,
};

export type RankInput = {
  /** Priority score, null when the item has not been rated. */
  priority: number | null;
  /** Settled type label, null when unsettled. */
  label: string | null;
  security: boolean;
  /** Size and where it came from. */
  size: Size | null;
  sizeSource: "lines" | "triage" | "default";
};

export type RankPart = { value: string | number | boolean | null; points: number };
export type RankBreakdown = { priority: RankPart; type: RankPart; size: RankPart & { source: RankInput["sizeSource"] }; security: RankPart };

export const sizeOfLines = (lines: number): Size => {
  const [s, m, l] = RANK_WEIGHTS.sizeLines;
  return lines <= s ? "S" : lines <= m ? "M" : lines <= l ? "L" : "XL";
};

export const isSize = (v: unknown): v is Size => typeof v === "string" && (SIZES as readonly string[]).includes(v);

export function rankOf(i: RankInput): { score: number; breakdown: RankBreakdown } {
  const w = RANK_WEIGHTS;
  const priority = i.priority ?? w.defaultPriority;
  const typePoints = i.label === null ? w.unlabelledType : (w.type[i.label] ?? w.unlabelledType);
  const size = i.size ?? w.defaultSize;
  const sizePoints = w.size[size];
  const securityPoints = i.security ? w.security : 0;
  const breakdown: RankBreakdown = {
    priority: { value: i.priority, points: priority },
    type: { value: i.label, points: typePoints },
    size: { value: size, points: sizePoints, source: i.size === null ? "default" : i.sizeSource },
    security: { value: i.security, points: securityPoints },
  };
  return { score: Math.max(0, Math.round(priority + typePoints + sizePoints + securityPoints)), breakdown };
}
