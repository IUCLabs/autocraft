// `autocraft inference [server|user-local]`: shows or sets the inference mode (src/remote/mode.ts). `autocraft remote cooloff clear`: ends a helper's lease cool-off (src/remote/cooloff.ts).
import { connect } from "../db.ts";
import { clearCooloff } from "./cooloff.ts";
import { inferenceMode, isInferenceMode, setInferenceMode } from "./mode.ts";

export const commands = {
  inference: {
    summary: "show or set the inference mode: server (accounts on this host) or user-local (maintainers' helpers)",
    run(args: string[]): void {
      const db = connect();
      const want = args[0];
      if (want === undefined) {
        console.log(`inference: ${inferenceMode(db)}`);
        return;
      }
      if (!isInferenceMode(want) || args.length > 1) {
        console.error("usage: autocraft inference [server|user-local]");
        process.exit(1);
      }
      console.log(setInferenceMode(db, want, "cli") ? `inference: ${want}` : `inference was already ${want}`);
    },
  },
  remote: {
    summary: "remote cooloff clear <token-id|login>: lets a helper claim calls again after its lease cool-off",
    run(args: string[]): void {
      if (args[0] !== "cooloff" || args[1] !== "clear" || !args[2] || args.length > 3) {
        console.error("usage: autocraft remote cooloff clear <token-id|login>");
        process.exit(1);
      }
      const n = clearCooloff(connect(), args[2], "cli");
      console.log(n ? `cleared the cool-off of ${n} token${n === 1 ? "" : "s"}` : `no token of ${args[2]} is cooling off`);
    },
  },
};
