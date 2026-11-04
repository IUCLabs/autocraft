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
  p.actions.map((a) => (a.params && typeof a.params.bucket === "string" ? `${a.kind}:${a.params.bucket}` : a.kind)).sort();
const rows: string[] = [];
for (const { f, p } of plans) {
  const due = tokens(p);
  for (const t of due) counts.set(t, (counts.get(t) ?? 0) + 1);
  states.set(p.state, (states.get(p.state) ?? 0) + 1);
  const queue = isQueueState(p.state) ? { state: p.state, path: p.path, eligible: p.eligible, reasons: [...p.reasons].sort() } : null;
  rows.push(JSON.stringify({ ref: `${p.repo}#${p.number}`, head: queue ? f.review!.head : f.head, queue, due,
    // The old side exports the queue's own note; the conflict note is a separate field there.
    note: p.note?.startsWith("conflict:") ? null : p.note }));
}
writeFileSync(out, rows.map((r) => `${r}\n`).join(""));
const show = (m: Map<string, number>) => [...m].sort().map(([k, v]) => `  ${k}: ${v}`).join("\n");
console.error(`${rows.length} PRs; load ${((t1 - t0) / 1000).toFixed(1)}s, decide ${((t2 - t1) / 1000).toFixed(2)}s\ndue tokens:\n${show(counts)}\nstates:\n${show(states)}`);
db.close();
