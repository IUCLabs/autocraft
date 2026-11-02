// Groups review inputs into model calls: PRs that change the same files go
// together, then PRs of the same area, within a cap on PRs and diff text per call.
export type Batchable = { ref: string; files: string[]; area: string; diffChars: number };

export type Caps = {
  /** Most PRs in one call. */
  perCall: number;
  /** Most diff characters in one call; a PR above this alone gets a call of its own. */
  charsPerCall: number;
};

export const DEFAULT_CAPS: Caps = { perCall: 15, charsPerCall: 120_000 };

/** Connected groups of PRs that share at least one file. */
export function clusters<T extends Batchable>(prs: T[]): T[][] {
  const parent = prs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  prs.forEach((p, i) => {
    for (const f of p.files) {
      const o = owner.get(f);
      if (o === undefined) owner.set(f, i);
      else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, T[]>();
  prs.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  });
  return [...groups.values()];
}

/**
 * Packs PRs into batches. Clusters stay whole when they fit; clusters are
 * ordered by area so neighbouring batches cover related code.
 */
export function makeBatches<T extends Batchable>(prs: T[], caps: Caps = DEFAULT_CAPS): T[][] {
  const groups = clusters(prs).sort((a, b) => a[0]!.area.localeCompare(b[0]!.area) || b.length - a.length);
  const batches: T[][] = [];
  let cur: T[] = [], chars = 0;
  const flush = () => { if (cur.length) batches.push(cur); cur = []; chars = 0; };
  const put = (p: T) => {
    if (cur.length && (cur.length >= caps.perCall || chars + p.diffChars > caps.charsPerCall)) flush();
    cur.push(p);
    chars += p.diffChars;
  };
  for (const g of groups) {
    const size = g.reduce((s, p) => s + p.diffChars, 0);
    // A cluster that fits in an empty batch but not in this one starts a new batch.
    if (g.length <= caps.perCall && size <= caps.charsPerCall && (cur.length + g.length > caps.perCall || chars + size > caps.charsPerCall)) flush();
    for (const p of g) put(p);
  }
  flush();
  return batches;
}
