#!/usr/bin/env node
// The Task Runner's earlier path, kept for one release: service units and scripts that still start
// `worker/autocraft-task.mjs` run `worker/autocraft.mjs`, which moves them over (`autocraft migrate`).
import { main } from "./autocraft.mjs";
main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
