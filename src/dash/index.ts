import { connect } from "../db.ts";
import { scopeToTracked } from "../repos.ts";
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
  scopeToTracked(db);
  const { url, close } = await startServer({ config, db });
  console.log(`dashboard listening on ${url}${config.devAuth ? " (development sign-in)" : ""}`);
  const stop = () => void close().then(() => {
    db.close();
    process.exit(0);
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function scoped() {
  const db = connect();
  scopeToTracked(db);
  return db;
}

async function exportCmd(args: string[]): Promise<void> {
  if (!args[0]) {
    console.error("usage: craft-auto dash export <dir>");
    process.exit(1);
  }
  const { exportSite } = await import("./pages/export.ts");
  const { pages } = await exportSite(scoped(), args[0]);
  console.log(`wrote ${pages} pages to ${args[0]}`);
}

export const dashCommands: Record<string, (args: string[]) => Promise<void> | void> = { serve, export: exportCmd };

export const commands = {
  dash: {
    summary: "dashboard: serve | export <dir>",
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
