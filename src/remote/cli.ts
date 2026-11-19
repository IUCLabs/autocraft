// `autocraft inference [server|user-local]`: shows or sets the inference mode (src/remote/mode.ts).
import { connect } from "../db.ts";
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
};
