// The Next page: per pipeline step, the items its next job will take, in the autopilot's own order (laneItems, stored by each planner pass), whether the step can run now, and the items waiting on something outside.
import type { DatabaseSync } from "node:sqlite";
import type { NextItem, NextPage, NextStep, NextWaiting } from "../../../web/src/api/types.ts";
import { LANES, laneGate, stageStatus, storedLaneItems } from "../../runner/autopilot.ts";
import { lanesInOrder, STAGES } from "../../stages/registry.ts";
import { loadSteps } from "../../runner/steps.ts";
import type { Req } from "../types.ts";
import { shownLookup } from "./shown.ts";
import { visibleRepos } from "./visible.ts";

const WAITING_LIMIT = 500;

type PlanRow = { repo: string; number: number; wait: string | null; view: string };
const nextText = (view: string): string | null => { try { return (JSON.parse(view) as { next?: string }).next ?? null; } catch { return null; } };

export async function nextPage(db: DatabaseSync, visibleNames: string[], opts: { nowMs?: number } = {}): Promise<NextPage> {
  const visible = new Set(visibleNames), ms = opts.nowMs ?? Date.now();
  const stored = storedLaneItems(db);
  const shown = shownLookup(db);
  const stepDefs = await loadSteps();
  const status = stageStatus(db);
  const plan = db.prepare("SELECT repo, number, wait, view FROM item_plans WHERE repo = ? AND number = ?");
  const why = (repo: string, number: number, action: string): string => nextText((plan.get(repo, number) as PlanRow | undefined)?.view ?? "{}") ?? action;
  const stageOf = new Map(lanesInOrder().map((l) => [l.name, STAGES.find((s) => s.id === l.stage)!.title]));
  const steps: NextStep[] = [];
  for (const lane of LANES) {
    const kept = stored[lane.name]?.items ?? [];
    const items: NextItem[] = kept.filter((i) => visible.has(i.repo)).map((i) => ({ ...i, ...shown(i.repo, i.number), why: why(i.repo, i.number, i.action) }));
    const total = (stored[lane.name]?.total ?? 0) - (kept.length - items.length);
    const gate = laneGate(db, lane, ms);
    const open = items.filter((i) => !i.blocked);
    // Every item blocked by a repo approval: the step cannot do its work although it could start.
    const refused = !open.length && items.length ? items[0]!.blocked : null;
    steps.push({
      lane: lane.name, title: stepDefs.get(lane.steps?.[0] ?? lane.name)?.title ?? lane.name, stage: stageOf.get(lane.name) ?? "", steps: lane.steps ?? [],
      canRun: gate.canRun && !refused, kind: refused && gate.canRun ? "approval" : gate.kind, why: gate.why ?? refused,
      note: (lane.steps ?? []).map((s) => status[s]).find(Boolean) ?? null, total, items,
    });
  }
  const rows = db.prepare("SELECT repo, number, wait, view FROM item_plans WHERE wait IS NOT NULL ORDER BY repo, number").all() as PlanRow[];
  const scoped = rows.filter((r) => visible.has(r.repo) && (JSON.parse(r.view) as { scope?: true }).scope);
  const waiting: NextWaiting[] = scoped.slice(0, WAITING_LIMIT).map((r) => ({ repo: r.repo, number: r.number, ...shown(r.repo, r.number), wait: r.wait!, why: nextText(r.view) }));
  return { steps, waiting, waitingTotal: scoped.length };
}

export async function next(db: DatabaseSync, req: Req): Promise<NextPage> {
  return nextPage(db, await visibleRepos(db, req));
}
