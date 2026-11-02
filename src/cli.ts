#!/usr/bin/env node
// Each module exports commands: { name: { summary, run(args) } }.
type Command = { summary: string; run: (args: string[]) => Promise<void> | void };
type Module = { commands: Record<string, Command> };

const MODULES = ["./mirror.ts", "./whitelist.ts", "./decisions.ts", "./access.ts", "./repos.ts", "./classify/index.ts", "./review/index.ts", "./dash/index.ts"];

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
    console.log("usage: craft-auto <command> [args]\n");
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(14)} ${c.summary}`);
    process.exit(name ? 1 : 0);
  }
  await cmd.run(args);
}

await main();
