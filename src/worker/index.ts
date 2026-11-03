// `craft-auto worker serve`: runs build tasks of the coordinator in containers.
import { mkdirSync, readFileSync } from "node:fs";
import { detectCapabilities, loadWorkerConfig, readKey } from "./config.ts";
import { WorkerApi } from "./client.ts";
import { serve } from "./serve.ts";
import { connect } from "../db.ts";
import { requestUpdate, statusLines } from "../build/worker-update.ts";

export { rustPlan, hasCargoLock } from "./rust.ts";
export type { Capabilities, TaskStep, ClaimedTask } from "./types.ts";

const USAGE = `usage: craft-auto worker serve [--config FILE]   (default: $CRAFT_AUTO_WORKER_CONFIG)
       craft-auto worker update-code --sha SHA --ssh USER@HOST --key FILE --git-dir BARE_REPO
       craft-auto worker status`;

/** Updates the sandbox worker now, or records the update when its tasks are still running. */
async function updateCode(args: string[]): Promise<void> {
  const opt = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) opt.set(args[i]!.replace(/^--/, ""), args[i + 1] ?? "");
  const [sha, ssh, keyFile, gitDir] = ["sha", "ssh", "key", "git-dir"].map((k) => opt.get(k));
  if (!sha || !ssh || !keyFile || !gitDir) {
    console.error(USAGE);
    process.exit(2);
  }
  const db = connect();
  try {
    const r = await requestUpdate(db, { sha, ssh, keyFile, gitDir });
    if (r.result === "current") console.log("-> Sandbox worker code is current.");
    else if (r.result === "updated") console.log("-> Sandbox worker code updated.");
    else console.log(`-> Sandbox worker busy (${r.busy} tasks); its update waits until they finish`);
  } catch (e) {
    console.error(`!! sandbox worker update failed: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

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
    summary: "build worker: serve [--config FILE] | update-code | status",
    run: async (args: string[]) => {
      if (args[0] === "update-code") return updateCode(args.slice(1));
      if (args[0] === "status") {
        const db = connect();
        for (const l of statusLines(db)) console.log(l);
        db.close();
        return;
      }
      if (args[0] !== "serve") {
        console.error(USAGE);
        process.exit(2);
      }
      await workerServe(args.slice(1));
    },
  },
};
