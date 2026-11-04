// The unassign step: carries out the `unassign` actions of the Plans (src/core/assignment.ts holds the rule). Each item's assignees
// are read from GitHub just before the write, so an assignment made by a person meanwhile is never touched.
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { guardRepo } from "../core/guard.ts";
import { PIPELINE_LOGIN_KEY } from "../core/rules.ts";
import { planned } from "../core/select.ts";
import { plannedItems } from "../core/select-items.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { By } from "../core/gates.ts";
import { issueInfo, pullRequestInfo, releaseItem } from "../github/claim.ts";
import type { Writer } from "../github/write.ts";
import { viewerOf } from "../merge/index.ts";
import { Client, type Querier } from "../mirror.ts";

export const ACTOR = "unassign";
const oneLine = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

export type UnassignResult = { unassigned: string[]; failed: string[]; due: number };

export type UnassignParams = { repo: string; by: By; runId: string; log?: (line: string) => void; querier?: Querier; plans?: PlanSet };

/** Unassigns the pipeline's account from the items of one repo that the Plans say are off the path to merge. One item failing does not stop the others. */
export async function runUnassign(db: DatabaseSync, p: UnassignParams): Promise<UnassignResult> {
  const log = p.log ?? (() => {});
  const q = p.querier ?? new Client(500);
  const out: UnassignResult = { unassigned: [], failed: [], due: 0 };
  const opts = { repo: p.repo, ...(p.plans ? { plans: p.plans } : {}) };
  const due = [
    ...planned(db, "unassign", opts).map((x) => ({ pr: true, number: x.facts.number })),
    ...plannedItems(db, "unassign", opts).filter((x) => x.facts.kind === "issue").map((x) => ({ pr: false, number: x.facts.number })),
  ];
  out.due = due.length;
  if (!due.length) return out;
  const g = guardRepo(db, p.repo, null, p.by);
  if ("refused" in g) { log(`${p.repo}: ${g.refused}`); return out; }
  const w: Writer = { db, login: ACTOR };
  const me = await viewerOf(q);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(PIPELINE_LOGIN_KEY, me.login);
  for (const d of due) {
    const ref = `${p.repo}#${d.number}`;
    try {
      const info = await (d.pr ? pullRequestInfo(q, ORG, p.repo, d.number) : issueInfo(q, ORG, p.repo, d.number));
      if (info && await releaseItem(w, g, q, p.repo, d.number, info, me, { run: p.runId })) { out.unassigned.push(ref); log(`  ${ref}: unassigned from ${me.login}`); }
    } catch (e) {
      out.failed.push(ref);
      log(`  ${ref}: could not unassign: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  return out;
}
