#!/usr/bin/env node
// A stand-in for `claude` for the load rig. It reads a `RIG {json}` line from the prompt ({ nonce, delayMs, ledger }), reports
// "start" and "answered" for the nonce to the rig's ledger (so the report can tell finished work from lost work), sleeps
// delayMs and answers in claude's stream-json format. It is a single file: the helper bind-mounts it into its sandbox.
// The rig copies it with ALWAYS_FAIL flipped for the helper whose harness must always fail.
import { readFileSync } from "node:fs";

const ALWAYS_FAIL = false;
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (rig fake)"); process.exit(0); }
const value = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const stdin = readFileSync(0, "utf8");
const marker = /^RIG (\{.*\})$/m.exec(stdin);
const rig = marker ? JSON.parse(marker[1]) : { nonce: "none", delayMs: 100, ledger: null };
const model = value("--model")[0] ?? "opus";
const session = value("--resume")[0] ?? `00000000-0000-4000-8000-${String(rig.nonce).replace(/\W/g, "").padStart(12, "0").slice(-12)}`;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = async (ev) => {
  if (!rig.ledger) return;
  try { await fetch(`${rig.ledger}/ledger`, { method: "POST", body: JSON.stringify({ nonce: rig.nonce, ev, pid: process.pid, at: Date.now() }), signal: AbortSignal.timeout(3000) }); } catch { /* the ledger is best effort */ }
};

await note("start");
say({ type: "system", subtype: "init", model: `claude-${model}-fake`, session_id: session });
await new Promise((r) => setTimeout(r, Math.max(0, rig.delayMs ?? 0)));
if (ALWAYS_FAIL || rig.fail) {
  await note("failed");
  say({ type: "result", subtype: "error_during_execution", is_error: true, result: "rig: the harness fails", session_id: session, num_turns: 0, total_cost_usd: 0 });
  process.exit(1);
}
await note("answered");
say({ type: "result", subtype: "success", is_error: false, result: `RIG-OK ${rig.nonce}`, session_id: session, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: stdin.length, output_tokens: 5 } });
