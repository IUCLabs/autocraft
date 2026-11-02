import { connect } from "../db.ts";
import { ConfigError, loadConfig } from "./server/config.ts";
import { startServer } from "./server/index.ts";

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
  const { url, close } = await startServer({ config, db });
  console.log(`dashboard listening on ${url}${config.devAuth ? " (development sign-in)" : ""}`);
  const stop = () => void close().then(() => {
    db.close();
    process.exit(0);
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

// `dash <sub>`: further subcommands (export) join this table.
export const dashCommands: Record<string, (args: string[]) => Promise<void> | void> = { serve };

export const commands = {
  dash: {
    summary: "dashboard: serve",
    run: async (args: string[]) => {
      const f = args[0] ? dashCommands[args[0]] : undefined;
      if (!f) {
        console.error(`usage: craft-auto dash ${Object.keys(dashCommands).join("|")}`);
        process.exit(1);
      }
      await f(args.slice(1));
    },
  },
};
