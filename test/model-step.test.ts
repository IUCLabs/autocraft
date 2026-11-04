import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runModelStep } from "../src/agents/step.ts";
import { COMPARE_ISSUES, DUPES_HAIKU } from "../src/agents/steps.ts";
import { connect } from "../src/db.ts";
import type { DupePair } from "../src/dupes/pair.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = () => connect(join(mkdtempSync(join(SCRATCH, "step-")), "t.db"));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null };
const pair = (n: number) => ({ ref: `r#${n}~${n + 1}` }) as DupePair;

test("a batch step asks again only for the pairs without a valid answer, and saves one usage row", async () => {
  const d = db();
  const asked: string[][] = [];
  const replies = [`[{"ref":"r#1~2","verdict":"duplicate","reason":"x"}]`, `[{"ref":"r#2~3","verdict":"distinct","reason":"y"}]`];
  const r = await runModelStep(d, DUPES_HAIKU, [pair(1), pair(2)], {
    usage: { run: "t", agent: "a", stage: "dupes" },
    ask: async (ps) => { asked.push(ps.map((p) => p.ref)); return { text: replies.shift()!, usage }; },
  });
  assert.ok(r.ok);
  assert.deepEqual(asked, [["r#1~2", "r#2~3"], ["r#2~3"]]);
  assert.equal(r.rest, undefined);
  const row = d.prepare("SELECT items, input_tokens FROM token_usage WHERE run_id = 't'").get() as { items: number; input_tokens: number };
  assert.deepEqual({ ...row }, { items: 2, input_tokens: 2 });
});

test("a step whose replies never parse retries to its attempts and returns the error", async () => {
  const d = db();
  let calls = 0;
  const r = await runModelStep(d, COMPARE_ISSUES, { numbers: [1, 2], input: { ref: "r#1+2", issues: [] } }, { ask: async () => { calls++; return { text: "no json", usage }; } });
  assert.equal(calls, 2);
  assert.equal(r.ok, false);
});
