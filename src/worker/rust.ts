import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskStep } from "./types.ts";

export type RustPlanOptions = {
  /** Cargo arguments shared by build and test, e.g. ["--workspace"] or ["-p", "app"]. */
  cargoArgs?: string[];
  test?: boolean;
  fetchTimeoutSec?: number;
  buildTimeoutSec?: number;
  testTimeoutSec?: number;
  /** Globs under /out to return from the test step. */
  testArtifacts?: string[];
};

/** Whether the checkout can use a locked plan (`--locked` needs Cargo.lock). */
export function hasCargoLock(checkoutDir: string): boolean {
  return existsSync(join(checkoutDir, "Cargo.lock"));
}

/**
 * Steps for a Rust repo: `fetch deps` is the only step with network; build and
 * test run offline on the crates it downloaded. The source is mounted
 * read-only, so the lock file must already be right (`--locked`).
 * `cargo fetch` runs no build scripts or proc macros. The crate cache and its
 * poisoning rules are described in cache.ts.
 */
export function rustPlan(o: RustPlanOptions = {}): TaskStep[] {
  const extra = o.cargoArgs ?? [];
  const steps: TaskStep[] = [
    { name: "fetch deps", cmd: ["cargo", "fetch", "--locked"], network: "fetch", timeoutSec: o.fetchTimeoutSec ?? 900 },
    { name: "build", cmd: ["cargo", "build", "--offline", "--locked", "--all-targets", ...extra], network: "none", timeoutSec: o.buildTimeoutSec ?? 3600 },
  ];
  if (o.test ?? true) {
    steps.push({ name: "test", cmd: ["cargo", "test", "--offline", "--locked", ...extra], network: "none", timeoutSec: o.testTimeoutSec ?? 3600, artifacts: o.testArtifacts });
  }
  return steps;
}
