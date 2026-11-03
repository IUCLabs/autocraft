#!/usr/bin/env node
// Each module exports commands: { name: { summary, run(args) } }.
type Command = { summary: string; run: (args: string[]) => Promise<void> | void };
type Module = { commands: Record<string, Command> };

const MODULES = ["./mirror.ts", "./whitelist.ts", "./decisions.ts", "./access.ts", "./repos.ts", "./classify/index.ts", "./labels/index.ts", "./decide/index.ts", "./review/index.ts", "./merge/index.ts", "./merge/single.ts", "./dash/index.ts", "./runner/index.ts", "./worker/index.ts", "./embed/index.ts", "./agents/index.ts", "./build/cli.ts", "./act/index.ts", "./fixup/index.ts", "./verify/index.ts", "./priority/index.ts", "./dupes/index.ts", "./fixissue/index.ts", "./rank/index.ts", "./review/opus.ts", "./merge/batch.ts", "./merge/safe-merge.ts", "./review/post.ts", "./operator-actions.ts", "./dupes/compare.ts", "./sandbox/workspace.ts", "./fasttrack.ts", "./merge/controls.ts", "./conversations/index.ts", "./itemtools/index.ts"];

async function main(): Promise<void> {
  const commands: Record<string, Command> = {};
  for (const path of MODULES) {
    try {
      Object.assign(commands, ((await import(path)) as Module).commands);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  const [name, ...args] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log("usage: autocraft <command> [args]\n");
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(14)} ${c.summary}`);
    process.exit(name ? 1 : 0);
  }
  await cmd.run(args);
}

await main();
