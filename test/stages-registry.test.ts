// The stage registry (src/stages/registry.ts) must equal the lists it replaces until
// the consumers read it: runner steps, autopilot lanes and limits, flow shape, prompts,
// swimlane cards and docs/pipeline.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildFlow } from "../src/flow/shape.ts";
import { PROMPTS } from "../src/prompts/index.ts";
import { DEFAULT_PER_DAY, LANES, LIMIT_STEPS, ZERO_ONLY } from "../src/runner/autopilot.ts";
import { STEPS } from "../src/runner/steps.ts";
import { GLOBAL_WAITS, STAGES, defaultPerDay, lanesInOrder, limitSteps, stageById, stageOfStep, stagesInOrder, zeroOnlySteps } from "../src/stages/registry.ts";
import { STEPS as CARDS } from "../web/src/ui/swimlaneDef.ts";

const META = { repo: null, now: "", lastSync: null, run: null, countedAt: null, uncounted: 0, steps: [] };
const flow = buildFlow({}, META);
const PIPELINE = readFileSync(new URL("../docs/pipeline.md", import.meta.url), "utf8");

test("every runner step sits in exactly one stage, with that stage's run number", () => {
  const owned = STAGES.flatMap((s) => s.steps.map((x) => x.name));
  assert.equal(new Set(owned).size, owned.length, "a step is listed twice");
  assert.deepEqual([...owned].sort(), STEPS.map((s) => s.name).sort());
  for (const step of STEPS) assert.equal(stageOfStep(step.name)?.runStage, step.stage, step.name);
});

test("lanes: names and order equal the autopilot's", () => {
  assert.deepEqual(lanesInOrder().map((l) => l.name), [
    "classify", "priority", "rank", "embed", "dupes", "dupes-compare", "decide", "review", "labels", "merge-ask", "merge",
    "act", "fixup", "verify", "verify-collect", "fixissue", "fixissue-collect", "referee", "review-post", "conversation", "ci-approve",
  ]);
  assert.deepEqual(lanesInOrder().map((l) => l.name), LANES.map((l) => l.name));
  const orders = lanesInOrder().map((l) => l.order);
  assert.deepEqual(orders, orders.map((_, i) => i), "lane orders are 0, 1, 2, ...");
});

test("lanes: steps equal the autopilot's", () => {
  for (const lane of lanesInOrder()) assert.deepEqual(lane.steps, LANES.find((l) => l.name === lane.name)?.steps, lane.name);
  for (const lane of STAGES.flatMap((s) => s.lanes)) for (const step of lane.steps) assert.ok(STEPS.some((x) => x.name === step), `${lane.name}: ${step}`);
});

test("limits: derived lists equal the autopilot's", () => {
  // Same members; the registry lists them in stage order, the autopilot in its own display order.
  assert.deepEqual(limitSteps().sort(), [...LIMIT_STEPS].sort());
  assert.deepEqual(defaultPerDay(), DEFAULT_PER_DAY);
  assert.deepEqual(zeroOnlySteps(), ZERO_ONLY);
});

test("stages: ids, order, titles and modes equal the flow nodes", () => {
  assert.deepEqual(stagesInOrder().map((s) => s.id), flow.nodes.map((n) => n.id));
  assert.deepEqual(stagesInOrder().map((s) => s.order), flow.nodes.map((n) => n.stage));
  for (const n of flow.nodes) {
    const s = stageById(n.id);
    assert.equal(s.title, n.title, n.id);
    assert.equal(s.mode, n.mode, n.id);
  }
});

test("states equal the flow branches", () => {
  for (const n of flow.nodes) {
    const got = stageById(n.id).states;
    assert.deepEqual(got.map((s) => s.id), n.branches.map((b) => b.id), n.id);
    n.branches.forEach((b, i) => {
      const s = got[i]!;
      assert.equal(s.label, b.label, `${n.id}.${b.id}`);
      assert.equal(s.waitsOn, b.waitsOn, `${n.id}.${b.id}`);
      assert.equal(s.tone, b.tone, `${n.id}.${b.id}`);
      assert.equal(s.gate ?? false, b.gate, `${n.id}.${b.id}`);
      // decide.open's hint interpolates a count and is built in code.
      if (!(n.id === "decide" && b.id === "open")) assert.equal(s.hint ?? "", b.hint, `${n.id}.${b.id}`);
      const link = b.link === null ? null : b.link.page === "queue" ? "queue" : b.link.params.state === "all" ? "anyState" : b.link.params.kind === "issue" ? "kind-issue" : b.link.params.kind === "pr" ? "kind-pr" : "items";
      assert.equal(s.link === undefined ? "items" : s.link, link, `${n.id}.${b.id}`);
    });
  }
});

test("edges equal the flow edges", () => {
  const key = (e: { from: string; to: string; branch: string | null; label: string }) => `${e.from}>${e.to}|${e.branch}|${e.label}`;
  const got = STAGES.flatMap((s) => s.edges.map((e) => key({ from: s.id, ...e })));
  assert.deepEqual(got.sort(), flow.edges.map(key).sort());
});

test("every prompt is listed in exactly one stage, whose promptStage matches its label", () => {
  const listed = STAGES.flatMap((s) => s.promptIds);
  assert.equal(new Set(listed).size, listed.length, "a prompt is listed twice");
  assert.deepEqual([...listed].sort(), PROMPTS.map((p) => p.id).sort());
  for (const p of PROMPTS) {
    const s = STAGES.find((x) => x.promptIds.includes(p.id))!;
    // A label may extend the stage's with a qualifier: "Classify (referee)", "Duplicates (group)".
    assert.ok(p.stage === s.promptStage || p.stage.startsWith(`${s.promptStage} (`), `${p.id}: "${p.stage}" vs "${s.promptStage}"`);
  }
});

test("swimlane cards are unique and equal swimlaneDef's", () => {
  const got = STAGES.flatMap((s) => s.swimlane);
  assert.equal(new Set(got.map((c) => c.id)).size, got.length, "a card id is used twice");
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  assert.deepEqual([...got].sort(byId), [...CARDS].sort(byId));
});

test("every wait has a kind and a unique name, and equals the Waits table in pipeline.md", () => {
  const all = [...STAGES.flatMap((s) => s.waits), ...GLOBAL_WAITS];
  for (const w of all) assert.ok(w.kind === "external" || w.kind === "backoff", w.name);
  assert.equal(new Set(all.map((w) => w.name)).size, all.length);
  const table = PIPELINE.split("### Waits")[1]!.split("\n\n| Who")[0]!.split("\n").filter((l) => l.startsWith("|")).slice(2);
  const rows = table.map((l) => l.slice(1, -1).split(" | ").map((c) => c.trim()));
  assert.deepEqual(all.map((w) => [w.name, w.why, w.howLong, w.showsAs]).sort(), rows.sort());
});

test("every docSection heading exists in docs/pipeline.md", () => {
  const headings = new Set(PIPELINE.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3)));
  for (const s of STAGES) assert.ok(headings.has(s.docSection), `${s.id}: ## ${s.docSection}`);
});
