// New side of the behaviour comparison: one JSONL line per PR with the Plan's queue state and due tokens.
// Usage: node scripts/plans-export.ts <db-file> <out.jsonl>
// Works on a copy of the DB (connect() runs migrations, which write).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { connect } from "../src/db.ts";
import { trackedNames } from "../src/repos.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { decidePr } from "../src/core/decide.ts";
import { isQueueState } from "../src/core/plan.ts";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: plans-export.ts <db-file> <out.jsonl>");
  process.exit(2);
}
const work = join(homedir(), ".cache/autocraft-compare/work");
mkdirSync(work, { recursive: true });
const copy = join(work, `${basename(src)}.${Date.now()}`);
for (const ext of ["", "-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext);
const db = connect(copy);

const t0 = Date.now();
const tracked = new Set(trackedNames(db));
const facts = loadPrFacts(db).filter((f) => tracked.has(f.repo));
const t1 = Date.now();
const plans = facts.map((f) => ({ f, p: decidePr(f) }));
const t2 = Date.now();

const counts = new Map<string, number>();
const states = new Map<string, number>();
const tokens = (p: ReturnType<typeof decidePr>): string[] =>
  p.actions.map((a) => {
    const bucket = typeof a.params?.bucket === "string" ? a.params.bucket : null;
    if (a.kind === "fixup") return a.params?.source === "premerge" ? "fixup:premerge" : a.params?.source === "carry" ? `fixup:carry-${bucket}` : `fixup:${bucket}`;
    return bucket ? `${a.kind}:${bucket}` : a.kind;
  }).sort();
const rows: string[] = [];
for (const { f, p } of plans) {
  const due = tokens(p);
  // Closed PRs outside the queue are listed only when something is due (the old export lists them only then).
  if (p.state === "closed" && !due.length) continue;
  for (const t of due) counts.set(t, (counts.get(t) ?? 0) + 1);
  states.set(p.state, (states.get(p.state) ?? 0) + 1);
  const queue = isQueueState(p.state) ? { state: p.state, path: p.path, eligible: p.eligible, reasons: [...p.reasons].sort() } : null;
  rows.push(JSON.stringify({ ref: `${p.repo}#${p.number}`, head: queue ? f.review!.head : f.head, queue, due,
    note: p.note }));
}
writeFileSync(out, rows.map((r) => `${r}\n`).join(""));
const show = (m: Map<string, number>) => [...m].sort().map(([k, v]) => `  ${k}: ${v}`).join("\n");
console.error(`${rows.length} PRs; load ${((t1 - t0) / 1000).toFixed(1)}s, decide ${((t2 - t1) / 1000).toFixed(2)}s\ndue tokens:\n${show(counts)}\nstates:\n${show(states)}`);
db.close();
