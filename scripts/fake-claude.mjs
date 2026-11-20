#!/usr/bin/env node
// A stand-in for `claude` in sandbox tests: AUTOCRAFT_RUNNER_CLAUDE_BIN=<this file> autocraft try <bundle>. It reads the
// prompt, tries what the sandbox must allow (listing each --add-dir) and deny (the real home, ~/.ssh), and answers with the
// results as the reply, in claude's stream-json format.
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0 (fake)"); process.exit(0); }
const value = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const probe = (f) => { try { return `allowed: ${String(f()).slice(0, 80)}`; } catch (e) { return `denied (${e.code ?? e.message})`; } };
const stdin = readFileSync(0, "utf8");
const home = userInfo().homedir;
const report = {
  cwd: process.cwd(), home: process.env.HOME, promptChars: stdin.length,
  promptNamesAddDir: value("--add-dir").map((d) => `${d}: ${stdin.includes(d)}`),
  addDirs: value("--add-dir").map((d) => `${d}: ${probe(() => readdirSync(d).join(","))}`),
  realHome: probe(() => readdirSync(home).length), ssh: probe(() => readdirSync(join(home, ".ssh")).length),
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "missing",
};
const model = value("--model")[0] ?? "opus";
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
say({ type: "system", subtype: "init", model: `claude-${model}-fake`, session_id: "00000000-0000-4000-8000-000000000000" });
say({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(report, null, 1), session_id: "00000000-0000-4000-8000-000000000000", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: stdin.length, output_tokens: 1 } });
