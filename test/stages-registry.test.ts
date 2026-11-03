// Invariants of the stage registry (src/stages/registry.ts) and of the consumers that read it:
// runner steps, autopilot lanes and limits, flow shape, prompts, swimlane cards and docs/pipeline.md.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { buildFlow } from "../src/flow/shape.ts";
import { PROMPTS } from "../src/prompts/index.ts";
import { DEFAULT_PER_DAY, LANES, buildLanes, LIMIT_STEPS, ZERO_ONLY, limitRow } from "../src/runner/autopilot.ts";
import { STEPS } from "../src/runner/steps.ts";
import { GLOBAL_WAITS, STAGES, defaultPerDay, lanesInOrder, limitSteps, stageById, stageOfStep, stagesInOrder, zeroOnlySteps } from "../src/stages/registry.ts";
import { SCRATCH } from "./scratch.ts";
import { EDGES, STEPS as CARDS } from "../web/src/ui/organisms/swimlaneDef.ts";

const META = { repo: null, now: "", lastSync: null, run: null, countedAt: null, uncounted: 0 };
const flow = buildFlow({}, META);

test("every runner step sits in exactly one stage, with that stage's run number", () => {
  const owned = STAGES.flatMap((s) => s.steps.map((x) => x.name));
  assert.equal(new Set(owned).size, owned.length, "a step is listed twice");
  assert.deepEqual([...owned].sort(), STEPS.map((s) => s.name).sort());
  for (const step of STEPS) assert.equal(step.stage, stageOfStep(step.name)?.runStage, step.name);
});

test("lanes: the autopilot's lanes are the registry's, in its order, with its steps", () => {
  assert.deepEqual(lanesInOrder().map((l) => l.name), [
    "classify", "priority", "rank", "embed", "dupes", "dupes-compare", "decide", "review", "labels", "merge-ask", "merge",
    "act", "fixup", "verify", "verify-collect", "fixissue", "fixissue-collect", "referee", "review-post", "conversation", "ci-approve", "cifix", "cifix-rerun",
  ]);
  assert.deepEqual(LANES.map((l) => l.name), lanesInOrder().map((l) => l.name));
  for (const lane of lanesInOrder()) assert.deepEqual(LANES.find((l) => l.name === lane.name)?.steps, lane.steps, lane.name);
  const orders = lanesInOrder().map((l) => l.order);
  assert.deepEqual(orders, orders.map((_, i) => i), "lane orders are 0, 1, 2, ...");
  for (const lane of STAGES.flatMap((s) => s.lanes)) for (const step of lane.steps) assert.ok(STEPS.some((x) => x.name === step), `${lane.name}: ${step}`);
});

test("lanes: a registry lane without a detect, or a detect without a registry lane, is refused", () => {
  const code = LANES.map(({ steps: _steps, ...rest }) => rest);
  assert.throws(() => buildLanes(code.slice(1)), /no detect for \[classify\]/);
  assert.throws(() => buildLanes([...code, { name: "nope", detect: () => [] }]), /no registry lane for \[nope\]/);
});

test("limits: the autopilot's lists are derived from the registry", () => {
  assert.deepEqual(LIMIT_STEPS, limitSteps());
  assert.deepEqual(DEFAULT_PER_DAY, defaultPerDay());
  assert.deepEqual(ZERO_ONLY, zeroOnlySteps());
  for (const step of LIMIT_STEPS) assert.ok(STEPS.some((x) => x.name === step), step);
  assert.deepEqual(ZERO_ONLY, ["checks"]);
  assert.equal(DEFAULT_PER_DAY["ci-approve"], 30);
  assert.equal(DEFAULT_PER_DAY["cifix-rerun"], 30);
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

test("swimlane cards are the registry's, unique, and every edge joins two cards", () => {
  const got = STAGES.flatMap((s) => s.swimlane);
  assert.equal(new Set(got.map((c) => c.id)).size, got.length, "a card id is used twice");
  assert.equal(CARDS.length, got.length);
  const ids = new Set(CARDS.map((c) => c.id));
  for (const e of EDGES) {
    assert.ok(ids.has(e.from), `edge from ${e.from}`);
    assert.ok(ids.has(e.to), `edge to ${e.to}`);
  }
});

test("every wait has a kind and a unique name", () => {
  const all = [...STAGES.flatMap((s) => s.waits), ...GLOBAL_WAITS];
  for (const w of all) assert.ok(w.kind === "external" || w.kind === "backoff", w.name);
  assert.equal(new Set(all.map((w) => w.name)).size, all.length);
});

test("snapshot: the run stage of every step", () => {
  const got = Object.fromEntries(STAGES.flatMap((s) => s.steps.map((x) => [x.name, s.runStage])));
  assert.deepEqual(got, {
    embed: 1, dupes: 3, "dupes-compare": 3, "classify-new": 2, "classify-all": 2, referee: 2, "areas-propose": 2, "areas-suggest": 2, "areas-rescan": 2,
    prioritize: 2, rank: 2, decide: 3, conversation: 3, "labels-ensure": 4, "labels-apply": 4, "opus-review": 5, checks: 5, "review-post": 5,
    fixissue: 7, "fixissue-collect": 7, fixup: 6, verify: 6, "verify-collect": 6, merge: 6, "merge-ask": 6, "ci-approve": 6, act: 6, cifix: 6, "cifix-rerun": 6,
  });
});

test("snapshot: the steps with a limit setting and the fallback limits", () => {
  assert.deepEqual([...LIMIT_STEPS].sort(), [
    "act", "checks", "ci-approve", "cifix", "cifix-rerun", "classify-new", "conversation", "decide", "dupes", "dupes-compare", "embed", "fixissue", "fixup",
    "labels-apply", "merge", "opus-review", "prioritize", "referee", "review-post", "verify",
  ]);
  assert.deepEqual(DEFAULT_PER_DAY, { dupes: 2000, "dupes-compare": 200, referee: 500, conversation: 30, "ci-approve": 30, "cifix-rerun": 30 });
});

test("a new database starts every limit at the registry's value", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "limits-seed-")), "s.db"));
  for (const s of STAGES) for (const x of s.steps) {
    if (x.limit === undefined) continue;
    assert.equal(limitRow(db, x.name).per_day, x.seeded ?? (typeof x.limit === "number" ? x.limit : null), x.name);
  }
});

test("an edge's branch, if any, is a state of the stage it leaves", () => {
  for (const s of STAGES) for (const e of s.edges) if (e.branch !== null) assert.ok(s.states.some((x) => x.id === e.branch), `${s.id}>${e.to}: ${e.branch}`);
});
