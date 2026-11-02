// Fake work queue: open items in score order. The points mirror the server's first-guess weights.
import type { TypeLabel, WorkBreakdown, WorkFilter, WorkList, WorkRow } from "../types";
import { REPOS, rng, titleFor } from "./fixtures";

const TYPE_POINTS: Record<TypeLabel, number> = { bugfix: 20, performance: 14, infra: 10, "missing feature": 8, "small extra": 2, "plugin candidate": 0 };
const SIZE_POINTS = { S: 12, M: 6, L: 0, XL: -10 } as const;
const LABELS = Object.keys(TYPE_POINTS) as TypeLabel[];
const SIZES = ["S", "M", "L", "XL"] as const;
const NEXT_PR = ["Review", "Verify", "Verify: running", "Merge queue", "Fix-up", "Needs a person"];
const NEXT_ISSUE = ["Fix", "Fix: in progress", "Fix: pull request opened", "Decide", "Needs a person", "Triage by a person"];

const ROWS: WorkRow[] = (() => {
  const r = rng(808);
  const out: WorkRow[] = [];
  for (let k = 0; k < 60; k++) {
    const kind = k % 3 === 0 ? "issue" : "pr";
    const label = LABELS[Math.floor(r() * LABELS.length)]!;
    const size = SIZES[Math.floor(r() * 4)]!;
    const priority = k % 7 === 0 ? null : Math.round(r() * 100);
    const security = k % 11 === 0;
    const breakdown: WorkBreakdown = {
      priority: { value: priority, points: priority ?? 37 },
      type: { value: label, points: TYPE_POINTS[label] },
      size: { value: size, points: SIZE_POINTS[size], source: kind === "issue" ? (k % 2 ? "triage" : "default") : "lines" },
      security: { value: security, points: security ? 15 : 0 },
    };
    const score = Math.max(0, breakdown.priority.points + breakdown.type.points + breakdown.size.points + breakdown.security.points);
    const next = kind === "pr" ? NEXT_PR : NEXT_ISSUE;
    const repo = REPOS[k % REPOS.length]!;
    const number = 100 + Math.floor(r() * 3000);
    out.push({ repo, number, kind, title: titleFor(repo, number), score, breakdown, label, next: next[k % next.length]! });
  }
  return out.sort((a, b) => b.score - a.score);
})();

export function workList(f: WorkFilter): WorkList {
  const match = ROWS.filter((x) => (!f.repo || x.repo === f.repo) && (!f.kind || x.kind === f.kind));
  const offset = f.offset ?? 0, limit = f.limit ?? 100;
  const rows = match.slice(offset, offset + limit);
  return { rows, total: match.length, next: offset + rows.length < match.length ? offset + rows.length : null };
}
