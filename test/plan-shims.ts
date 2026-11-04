// Where each PR stands with the fix-up, conflict and CI fix steps, read from the facts through the same functions decide() uses.
import type { DatabaseSync } from "node:sqlite";
import { cifixBucket, decidePr, fixupOf } from "../src/core/decide.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { conflictTries } from "../src/fixup/conflict-state.ts";

export function classifyFixups(db: DatabaseSync, repo: string): { bucket: string; done: boolean; c: { attempt: number; source?: string } }[] {
  const out: { bucket: string; done: boolean; c: { attempt: number; source?: string } }[] = [];
  for (const f of loadPrFacts(db, { repo })) {
    const x = fixupOf(f);
    if (x) out.push({ ...x, c: { attempt: f.fixup!.attempts + 1 } });
    else if (f.premerge && decidePr(f).actions.some((a) => a.kind === "fixup" && a.params?.source === "premerge")) {
      out.push({ bucket: !f.pushable ? "cannot-push" : f.repoFacts.pushApproved ? "fix" : "unapproved", done: !f.pushable || !f.repoFacts.pushApproved, c: { attempt: 1, source: "premerge" } });
    }
  }
  return out;
}

export function classifyConflicts(db: DatabaseSync, repo: string): { bucket: string; c: { attempt: number; pushable: boolean } }[] {
  return loadPrFacts(db, { repo }).filter((f) => {
    const r = f.review;
    return f.conflict?.baseOk && f.mergeable === "CONFLICTING" && r && (r.verdict === "take" || r.verdict === "take-fix") && r.head === f.head && !r.stale
      && !f.draft && f.inScope && !f.heldBacklog && !f.heldDuplicate && !f.mergeHeld && !f.inActiveBatch;
  }).map((f) => ({ bucket: f.conflict!.bucket, c: { attempt: conflictTries(db, repo, f.number, f.head!) + 1, pushable: f.pushable } }));
}

export function classifyCifix(db: DatabaseSync, repo: string): { bucket: string }[] {
  return loadPrFacts(db, { repo }).flatMap((f) => { const b = cifixBucket(f); return b ? [{ bucket: b }] : []; });
}
