// Fake steps for the autopilot planner tests (AUTOCRAFT_EXTRA_STEPS). Never run.
import type { StepDef } from "../src/runner/steps.ts";

const base = { description: "Test step.", stage: 2, requires: "operator" as const, group: "test-a", run: async () => "ok" };

export const steps: StepDef[] = [
  { ...base, name: "test-limited", title: "Limited", params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 100, default: 50 }] },
  { ...base, name: "test-plain", title: "Plain", params: [] },
];
