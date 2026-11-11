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

/**
 * The networked fetch runs with the image's own default toolchain and no repository cargo config, so
 * neither a toolchain file, a config wrapper nor a credential helper from the PR tree can start a
 * program with network access. The source overlay is discarded after the step, so deleting the config files is local to it.
 */
export const FETCH_SCRIPT = [
  "cd /tmp",
  "tc=$(/usr/local/cargo/bin/rustup show active-toolchain 2>/dev/null | cut -d' ' -f1)",
  "cd /src",
  "rm -f .cargo/config .cargo/config.toml",
  'if [ -n "$tc" ]; then export RUSTUP_TOOLCHAIN="$tc"; fi',
  "export RUSTC=/usr/local/cargo/bin/rustc RUSTC_WRAPPER= RUSTC_WORKSPACE_WRAPPER= CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS=cargo:token",
  "exec /usr/local/cargo/bin/cargo fetch --locked",
].join("\n");

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
    { name: "fetch deps", cmd: ["sh", "-c", FETCH_SCRIPT], network: "fetch", timeoutSec: o.fetchTimeoutSec ?? 900 },
    { name: "build", cmd: ["cargo", "build", "--offline", "--locked", "--all-targets", ...extra], network: "none", timeoutSec: o.buildTimeoutSec ?? 3600 },
  ];
  if (o.test ?? true) {
    steps.push({ name: "test", cmd: ["cargo", "test", "--offline", "--locked", ...extra], network: "none", timeoutSec: o.testTimeoutSec ?? 3600, artifacts: o.testArtifacts });
  }
  return steps;
}
