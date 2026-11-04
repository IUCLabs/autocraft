// The assign step: carries out the `assign` and `unassign` actions of the Plans (src/core/assignment.ts holds the rule). Each item's
// assignees are read from GitHub just before the write, so an assignment made by a person meanwhile is never touched.
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { guardRepo } from "../core/guard.ts";
import { PIPELINE_LOGIN_KEY } from "../core/rules.ts";
import { planned } from "../core/select.ts";
import { plannedItems } from "../core/select-items.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { By } from "../core/gates.ts";
import { claimItem, issueInfo, pullRequestInfo, releaseItem } from "../github/claim.ts";
import type { Writer } from "../github/write.ts";
import { viewerOf } from "../merge/index.ts";
import { Client, type Querier } from "../mirror.ts";

export const ACTOR = "assign";
const oneLine = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

export type AssignResult = { assigned: string[]; unassigned: string[]; failed: string[] };

export type AssignParams = { repo: string; by: By; runId: string; log?: (line: string) => void; querier?: Querier; plans?: PlanSet };

/** Assigns the items the Plans say AutoCraft is working and unassigns the ones it gave up or that wait on a person, in one repo. */
export async function runAssign(db: DatabaseSync, p: AssignParams): Promise<AssignResult> {
  const log = p.log ?? (() => {});
  const q = p.querier ?? new Client(500);
  const out: AssignResult = { assigned: [], unassigned: [], failed: [] };
  const opts = { repo: p.repo, ...(p.plans ? { plans: p.plans } : {}) };
  const due = [
    ...(["assign", "unassign"] as const).flatMap((kind) => [
      ...planned(db, kind, opts).map((x) => ({ kind, pr: true, number: x.facts.number })),
      ...plannedItems(db, kind, opts).filter((x) => x.facts.kind === "issue").map((x) => ({ kind, pr: false, number: x.facts.number })),
    ]),
  ];
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
      if (!info) continue;
      if (d.kind === "assign") {
        if (await claimItem(w, g, q, p.repo, d.number, info, me, { run: p.runId })) { out.assigned.push(ref); log(`  ${ref}: assigned to ${me.login}`); }
      } else if (await releaseItem(w, g, q, p.repo, d.number, info, me, { run: p.runId })) { out.unassigned.push(ref); log(`  ${ref}: unassigned from ${me.login}`); }
    } catch (e) {
      out.failed.push(ref);
      log(`  ${ref}: could not ${d.kind}: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  return out;
}
