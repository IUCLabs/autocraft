// `craft-auto worker serve`: runs build tasks of the coordinator in containers.
import { mkdirSync, readFileSync } from "node:fs";
import { detectCapabilities, loadWorkerConfig, readKey } from "./config.ts";
import { WorkerApi } from "./client.ts";
import { serve } from "./serve.ts";

export { rustPlan, hasCargoLock } from "./rust.ts";
export type { Capabilities, TaskStep, ClaimedTask } from "./types.ts";

const USAGE = "usage: craft-auto worker serve [--config FILE]   (default: $CRAFT_AUTO_WORKER_CONFIG)";

async function workerServe(args: string[]): Promise<void> {
  const i = args.indexOf("--config");
  const path = (i >= 0 ? args[i + 1] : undefined) ?? process.env.CRAFT_AUTO_WORKER_CONFIG;
  if (!path) {
    console.error(USAGE);
    process.exit(2);
  }
  const cfg = loadWorkerConfig(path);
  mkdirSync(cfg.workDir, { recursive: true, mode: 0o700 });
  const key = readKey(cfg);
  const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const ac = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => ac.abort());
  await serve(
    {
      cfg,
      api: new WorkerApi(cfg.coordinatorUrl, key),
      version,
      capabilities: () => detectCapabilities(cfg),
      log: (l) => console.log(`${new Date().toISOString()} ${l}`),
    },
    ac.signal,
  );
}

export const commands = {
  worker: {
    summary: "build worker: serve [--config FILE]",
    run: async (args: string[]) => {
      if (args[0] !== "serve") {
        console.error(USAGE);
        process.exit(2);
      }
      await workerServe(args.slice(1));
    },
  },
};
