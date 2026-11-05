// Pipeline steps of a resolution card (review again, fix-up, fix-up then merge) and the pre-approved merge they can start.
import type { DatabaseSync } from "node:sqlite";
import type { Step } from "../conversations/cards.ts";

export type PipelineStep = Extract<Step, { kind: "review" | "fixup" }>;

/** Queues a card's pipeline step for the PR; `label` is the done line the card shows. Throws when the step cannot start. */
export async function runPipelineStep(db: DatabaseSync, o: { repo: string; number: number; step: PipelineStep; by: string }): Promise<{ label: string }> {
  void db; void o;
  throw new Error("pipeline steps are not built yet");
}
