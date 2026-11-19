import { sweepRunningCards } from "../conversations/act.ts";
import { connect } from "../db.ts";
import { scopeToTracked } from "../repos.ts";
import { ConfigError, loadConfig } from "./server/config.ts";
import { startServer } from "./server/index.ts";

/** How long a helper route waits for SQLite's write lock before it answers 503. */
const REMOTE_BUSY_MS = 2_000;

async function serve(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`dash serve: ${e.message}`);
    process.exit(2);
  }
  const db = connect(config.dbPath);
  scopeToTracked(db);
  sweepRunningCards(db);
  // The helper routes' own connection: they wait at most REMOTE_BUSY_MS for a write lock and then answer 503.
  const remoteDb = connect(config.dbPath, { busyTimeoutMs: REMOTE_BUSY_MS });
  const { url, close } = await startServer({ config, db, remoteDb });
  console.log(`dashboard listening on ${url}${config.devAuth ? " (development sign-in)" : ""}`);
  const stop = () => void close().then(() => {
    remoteDb.close();
    db.close();
    process.exit(0);
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export const dashCommands: Record<string, (args: string[]) => Promise<void> | void> = { serve };

export const commands = {
  dash: {
    summary: "dashboard: serve",
    run: async (args: string[]) => {
      const f = args[0] ? dashCommands[args[0]] : undefined;
      if (!f) {
        console.error(`usage: autocraft dash ${Object.keys(dashCommands).join("|")}`);
        process.exit(1);
      }
      await f(args.slice(1));
    },
  },
};
