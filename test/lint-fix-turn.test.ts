// The reply-lint fix turn is one tool-less turn that returns only the flagged fields, merged into the first reply;
// problems only in internal text skip it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { askClaude, setRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import type { Lint } from "../src/replylint.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "lint-fix-"));
process.env.AUTOCRAFT_CLAUDE_BIN = "/usr/bin/true";

describe("reply lint fix turn", () => {
  const db = connect(join(dir, "t.db"));
  const box = useTestAccount(db);
  mkdirSync(box.configDir + "t", { recursive: true });
  writeFileSync(join(box.configDir + "t", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 6 * 3600_000 } }));
  const first = JSON.stringify({ verdict: "take", summary: "too long", why: "fine.", public: { summary: "ok", points: ["a leaky point", "second"] } });
  const result = (text: string) => JSON.stringify({ type: "result", result: text, session_id: "s1", num_turns: 1, usage: {} });

  const run = async (lint: Lint, fixReply: string) => {
    const calls: string[][] = [];
    const messages: string[] = [];
    const restore = setRunner(async (_cmd, args, stdin) => {
      calls.push(args);
      messages.push(stdin);
      return { code: 0, stdout: result(calls.length === 1 ? first : fixReply), stderr: "" };
    });
    try {
      const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout: dir, lint });
      return { r: r!, calls, messages };
    } finally { restore(); }
  };

  test("the fix turn has no tool permission and one turn, asks for the flagged field only and merges it", async () => {
    const lint: Lint = (text, stage) => (stage === "first" ? [{ field: "public.points[0]", message: "mentions the reference folder", text: "a leaky point" }] : JSON.parse(text).public.points[0] === "clean point" ? [] : null);
    const { r, calls, messages } = await run(lint, '{"public.points[0]": "clean point"}');
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.includes("--resume"));
    assert.ok(!calls[1]!.includes("--allowedTools"), "no tool is allowed");
    assert.equal(calls[1]![calls[1]!.indexOf("--max-turns") + 1], "1");
    assert.ok(calls[0]!.includes("--allowedTools"));
    assert.match(messages[1]!, /public\.points\[0\]/);
    assert.ok(!messages[1]!.includes("verdict"), "only the flagged field is named");
    const merged = JSON.parse(r.text);
    assert.deepEqual(merged.public.points, ["clean point", "second"]);
    assert.equal(merged.summary, "too long", "the rest stays as the first turn wrote it");
    assert.equal(r.fixTurn, true);
    assert.deepEqual(r.problems, []);
  });

  test("a fix reply that is not the flagged fields leaves the first reply in place", async () => {
    const lint: Lint = (_t, stage) => (stage === "first" ? [{ field: "public.points[0]", message: "m", text: "a leaky point" }] : []);
    const { r } = await run(lint, "Sorry, here is a long prose answer.");
    assert.equal(r.text, first);
    assert.equal(r.problems?.length, 1);
  });

  test("problems only in internal text skip the fix turn", async () => {
    const lint: Lint = () => [{ field: "reason", message: "m", internal: true }];
    const { r, calls } = await run(lint, "{}");
    assert.equal(calls.length, 1);
    assert.equal(r.text, first);
    assert.equal(r.problems?.length, 1);
    assert.equal(r.fixTurn, undefined);
  });
});
